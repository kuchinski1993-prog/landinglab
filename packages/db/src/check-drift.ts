// Check estático de drift schema.ts × migrations.
//
// Roda sem banco: parseia CREATE TABLE / ALTER TABLE ADD COLUMN em todas as
// migrations e compara com as colunas declaradas em schema.ts. Falha (exit 1)
// se detectar tabela ou coluna declarada no schema sem migration
// correspondente — para o CI pegar antes do bug chegar em produção.
//
// Bug pai que motivou este check: 0036_missing_columns.sql — 13 colunas
// (products, product_variants, product_images, product_reviews) foram
// adicionadas ao schema.ts sem `pnpm db:generate`, e nada detectava.
// GET /products devolvia 500 em prod, importer gravava zero.
//
// Uso:
//   pnpm --filter @blackshop/db db:check
//   → exit 0 se sem drift; exit 1 e lista o drift caso contrário.
//
// Limitações conhecidas:
//   - Não valida tipos exatos (só presença) — Drizzle e postgres formatam
//     `numeric(3,2)` de forma diferente e o parsing correto é caro.
//   - Não valida índices/constraints — só colunas.
//   - Ignora tabelas do schema `drizzle` (metadata do migrator).
// Essas limitações são intencionais: o objetivo é pegar drift ESTRUTURAL
// (coluna existe ou não), que é 90% dos bugs.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(HERE, 'schema.ts');
// Story 0.12 · os testes apontam para uma CÓPIA da pasta (tmpdir) — nunca editam os arquivos reais.
const MIGRATIONS_DIR = process.env['CHECK_DRIFT_MIGRATIONS_DIR'] ?? resolve(HERE, '..', 'migrations');
const JOURNAL_PATH = resolve(MIGRATIONS_DIR, 'meta', '_journal.json');
// Story 0.12 · lista CONGELADA (append-only) das migrations aplicadas fora do `db:migrate` (não estão
// no journal e NÃO devem entrar nele sem prova: o migrator do Drizzle as reaplicaria).
const APPLIED_OUTSIDE_PATH = resolve(MIGRATIONS_DIR, 'meta', 'applied-outside-journal.json');
const ROLLBACK_SUFFIX = '.rollback.sql';

// Guard adicionado 2026-07-10: pega migration órfã do _journal.json
// (bug que motivou: 0040_color_schemes.sql existia em migrations/ mas
// não estava no journal, então drizzle migrate() nunca aplicava).
interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

interface AppliedOutsideEntry {
  tag: string;
  appliedBy: string;
  note: string;
}

interface JournalCheck {
  orphanFiles: string[];
  orphanEntries: string[];
  outsideWithoutFile: string[];
  outsideAlsoInJournal: string[];
}

function readAppliedOutside(): AppliedOutsideEntry[] {
  if (!existsSync(APPLIED_OUTSIDE_PATH)) return [];
  const raw = JSON.parse(readFileSync(APPLIED_OUTSIDE_PATH, 'utf8')) as { entries?: AppliedOutsideEntry[] };
  return raw.entries ?? [];
}

function checkJournal(): JournalCheck {
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf8')) as Journal;
  // `*.rollback.sql` NÃO é migration para frente: jamais entra no journal (o Drizzle a aplicaria).
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith(ROLLBACK_SUFFIX))
    .map((f) => f.replace(/\.sql$/, ''))
    .sort();

  const tagsInJournal = new Set(journal.entries.map((e) => e.tag));
  const outsideTags = readAppliedOutside().map((e) => e.tag);
  const tagsOutside = new Set(outsideTags);
  const filesSet = new Set(files);

  // Arquivo .sql nem no journal nem na lista congelada → ninguém sabe como chega ao banco.
  const orphanFiles = files.filter((f) => !tagsInJournal.has(f) && !tagsOutside.has(f));
  // Entrada no journal sem arquivo .sql → migrator falha ao rodar.
  const orphanEntries = journal.entries
    .map((e) => e.tag)
    .filter((t) => !filesSet.has(t));
  // Entrada da lista sem arquivo, ou registrada nos dois lugares (duplicata).
  const outsideWithoutFile = outsideTags.filter((t) => !filesSet.has(t));
  const outsideAlsoInJournal = outsideTags.filter((t) => tagsInJournal.has(t));

  return { orphanFiles, orphanEntries, outsideWithoutFile, outsideAlsoInJournal };
}

