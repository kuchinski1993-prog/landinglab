// Mantém docs/vsl/api-errors.md em sincronia com o catálogo de códigos — nos DOIS sentidos
// (Story 18.11): código sem linha exata na doc OU linha de código na doc sem código no catálogo.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { assertCatalogDocumented, checkCatalogDocumented } from '@blackshop/errors/testing';
import { describe, expect, it } from 'vitest';

import { toVslErrorResponse, vslError, VSL_CATALOG } from '../errors.js';
import { VslError } from '../imports.js';

const doc = path.resolve(import.meta.dirname, '../../../../docs/vsl/api-errors.md');

describe('VSL error catalog', () => {
  it('documents every code with its HTTP status and PT-BR message, and the doc has no orphan code row', () => {
    assertCatalogDocumented(VSL_CATALOG, doc);
  });

  it('a verificação pega os dois sentidos (linha órfã e mensagem divergente)', () => {
    const text = readFileSync(doc, 'utf8');
    expect(checkCatalogDocumented(VSL_CATALOG, `${text}\n| \`codigo_fantasma\` | 400 | x. | y |\n`)).toEqual({ missing: [], extra: ['codigo_fantasma'] });
    const drifted = text.replace('(cubipiccanti.online, landinglab.app', '(pathmetric.online, landinglab.app');
    expect(checkCatalogDocumented(VSL_CATALOG, drifted)).toEqual({ missing: ['domain_reserved_landinglab'], extra: [] });
  });

  it('maps errors to {code, message, details}', () => {
    expect(toVslErrorResponse(vslError('pathname_conflict', { pathname: '/a' }))).toEqual({
      status: 409, body: { code: 'pathname_conflict', message: 'Este caminho já está em uso.', details: { pathname: '/a' }, error: 'Este caminho já está em uso.' } });
    expect(toVslErrorResponse(new VslError('Stream request outcome uncertain', 502)).body.code).toBe('stream_unavailable');
    expect(toVslErrorResponse(Object.assign(new Error('x'), { validation: [{ message: 'bad' }] })).body.code).toBe('validation_failed');
    expect(toVslErrorResponse(Object.assign(new Error('dup'), { code: '23505' }))).toMatchObject({ status: 409, body: { code: 'constraint_conflict' } });
    // QA F4 L2: UUID malformado chega ao Postgres como 22P02 → 400 estável, não 500.
    expect(toVslErrorResponse(Object.assign(new Error('invalid input syntax for type uuid: "x"'), { code: '22P02' })))
      .toMatchObject({ status: 400, body: { code: 'validation_failed', details: { reason: 'invalid_id' } } });
    expect(toVslErrorResponse(new Error('boom'))).toMatchObject({ status: 500, body: { code: 'internal_error' } });
    expect(toVslErrorResponse(vslError('domain_in_use', undefined, 'Mensagem específica')).body.message).toBe('Mensagem específica');
  });
});
