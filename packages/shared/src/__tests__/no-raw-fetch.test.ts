// Story 18.2 · AC16 — guarda contra `fetch(` cru.
//  1. Arquivos migrados para o cliente de @blackshop/shared/http não podem voltar a ter `fetch(` cru.
//  2. O inventário docs/architecture/chamadas-externas.md bate com o código (todo `fetch(` cru de
//     produção está classificado, com a quantidade certa; nenhuma linha sobrando).
//  3. Zonas protegidas são exceções explícitas (listadas aqui e no doc como "protegido").
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { countRawFetch, scanRawFetch } from './helpers/raw-fetch-scan.js';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const DOC = path.join(ROOT, 'docs/architecture/chamadas-externas.md');

/** Migrados na 18.2 (transporte pelo cliente compartilhado). */
export const MIGRATED = [
  'packages/shared/src/http/client.ts',
  'packages/shared/src/http/fetch-with-timeout.ts',
  'packages/shopify-adapter/src/real.adapter.ts',
  'packages/shopify-storefront/src/real.client.ts',
  'apps/api/src/lib/shopify-admin-client.ts',
  'packages/vault/src/vault.ts',
  'apps/worker/src/processors/orders-backfill.processor.ts',
  'packages/importer/src/layers/shopify.layer.ts',
  'packages/importer/src/importer.ts',
  'packages/landinglab-domains/src/vercel.ts',
  'apps/worker/src/lib/frankfurter.ts',
  // Story 18.6a · limpeza do Supabase Storage na exclusão definitiva de produto.
  'apps/api/src/routes/products.routes.ts',
] as const;

/** Zonas protegidas (CLAUDE.md raiz): nunca migradas por esta story; `fetch(` cru tolerado. */
export const PROTECTED = [
  'packages/email/',
  'apps/api/src/routes/inbound-email.routes.ts',
  'packages/tracking/src/capi.client.ts',
  'apps/worker/src/processors/tracker-capi.processor.ts',
  'apps/worker/src/processors/send-email.processor.ts',
  'apps/worker/src/processors/analyze-inbound.processor.ts',
  'apps/api/src/routes/tracker/',
  'packages/tracker-engine/',
  'packages/trustshield/',
] as const;

const isProtected = (file: string): boolean => PROTECTED.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));

interface InventoryRow {
  count: number;
  status: string;
}