// Tipos de coluna reconhecidos no schema.ts (drizzle-orm/pg-core).
const DRIZZLE_COL_TYPES = [
  'text', 'uuid', 'integer', 'boolean', 'numeric', 'timestamp',
  'jsonb', 'bigint', 'serial', 'varchar', 'smallint', 'bytea',
  'real', 'doublePrecision', 'date', 'time',
];

interface Drift {
  missingTables: string[];
  missingColumns: Record<string, string[]>;
  extraColumns: Record<string, string[]>;
}

function parseSchema(): Map<string, Set<string>> {
  const src = readFileSync(SCHEMA_PATH, 'utf8');
  const tables = new Map<string, Set<string>>();

  const pgTableRegex = /pgTable\(\s*'([a-z_]+)'\s*,\s*\{/g;
  const colTypeRegex = new RegExp(
    `(?:${DRIZZLE_COL_TYPES.join('|')})\\(\\s*'([a-z_0-9]+)'`,
    'g',
  );

  let m: RegExpExecArray | null;
  while ((m = pgTableRegex.exec(src)) !== null) {
    const tableName = m[1]!;
    // Anda pelo corpo balanceando {}.
    let i = pgTableRegex.lastIndex;
    let depth = 1;
    const start = i;
    while (i < src.length && depth > 0) {
      const ch = src[i]!;
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const body = src.slice(start, i - 1);
    const cols = new Set<string>();
    let cm: RegExpExecArray | null;
    while ((cm = colTypeRegex.exec(body)) !== null) {
      cols.add(cm[1]!);
    }
    tables.set(tableName, cols);
  }

  return tables;
}

function parseMigrations(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const rawSrc = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
    // Remove comentários SQL (-- linha, /* bloco */) e literais entre aspas
    // simples — evita que "cai em created_at" ou defaults JSON com palavras
    // sejam interpretados como nome de coluna.
    const src = rawSrc
      .replace(/\/\*[\s\S]*?\*\//g, '') // /* bloco */
      .replace(/--[^\n]*/g, '')         // -- linha
      .replace(/'(?:''|[^'])*'/g, "''"); // literais → string vazia (preserva vírgula do contexto)

    // CREATE TABLE [IF NOT EXISTS] "name" ( ... colunas ... )
    // Body vai da primeira `(` correspondente até o `)` que balanceia.
    const createRegex = /create\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-z_]+)"?\s*\(/gi;
    let cm: RegExpExecArray | null;
    while ((cm = createRegex.exec(src)) !== null) {
      const tableName = cm[1]!;
      const startBody = createRegex.lastIndex;
      // Balanceia parênteses até fechar o CREATE TABLE.
      let i = startBody;
      let depth = 1;
      while (i < src.length && depth > 0) {
        const ch = src[i]!;
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        i++;
      }
      const body = src.slice(startBody, i - 1);
      const cols = tables.get(tableName) ?? new Set<string>();
      // Colunas: quebra por vírgula no nível 0 e pega o primeiro token de
      // cada segmento que começa por identificador entre aspas ou snake_case.
      let depth2 = 0;
      let seg = '';
      const segments: string[] = [];
      for (const ch of body) {
        if (ch === '(') depth2++;
        else if (ch === ')') depth2--;
        if (ch === ',' && depth2 === 0) {
          segments.push(seg.trim());
          seg = '';
        } else {
          seg += ch;
        }
      }
      if (seg.trim()) segments.push(seg.trim());

      for (const s of segments) {
        // Ignora CONSTRAINT / PRIMARY KEY (...) / FOREIGN KEY / UNIQUE(...)
        // que não são definições de coluna.
        const trimmed = s.trim();
        if (/^(?:constraint|primary\s+key|foreign\s+key|unique|check)\b/i.test(trimmed)) {
          continue;
        }
        const idMatch = trimmed.match(/^"?([a-z_][a-z_0-9]*)"?/i);
        if (idMatch) {
          const colName = idMatch[1]!.toLowerCase();
          // Reserved SQL keywords que às vezes começam a linha (raro).
          if (colName === 'primary' || colName === 'foreign') continue;
          cols.add(colName);
        }
      }
      tables.set(tableName, cols);
    }

    // ALTER TABLE X ADD COLUMN a, ADD COLUMN b — múltiplas colunas em uma
    // única declaração. Estratégia: encontra "ALTER TABLE <name>" e depois
    // extrai todos os "ADD COLUMN [IF NOT EXISTS] <col>" até o próximo ';'.
    const alterHeaderRegex =
      /alter\s+table\s+(?:if\s+exists\s+)?"?([a-z_]+)"?\s+([^;]*);/gi;
    let ah: RegExpExecArray | null;
    while ((ah = alterHeaderRegex.exec(src)) !== null) {
      const tableName = ah[1]!;
      const body = ah[2]!;
      const cols = tables.get(tableName) ?? new Set<string>();
      const addColRegex =
        /add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z_0-9]*)"?/gi;
      let ac: RegExpExecArray | null;
      while ((ac = addColRegex.exec(body)) !== null) {
        cols.add(ac[1]!);
      }
      tables.set(tableName, cols);
    }
  }

  return tables;
}

