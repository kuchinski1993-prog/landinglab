import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { defineCatalog } from '../index.js';
import { assertCatalogDocumented, checkCatalogDocumented } from '../testing.js';

const CAT = defineCatalog('doc', {
  'doc.a': { status: 400, message: 'Mensagem A.' },
  'doc.b': { status: 404, message: 'Mensagem B.' },
});

function docFile(text: string): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'errors-doc-')), 'erros.md');
  writeFileSync(file, text);
  return file;
}

const HEADER = '| code | HTTP | mensagem |\n|---|---|---|\n';

describe('assertCatalogDocumented', () => {
  it('caso feliz (aceita colunas extras e CRLF)', () => {
    const file = docFile(`# Doc\r\n${HEADER}| \`doc.a\` | 400 | Mensagem A. |\r\n| \`doc.b\` | 404 | Mensagem B. | onde aparece |\r\n`);
    expect(() => assertCatalogDocumented(CAT, file)).not.toThrow();
  });

  it('código sem linha na doc → falha listando o código', () => {
    const file = docFile(`${HEADER}| \`doc.a\` | 400 | Mensagem A. |\n`);
    expect(() => assertCatalogDocumented(CAT, file)).toThrow(/sem linha .* doc\.b/);
  });

  it('linha na doc sem código no catálogo → falha listando a linha', () => {
    const file = docFile(`${HEADER}| \`doc.a\` | 400 | Mensagem A. |\n| \`doc.b\` | 404 | Mensagem B. |\n| \`doc.c\` | 409 | Sobrou. |\n`);
    expect(() => assertCatalogDocumented(CAT, file)).toThrow(/linhas da doc sem código no catálogo: doc\.c/);
  });

  it('texto ou status diferente → falha como ausente', () => {
    expect(checkCatalogDocumented(CAT, `${HEADER}| \`doc.a\` | 400 | Outra. |\n| \`doc.b\` | 400 | Mensagem B. |\n`)).toEqual({
      missing: ['doc.a', 'doc.b'],
      extra: [],
    });
  });

  it('exceptions e ignore pulam linhas no sentido doc → catálogo; aceita lista de catálogos', () => {
    const text = `${HEADER}| \`doc.a\` | 400 | Mensagem A. |\n| \`doc.b\` | 404 | Mensagem B. |\n| \`outro\` | 400 | X. |\n| \`mod.x\` | 400 | Y. |\n| \`mod.x\` | 400 | Y. |\n`;
    expect(checkCatalogDocumented([CAT], text, { exceptions: ['outro'], ignore: /^mod\./ })).toEqual({ missing: [], extra: [] });
    expect(checkCatalogDocumented([CAT], text)).toEqual({ missing: [], extra: ['outro', 'mod.x'] });
  });
});