function readInventory(): Map<string, InventoryRow> {
  const rows = new Map<string, InventoryRow>();
  for (const line of readFileSync(DOC, 'utf8').split('\n')) {
    const m = /^\| `([^`]+)` \| (\d+) \| [^|]+ \| ([^|]+) \|$/.exec(line.trim());
    if (m) rows.set(m[1]!, { count: Number(m[2]), status: m[3]!.trim() });
  }
  return rows;
}

/** Arquivos migrados que voltaram a ter `fetch(` cru. */
function violations(scan: Map<string, number>, migrated: readonly string[]): string[] {
  return migrated.filter((file) => (scan.get(file) ?? 0) > 0);
}

const DOC_REL = 'docs/architecture/chamadas-externas.md';
const HOW_TO =
  `use createHttpClient de @blackshop/shared/http (ou safeFetch para URL do usuário) ou classifique a chamada ` +
  `na tabela "Inventário de fetch( cru" de ${DOC_REL} (linha "| \`arquivo\` | N | destino | status |")`;

/** Mensagens acionáveis para cada divergência entre o código e o inventário do doc. */
function inventoryProblems(scan: Map<string, number>, inventory: Map<string, InventoryRow>): string[] {
  const problems: string[] = [];
  for (const [file, count] of scan) {
    const row = inventory.get(file);
    if (!row) problems.push(`novo fetch( cru em ${file} (${count}x): ${HOW_TO}`);
    else if (row.count !== count)
      problems.push(`${file}: o código tem ${count} fetch( cru, o inventário diz ${row.count} — atualize a coluna em ${DOC_REL} ou migre para createHttpClient`);
  }
  for (const file of inventory.keys()) {
    if (!scan.has(file)) problems.push(`${file} não tem mais fetch( cru: remova a linha da tabela de inventário em ${DOC_REL} (se migrou, liste em "Clientes já no padrão")`);
  }
  return problems;
}

describe('no-raw-fetch — guarda da 18.2', () => {
  const scan = scanRawFetch(ROOT);

  it('arquivos migrados não têm fetch( cru', () => {
    const problems = violations(scan, MIGRATED).map(
      (file) => `fetch( cru voltou em ${file}, que já foi migrado (18.2): use o cliente createHttpClient de @blackshop/shared/http`,
    );
    expect(problems).toEqual([]);
  });

  it('o inventário do doc bate com o código (arquivo e quantidade)', () => {
    const inventory = readInventory();
    const fromDoc = Object.fromEntries([...inventory].map(([file, row]) => [file, row.count]));
    expect(scan.size).toBeGreaterThan(50); // a varredura achou o repositório (não é {} = {})
    expect(inventoryProblems(scan, inventory)).toEqual([]);
    expect(Object.fromEntries(scan)).toEqual(fromDoc);
  });

  it('migrados não aparecem no inventário de fetch( cru; protegidos aparecem como "protegido"', () => {
    const inventory = readInventory();
    for (const file of MIGRATED) expect(inventory.has(file), `${file} já foi migrado: remova-o da tabela de inventário em ${DOC_REL}`).toBe(false);
    for (const [file, row] of inventory) {
      if (isProtected(file)) expect(row.status, `${file} é zona protegida: status deve começar com "protegido" em ${DOC_REL}`).toMatch(/^protegido/);
      else expect(row.status, `${file} não é zona protegida: use interno / pendente → story / fora em ${DOC_REL}`).not.toMatch(/^protegido/);
    }
  });

  it('teste negativo: fetch( cru num arquivo migrado (temporário) é detectado', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'no-raw-fetch-'));
    try {
      const rel = 'packages/exemplo/src/cliente.ts';
      mkdirSync(path.join(tmp, 'packages/exemplo/src'), { recursive: true });
      writeFileSync(
        path.join(tmp, rel),
        [
          "// fetch('comentário não conta')",
          "import { createHttpClient } from '@blackshop/shared/http';",
          'const ok = await http.fetchWithTimeout(url);',
          'const ruim = await fetch(url, { method: "POST" });',
        ].join('\n'),
      );
      const tmpScan = scanRawFetch(tmp, ['packages']);
      expect(tmpScan.get(rel)).toBe(1);
      expect(violations(tmpScan, [rel])).toEqual([rel]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('mensagens de falha dizem como atualizar o inventário', () => {
    const problems = inventoryProblems(
      new Map([
        ['packages/x/src/novo.ts', 1],
        ['packages/x/src/mudou.ts', 3],
      ]),
      new Map([
        ['packages/x/src/mudou.ts', { count: 1, status: 'interno' }],
        ['packages/x/src/sumiu.ts', { count: 1, status: 'interno' }],
      ]),
    );
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/novo fetch\( cru em packages\/x\/src\/novo\.ts.*createHttpClient.*chamadas-externas\.md/);
    expect(problems[1]).toMatch(/mudou\.ts: o código tem 3 fetch\( cru, o inventário diz 1/);
    expect(problems[2]).toMatch(/sumiu\.ts não tem mais fetch\( cru: remova a linha/);
  });

  it('contagem ignora comentários, fetchWithTimeout(, fetchImpl( e x.fetch(', () => {
    expect(countRawFetch(['// fetch(x)', ' * fetch(y)', 'fetchWithTimeout(a)', 'fetchImpl(b)', 'globalThis.fetch(c)'].join('\n'))).toBe(0);
    expect(countRawFetch('const r = await fetch(u);\nreturn fetch(v)')).toBe(2);
  });
});
