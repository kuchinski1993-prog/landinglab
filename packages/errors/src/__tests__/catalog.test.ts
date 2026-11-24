import { describe, expect, it } from 'vitest';

import {
  AppError,
  CAMBIO_CATALOG,
  CAMBIO_ERRORS,
  catalogOwner,
  COMMON_CATALOG,
  COMMON_ERRORS,
  defineCatalog,
  isAppError,
} from '../index.js';

describe('defineCatalog — validação na carga', () => {
  it('cria catálogo tipado com error/body/has/get', () => {
    const cat = defineCatalog('t1', { 't1.oops': { status: 409, message: 'Deu conflito.' } });
    expect(cat.moduleId).toBe('t1');
    expect(cat.has('t1.oops')).toBe(true);
    expect(cat.has('t1.nope')).toBe(false);
    expect(cat.has(42)).toBe(false);
    expect(cat.get('t1.oops')).toEqual({ status: 409, message: 'Deu conflito.' });
    expect(cat.get('toString')).toBeUndefined();
    expect(cat.body('t1.oops', { a: 1 })).toEqual({ code: 't1.oops', message: 'Deu conflito.', details: { a: 1 }, error: 'Deu conflito.' });
    expect(cat.body('t1.oops')).toEqual({ code: 't1.oops', message: 'Deu conflito.', error: 'Deu conflito.' });
    const err = cat.error('t1.oops', { a: 1 });
    expect(isAppError(err)).toBe(true);
    expect([err.message, err.statusCode, err.code, err.details, err.publicMessage]).toEqual(['Deu conflito.', 409, 't1.oops', { a: 1 }, false]);
    expect(cat.error('t1.oops', undefined, 'Outra mensagem.').publicMessage).toBe(true);
    expect(catalogOwner('t1.oops')).toBe('t1');
    expect(Object.isFrozen(cat.entries)).toBe(true);
  });

  it('código duplicado entre catálogos → lança com os dois módulos', () => {
    defineCatalog('dupa', { 'dupa.x': { status: 400, message: 'X.' } }, { prefix: '' });
    expect(() => defineCatalog('dupb', { 'dupa.x': { status: 400, message: 'X.' } }, { prefix: '' })).toThrow(
      /'dupa\.x' duplicado entre os módulos 'dupa' e 'dupb'/
    );
  });

  it('redeclarar código do comum (sem include/overrides) → colisão', () => {
    expect(() => defineCatalog('dupc', { internal_error: { status: 500, message: 'Outro.' } }, { prefix: '' })).toThrow(
      /'internal_error' duplicado entre os módulos 'comum' e 'dupc'/
    );
    expect(() =>
      defineCatalog('dupd', { not_found: { status: 404, message: 'X.' } }, { prefix: '', base: COMMON_CATALOG, include: ['not_found'] })
    ).toThrow(/'not_found' duplicado entre os módulos 'comum' e 'dupd'/);
  });

  it('redefinir o MESMO módulo não é colisão (hot reload / resetModules)', () => {
    defineCatalog('same', { 'same.a': { status: 400, message: 'A.' } });
    expect(() => defineCatalog('same', { 'same.a': { status: 400, message: 'A.' } })).not.toThrow();
  });

  it.each([399, 600, 200, 404.5, Number.NaN])('status %s fora de 400–599 → lança', (status) => {
    expect(() => defineCatalog(`st${String(status)}`, { [`st${String(status)}.x`]: { status, message: 'X.' } })).toThrow(/status inválido/);
  });

  it('mensagem vazia → lança', () => {
    expect(() => defineCatalog('empty', { 'empty.x': { status: 400, message: '   ' } })).toThrow(/mensagem vazia/);
  });

  it('código vazio e moduleId vazio → lançam', () => {
    expect(() => defineCatalog('blank', { ' ': { status: 400, message: 'X.' } }, { prefix: '' })).toThrow(/código vazio/);
    expect(() => defineCatalog(' ', {})).toThrow(/moduleId vazio/);
  });

  it('código sem o prefixo do módulo → lança; legacy e prefix "" aceitos', () => {
    expect(() => defineCatalog('loja', { variant_price_required: { status: 400, message: 'X.' } })).toThrow(/prefixo 'loja\.'/);
    expect(() => defineCatalog('pref', { OLD_CODE: { status: 502, message: 'X.', legacy: true } })).not.toThrow();
  });

  it('include + overrides de mensagem (mesmo status) são aceitos', () => {
    const cat = defineCatalog(
      'inc',
      { 'inc.own': { status: 400, message: 'Própria.' } },
      { base: COMMON_CATALOG, include: ['internal_error', 'not_found'], overrides: { internal_error: 'Erro interno no módulo.' } }
    );
    expect(cat.entries.internal_error).toEqual({ status: 500, message: 'Erro interno no módulo.' });
    expect(cat.entries.not_found).toBe(COMMON_ERRORS.not_found);
    expect(Object.keys(cat.entries).sort()).toEqual(['inc.own', 'internal_error', 'not_found']);
    // O comum continua neutro.
    expect(COMMON_ERRORS.internal_error.message).toBe('Erro interno. Tente novamente.');
    expect(catalogOwner('internal_error')).toBe('comum');
  });

  it('override como entrada com o mesmo status é aceito; com status diferente lança', () => {
    expect(() =>
      defineCatalog('ovok', {}, { base: COMMON_CATALOG, include: ['not_found'], overrides: { not_found: { status: 404, message: 'Sumiu.' } } })
    ).not.toThrow();
    expect(() =>
      defineCatalog('ovbad', {}, { base: COMMON_CATALOG, include: ['not_found'], overrides: { not_found: { status: 410, message: 'Sumiu.' } } })
    ).toThrow(/sobrescrita de status não permitida em 'not_found' \(404 → 410\)/);
  });

  it('override vazio, de código não incluído, include inexistente ou sem base → lançam', () => {
    expect(() => defineCatalog('ov1', {}, { base: COMMON_CATALOG, include: ['not_found'], overrides: { not_found: '' } })).toThrow(/mensagem vazia/);
    expect(() =>
      defineCatalog('ov2', {}, { base: COMMON_CATALOG, include: ['not_found'], overrides: { internal_error: 'X.' } as never })
    ).toThrow(/não está em `include`/);
    expect(() => defineCatalog('ov3', {}, { base: COMMON_CATALOG, include: ['nao_existe' as never] })).toThrow(/não existe no catálogo 'comum'/);
    expect(() => defineCatalog('ov4', {}, { include: ['not_found' as never] })).toThrow(/exige `base`/);
    expect(() =>
      defineCatalog('ov5', {}, { base: COMMON_CATALOG, include: ['not_found'], overrides: { not_found: undefined } })
    ).not.toThrow();
  });
});

