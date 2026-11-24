// Story 18.2 · AC16 — varredura de `fetch(` cru no código de produção (apps/* e packages/*).
// Ignora testes, node_modules, builds e linhas de comentário. `fetchWithTimeout(`, `fetchImpl(` e
// `x.fetch(` não contam (o regex exige `fetch(` isolado).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const RAW_FETCH = /(^|[^A-Za-z0-9_.$])fetch\(/;

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '__tests__', 'tests', 'e2e', 'public', '.turbo', '.vercel']);
const SOURCE = /\.(ts|tsx|mts)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx)$/;

/** Quantos `fetch(` crus há no texto (uma ocorrência por linha, comentários fora). */
export function countRawFetch(source: string): number {
  let n = 0;
  for (const line of source.split('\n')) {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    if (RAW_FETCH.test(line)) n += 1;
  }
  return n;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, out);
    } else if (SOURCE.test(name) && !TEST_FILE.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
}

/** Mapa `caminho relativo → quantidade` de todo `fetch(` cru em apps/* e packages/*. */
export function scanRawFetch(root: string, tops: readonly string[] = ['apps', 'packages']): Map<string, number> {
  const files: string[] = [];
  for (const top of tops) walk(path.join(root, top), files);
  const result = new Map<string, number>();
  for (const file of files.sort()) {
    const n = countRawFetch(readFileSync(file, 'utf8'));
    if (n > 0) result.set(path.relative(root, file).split(path.sep).join('/'), n);
  }
  return result;
}
