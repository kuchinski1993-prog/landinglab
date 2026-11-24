// Story 23.1b · varredura de literais `'default'`/`"default"`/`` `default` `` no código de produção
// (sem testes) — base das guardas `no-hardcoded-default-store.test.ts` da API e do worker.
// Só para testes (usa node:fs); exportado em `@blackshop/shared/testing/default-store-scan`.
// Tokenizador mínimo: ignora comentários e só conta literais de string cujo conteúdo é EXATAMENTE
// `default` (texto como "sem o 'default' fixo" não conta). Regex literal é pulado por heurística.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export interface DefaultLiteral {
  /** Caminho relativo à raiz varrida, com `/`. */
  file: string;
  line: number;
  /** Linha inteira, aparada (o que a allowlist casa por `match`). */
  text: string;
}

export interface DefaultAllowEntry {
  file: string;
  /** Trecho da linha (aparada) que identifica o uso. */
  match: string;
  /** Quantas linhas do arquivo casam (pega cópia nova do mesmo trecho). */
  count: number;
  /** Classe do inventário da 23.1a (B, B′, C) e o porquê. */
  reason: string;
  /** Entrada temporária: a story/PR que a remove. */
  pending?: string;
}

const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/** Literais `default` (conteúdo exato) de um fonte TS/JS, fora de comentários. */
export function findDefaultLiterals(source: string): Array<{ line: number }> {
  const out: Array<{ line: number }> = [];
  let i = 0;
  let line = 1;
  let prevSignificant = '';
  let prevWord = '';
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const startLine = line;
      const quote = ch;
      let content = '';
      let interpolated = false;
      i += 1;
      while (i < n && source[i] !== quote) {
        const c = source[i]!;
        if (c === '\\') {
          content += c + (source[i + 1] ?? '');
          if (source[i + 1] === '\n') line += 1;
          i += 2;
          continue;
        }
        if (quote === '`' && c === '$' && source[i + 1] === '{') {
          interpolated = true;
          let depth = 0;
          while (i < n) {
            if (source[i] === '{') depth += 1;
            else if (source[i] === '}') {
              depth -= 1;
              if (depth === 0) break;
            } else if (source[i] === '\n') line += 1;
            i += 1;
          }
          i += 1;
          continue;
        }
        if (c === '\n') line += 1;
        content += c;
        i += 1;
      }
      i += 1;
      if (!interpolated && content === 'default') out.push({ line: startLine });
      prevSignificant = quote;
      prevWord = '';
      continue;
    }
    if (ch === '/' && (prevSignificant === '' || REGEX_PREV.has(prevSignificant) || prevWord === 'return' || prevWord === 'typeof')) {
      // Regex literal: pula até a barra final fora de classe [...].
      i += 1;
      let inClass = false;
      while (i < n && source[i] !== '\n') {
        const c = source[i]!;
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        i += 1;
      }
      i += 1;
      prevSignificant = '/';
      prevWord = '';
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let word = '';
      while (i < n && /[A-Za-z0-9_$]/.test(source[i]!)) {
        word += source[i];
        i += 1;
      }
      prevWord = word;
      prevSignificant = 'w';
      continue;
    }
    prevSignificant = ch;
    prevWord = '';
    i += 1;
  }
  return out;
}

function isTestPath(rel: string): boolean {
  return rel.split('/').some((part) => part === '__tests__' || part === '__fixtures__' || part === '__helpers__') || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
}

/** Varre `root` (recursivo) e devolve cada literal `default` com arquivo, linha e texto. */
export function scanDefaultLiterals(root: string): DefaultLiteral[] {
  const found: DefaultLiteral[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.[cm]?[jt]sx?$/.test(name) || name.endsWith('.d.ts')) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (isTestPath(rel)) continue;
      const source = readFileSync(full, 'utf8');
      const lines = source.split('\n');
      for (const hit of findDefaultLiterals(source)) {
        found.push({ file: rel, line: hit.line, text: (lines[hit.line - 1] ?? '').trim() });
      }
    }
  };
  walk(root);
  return found.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/** Literais sem entrada na allowlist, contagens divergentes e entradas que não casam mais. */
export function defaultStoreViolations(found: readonly DefaultLiteral[], allowlist: readonly DefaultAllowEntry[]): string[] {
  const problems: string[] = [];
  const counts = new Map<DefaultAllowEntry, number>();
  for (const hit of found) {
    const entry = allowlist.find((e) => e.file === hit.file && hit.text.includes(e.match));
    if (!entry) {
      problems.push(
        `${hit.file}:${hit.line} \`${hit.text}\` — 'default' fixo como loja: use a loja do request/payload/landing ` +
          `(ou DEFAULT_STORE_ID importado) ou classifique na allowlist com o motivo (docs/architecture/isolamento-de-loja.md)`,
      );
      continue;
    }
    counts.set(entry, (counts.get(entry) ?? 0) + 1);
  }
  for (const entry of allowlist) {
    const got = counts.get(entry) ?? 0;
    if (got === 0) problems.push(`allowlist obsoleta: ${entry.file} "${entry.match}" não casa mais com nenhuma linha`);
    else if (got !== entry.count) problems.push(`${entry.file} "${entry.match}": ${got} ocorrência(s), a allowlist diz ${entry.count}`);
  }
  return problems;
}