function computeDrift(
  schema: Map<string, Set<string>>,
  migrations: Map<string, Set<string>>,
): Drift {
  const missingTables: string[] = [];
  const missingColumns: Record<string, string[]> = {};
  const extraColumns: Record<string, string[]> = {};

  for (const [table, cols] of schema) {
    const migCols = migrations.get(table);
    if (!migCols) {
      missingTables.push(table);
      continue;
    }
    const miss = [...cols].filter((c) => !migCols.has(c)).sort();
    if (miss.length) missingColumns[table] = miss;
    const extra = [...migCols].filter((c) => !cols.has(c)).sort();
    if (extra.length) extraColumns[table] = extra;
  }

  return { missingTables, missingColumns, extraColumns };
}

function main(): void {
  const schema = parseSchema();
  const migrations = parseMigrations();
  const drift = computeDrift(schema, migrations);
  const journalCheck = checkJournal();

  const hasProblems =
    drift.missingTables.length > 0 ||
    Object.keys(drift.missingColumns).length > 0 ||
    journalCheck.orphanFiles.length > 0 ||
    journalCheck.orphanEntries.length > 0 ||
    journalCheck.outsideWithoutFile.length > 0 ||
    journalCheck.outsideAlsoInJournal.length > 0;

  if (drift.missingTables.length > 0) {
    console.error('\n✗ Tabelas em schema.ts sem migration:');
    for (const t of drift.missingTables) console.error(`  - ${t}`);
  }
  if (Object.keys(drift.missingColumns).length > 0) {
    console.error('\n✗ Colunas em schema.ts sem migration:');
    for (const [table, cols] of Object.entries(drift.missingColumns)) {
      console.error(`  ${table}:`);
      for (const c of cols) console.error(`    - ${c}`);
    }
  }
  if (Object.keys(drift.extraColumns).length > 0) {
    // Extras normalmente são drops que não removemos do banco — informativo,
    // não falha.
    console.warn('\n⚠ Colunas em migrations mas não no schema (informativo):');
    for (const [table, cols] of Object.entries(drift.extraColumns)) {
      console.warn(`  ${table}:`);
      for (const c of cols) console.warn(`    + ${c}`);
    }
  }

  if (journalCheck.orphanFiles.length > 0) {
    console.error('\n✗ Migrations em migrations/ sem entrada no _journal.json nem em meta/applied-outside-journal.json');
    console.error('  (drizzle migrate() vai IGNORAR — registre no MESMO PR que cria a migration):');
    for (const f of journalCheck.orphanFiles) console.error(`  - ${f}.sql`);
  }
  if (journalCheck.outsideWithoutFile.length > 0) {
    console.error('\n✗ Entradas em meta/applied-outside-journal.json sem arquivo .sql correspondente:');
    for (const t of journalCheck.outsideWithoutFile) console.error(`  - ${t}`);
  }
  if (journalCheck.outsideAlsoInJournal.length > 0) {
    console.error('\n✗ Tag duplicada: está no _journal.json E em meta/applied-outside-journal.json:');
    for (const t of journalCheck.outsideAlsoInJournal) console.error(`  - ${t}`);
  }
  if (journalCheck.orphanEntries.length > 0) {
    console.error('\n✗ Entradas em _journal.json sem arquivo .sql correspondente');
    console.error('  (drizzle migrate() vai FALHAR ao tentar rodar):');
    for (const t of journalCheck.orphanEntries) console.error(`  - ${t}`);
  }

  if (hasProblems) {
    console.error(
      '\n✗ Drift detectado. Rode `pnpm --filter @blackshop/db db:generate` ou crie migration manual.',
    );
    process.exit(1);
  }

  console.log(
    `✓ Sem drift entre schema.ts e migrations (${schema.size} tabelas verificadas, journal + ${readAppliedOutside().length} aplicadas fora do journal consistentes).`,
  );
}

main();