describe('catálogo comum', () => {
  it('tem os 8 genéricos do VSL + rate_limited + 2 legados + 2 da família UPSTREAM_* (18.2) + forbidden/method_not_allowed (18.11)', () => {
    expect(Object.keys(COMMON_ERRORS).sort()).toEqual(
      [
        'UPSTREAM_RATE_LIMITED',
        'UPSTREAM_TIMEOUT',
        'UPSTREAM_UNAVAILABLE',
        'UPSTREAM_REJECTED',
        'constraint_conflict',
        'cross_site_rejected',
        'forbidden',
        'internal_error',
        'method_not_allowed',
        'not_found',
        'rate_limited',
        'service_unavailable',
        'unauthorized',
        'validation_failed',
        'version_conflict',
      ].sort()
    );
    expect(COMMON_ERRORS.rate_limited.status).toBe(429);
    expect(COMMON_ERRORS.forbidden.status).toBe(403);
    expect(COMMON_ERRORS.method_not_allowed.status).toBe(405);
    expect(COMMON_ERRORS.UPSTREAM_TIMEOUT).toMatchObject({ status: 504, legacy: true });
    expect(COMMON_ERRORS.UPSTREAM_RATE_LIMITED).toMatchObject({ status: 503, legacy: true });
    expect(COMMON_ERRORS.UPSTREAM_UNAVAILABLE).toMatchObject({ status: 503, legacy: true });
    expect(COMMON_ERRORS.UPSTREAM_REJECTED).toMatchObject({ status: 502, legacy: true });
    // Textos neutros: não citam produto.
    expect(COMMON_ERRORS.internal_error.message).not.toMatch(/VSL/);
    expect(COMMON_ERRORS.service_unavailable.message).not.toMatch(/VSL/);
  });

  it('body de legado inclui statusCode (contrato da 0.8)', () => {
    expect(COMMON_CATALOG.body('UPSTREAM_TIMEOUT')).toEqual({
      code: 'UPSTREAM_TIMEOUT',
      message: COMMON_ERRORS.UPSTREAM_TIMEOUT.message,
      error: COMMON_ERRORS.UPSTREAM_TIMEOUT.message,
      statusCode: 504,
    });
  });
});

describe('AppError', () => {
  it('assinatura (message, statusCode = 400, code?, details?, options?)', () => {
    const plain = new AppError('m');
    expect([plain.statusCode, plain.code, plain.details, plain.publicMessage]).toEqual([400, undefined, undefined, false]);
    expect(plain).toBeInstanceOf(Error);
    const withCause = new AppError('m', 500, 'x.y', undefined, { cause: new Error('root') });
    expect((withCause.cause as Error).message).toBe('root');
  });
});

describe('Story 0.7c · catálogo cambio', () => {
  it('registra FX_DOUBLE_CONVERSION (409, legado, nome preservado) sem colidir com o comum', () => {
    expect(catalogOwner('FX_DOUBLE_CONVERSION')).toBe('cambio');
    expect(CAMBIO_ERRORS.FX_DOUBLE_CONVERSION).toMatchObject({ status: 409, legacy: true });
    expect(CAMBIO_CATALOG.has('FX_DOUBLE_CONVERSION')).toBe(true);
    expect(COMMON_CATALOG.has('FX_DOUBLE_CONVERSION')).toBe(false);
    // Legado: o corpo traz statusCode, como os UPSTREAM_*.
    expect(CAMBIO_CATALOG.body('FX_DOUBLE_CONVERSION')).toMatchObject({ code: 'FX_DOUBLE_CONVERSION', statusCode: 409 });
    // Outro módulo não pode reaproveitar o código.
    expect(() =>
      defineCatalog('outro', { FX_DOUBLE_CONVERSION: { status: 409, message: 'X.', legacy: true } }, { prefix: '' })
    ).toThrow(/duplicado entre os módulos 'cambio' e 'outro'/);
  });
});
