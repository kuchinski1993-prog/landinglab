// Mantém docs/architecture/erros.md em sincronia com o catálogo comum e o `cambio` (Story 0.7c), nos dois sentidos.
// Linhas `modulo.codigo` são de catálogos de módulo, testados no app dono (apps/api).
import path from 'node:path';

import { describe, it } from 'vitest';

import { CAMBIO_CATALOG, COMMON_CATALOG } from '../index.js';
import { assertCatalogDocumented } from '../testing.js';

const doc = path.resolve(import.meta.dirname, '../../../../docs/architecture/erros.md');

describe('docs/architecture/erros.md — catálogo comum + cambio', () => {
  it('cada código do comum/cambio tem linha exata e não há linha sem código', () => {
    assertCatalogDocumented([COMMON_CATALOG, CAMBIO_CATALOG], doc, { ignore: /^[a-z0-9_]+\.[a-z0-9_.]+$/ });
  });
});
