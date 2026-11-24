// Portal · verify-possession — testes puros (Fase 2).

import { describe, expect, it } from 'vitest';

import {
  PORTAL_NOT_FOUND_BODY,
  checkPossession,
  normalizePortalEmail,
} from '../portal/verify-possession.js';

describe('normalizePortalEmail', () => {
  it('trim + lowercase', () => {
    expect(normalizePortalEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
  });
  it('null/undefined → ""', () => {
    expect(normalizePortalEmail(null)).toBe('');
    expect(normalizePortalEmail(undefined)).toBe('');
  });
});

describe('checkPossession', () => {
  const resource = { storeId: 'default', customerEmail: 'buyer@example.com' };

  it('match: email bate + storeId bate', () => {
    const r = checkPossession(resource, 'default', 'buyer@example.com');
    expect(r).toEqual({ ok: true, reason: 'match' });
  });

  it('match aceita variação de caixa e whitespace no email', () => {
    const r = checkPossession(resource, 'default', ' BUYER@Example.COM  ');
    expect(r.ok).toBe(true);
  });

  it('not_found: resource undefined', () => {
    const r = checkPossession(undefined, 'default', 'x@y.com');
    expect(r).toEqual({ ok: false, reason: 'not_found' });
  });

  it('not_found: email vazio', () => {
    const r = checkPossession(resource, 'default', '');
    expect(r).toEqual({ ok: false, reason: 'not_found' });
  });

  it('wrong_store: storeId diferente do resource', () => {
    const r = checkPossession(resource, 'other', 'buyer@example.com');
    expect(r).toEqual({ ok: false, reason: 'wrong_store' });
  });

  it('email_mismatch: resource existe mas email não bate', () => {
    const r = checkPossession(resource, 'default', 'attacker@example.com');
    expect(r).toEqual({ ok: false, reason: 'email_mismatch' });
  });

  it('email_mismatch: resource sem customerEmail (null) nunca bate', () => {
    const r = checkPossession(
      { storeId: 'default', customerEmail: null },
      'default',
      'buyer@example.com',
    );
    expect(r).toEqual({ ok: false, reason: 'email_mismatch' });
  });
});

describe('PORTAL_NOT_FOUND_BODY', () => {
  it('shape estável (não vaza a razão da falha)', () => {
    expect(PORTAL_NOT_FOUND_BODY).toEqual({
      error: 'Not found',
      statusCode: 404,
    });
  });
});
