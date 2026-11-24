// Teste de documentação: cada código do catálogo tem linha `| \`code\` | status | mensagem |` na
// doc E cada linha de código da doc existe no catálogo (bidirecional).
import { readFileSync } from 'node:fs';

import type { AnyCatalog } from './catalog.js';

export interface AssertCatalogDocumentedOptions {
  /** Códigos que aparecem em linhas de tabela da doc mas não são do(s) catálogo(s) testado(s). */
  exceptions?: readonly string[];
  /** Ignora no sentido doc → catálogo as linhas cujo código casa (ex.: catálogos testados em outro pacote). */
  ignore?: RegExp;
}

const ROW = /^\|\s*`([^`]+)`\s*\|/;

export interface CatalogDocReport {
  /** Código do catálogo sem a linha exata (ausente ou com status/mensagem diferente). */
  missing: string[];
  /** Linha de código na doc sem código correspondente no catálogo. */
  extra: string[];
}

export function checkCatalogDocumented(
  catalogs: AnyCatalog | readonly AnyCatalog[],
  docText: string,
  options: AssertCatalogDocumentedOptions = {}
): CatalogDocReport {
  const list: readonly AnyCatalog[] = Array.isArray(catalogs) ? catalogs : [catalogs as AnyCatalog];
  const lines = docText.split(/\r?\n/).map((line) => line.trim());
  const known = new Set<string>();
  const missing: string[] = [];
  for (const catalog of list) {
    for (const [code, entry] of Object.entries(catalog.entries)) {
      known.add(code);
      const expected = `| \`${code}\` | ${entry.status} | ${entry.message} |`;
      if (!lines.some((line) => line.startsWith(expected))) missing.push(code);
    }
  }
  const exceptions = new Set(options.exceptions ?? []);
  const extra: string[] = [];
  for (const line of lines) {
    const code = ROW.exec(line)?.[1];
    if (!code || known.has(code) || exceptions.has(code) || options.ignore?.test(code)) continue;
    if (!extra.includes(code)) extra.push(code);
  }
  return { missing, extra };
}

export function assertCatalogDocumented(
  catalogs: AnyCatalog | readonly AnyCatalog[],
  docPath: string,
  options: AssertCatalogDocumentedOptions = {}
): void {
  const { missing, extra } = checkCatalogDocumented(catalogs, readFileSync(docPath, 'utf8'), options);
  if (!missing.length && !extra.length) return;
  const parts: string[] = [];
  if (missing.length) parts.push(`códigos sem linha \`| code | status | mensagem |\` na doc: ${missing.join(', ')}`);
  if (extra.length) parts.push(`linhas da doc sem código no catálogo: ${extra.join(', ')}`);
  throw new Error(`[@blackshop/errors] ${docPath} fora de sincronia — ${parts.join('; ')}`);
}
