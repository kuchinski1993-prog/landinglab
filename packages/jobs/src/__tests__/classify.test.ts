// Story 18.3 · AC2 — classifyJobError (tabela de casos) + RetryPolicy + sanitização.
import {
  UpstreamRateLimitedError,
  UpstreamRejectedError,
  UpstreamTimeoutError,
  UpstreamUnavailableError,
} from '@blackshop/shared/http';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';

import {
  classifyJobError,
  DeterministicJobError,
  RetryPolicy,
  sanitizeErrorText,
  TransientJobError,
  UNCLASSIFIED_CODE,
  type JobErrorKind,
} from '../index.js';
import { messageOf } from '../sanitize.js';

const netError = (code: string): Error => Object.assign(new Error(`connect ${code}`), { code });

const CASES: Array<[string, unknown, JobErrorKind, string]> = [
  ['UnrecoverableError do BullMQ', new UnrecoverableError('não repetir'), 'deterministic', UNCLASSIFIED_CODE],
  [
    'UnrecoverableError com code (ShopifyResultUncertainError da 0.8)',
    Object.assign(new UnrecoverableError('x'), { code: 'SHOPIFY_RESULT_UNCERTAIN' }),
    'deterministic',
    'SHOPIFY_RESULT_UNCERTAIN',
  ],
  ['DeterministicJobError', new DeterministicJobError('loja.relink_product_not_found', 'sem produto'), 'deterministic', 'loja.relink_product_not_found'],
  ['UpstreamRejectedError (kind permanent)', new UpstreamRejectedError({ label: 'shopify-admin', status: 422, attempts: 1 }), 'deterministic', 'UPSTREAM_REJECTED'],
  ['UpstreamUnavailableError incerto', new UpstreamUnavailableError({ label: 's', status: 503, attempts: 1, kind: 'uncertain' }), 'uncertain', 'UPSTREAM_UNAVAILABLE'],
  ['UpstreamTimeoutError uncertain=true', new UpstreamTimeoutError('shopify-admin', 15_000, true), 'uncertain', 'UPSTREAM_TIMEOUT'],
  ['UpstreamTimeoutError uncertain=false', new UpstreamTimeoutError('shopify-admin', 15_000, false), 'transient', 'UPSTREAM_TIMEOUT'],
  ['UpstreamUnavailableError transitório', new UpstreamUnavailableError({ label: 's', status: null, attempts: 4, kind: 'transient' }), 'transient', 'UPSTREAM_UNAVAILABLE'],
  ['UpstreamRateLimitedError (429)', new UpstreamRateLimitedError('s', 2_000, 4), 'transient', 'UPSTREAM_RATE_LIMITED'],
  ['TransientJobError', new TransientJobError('loja.relink_publish_enqueue_failed', 'redis fora'), 'transient', 'loja.relink_publish_enqueue_failed'],
  ['erro de rede ECONNRESET', netError('ECONNRESET'), 'transient', 'ECONNRESET'],
  ['erro de rede ETIMEDOUT', netError('ETIMEDOUT'), 'transient', 'ETIMEDOUT'],
  ['TypeError fetch failed (undici)', new TypeError('fetch failed'), 'transient', UNCLASSIFIED_CODE],
  ['causa de rede em cause', new Error('falhou', { cause: netError('ECONNREFUSED') }), 'transient', UNCLASSIFIED_CODE],
  ['AbortError', Object.assign(new Error('aborted'), { name: 'AbortError' }), 'transient', UNCLASSIFIED_CODE],
  ['HTTP 503 por statusCode', Object.assign(new Error('fora'), { statusCode: 503 }), 'transient', UNCLASSIFIED_CODE],
  ['HTTP 429 por status', Object.assign(new Error('limite'), { status: 429 }), 'transient', UNCLASSIFIED_CODE],
  ['erro sem classe', new Error('boom'), 'transient', UNCLASSIFIED_CODE],
  ['erro sem classe com code próprio', Object.assign(new Error('boom'), { code: 'XYZ_CODE' }), 'transient', UNCLASSIFIED_CODE],
  ['string lançada', 'deu ruim', 'transient', UNCLASSIFIED_CODE],
  ['undefined lançado', undefined, 'transient', UNCLASSIFIED_CODE],
  ['objeto sem message', { foo: 1 }, 'transient', UNCLASSIFIED_CODE],
  ['HTTP 404 (não é transitório nem permanente marcado)', Object.assign(new Error('404'), { status: 404 }), 'transient', UNCLASSIFIED_CODE],
];

describe('classifyJobError (AC2)', () => {
  it.each(CASES)('%s', (_label, err, kind, code) => {
    const c = classifyJobError(err);
    expect(c.kind).toBe(kind);
    expect(c.code).toBe(code);
    expect(c.message.length).toBeLessThanOrEqual(500);
  });

  it('desconhecido: unclassified=true e o code original vai na mensagem', () => {
    const c = classifyJobError(Object.assign(new Error('boom'), { code: 'XYZ_CODE' }));
    expect(c).toMatchObject({ kind: 'transient', code: UNCLASSIFIED_CODE, unclassified: true, message: '[XYZ_CODE] boom' });
    expect(classifyJobError(new UpstreamTimeoutError('s', 1, true)).unclassified).toBe(false);
  });

  it('mapa do processor decide antes das regras genéricas', () => {
    const err = new Error('produto sumiu');
    expect(classifyJobError(err, { classify: () => ({ kind: 'deterministic', code: 'loja.x' }) })).toMatchObject({
      kind: 'deterministic',
      code: 'loja.x',
    });
    // Sem code no mapa: usa o do erro; sem nenhum, o unclassified.
    expect(classifyJobError(Object.assign(err, { code: 'C1' }), { classify: () => ({ kind: 'uncertain' }) }).code).toBe('C1');
    expect(classifyJobError(new Error('x'), { classify: () => ({ kind: 'uncertain' }) }).code).toBe(UNCLASSIFIED_CODE);
    // Mapa devolvendo null: cai nas regras genéricas.
    expect(classifyJobError(new UnrecoverableError('x'), { classify: () => null }).kind).toBe('deterministic');
  });

  it('mensagem sanitizada (sem token, e-mail ou segredo em query string) e limitada a 500', () => {
    const err = new Error(
      'falhou para joao@exemplo.com com Bearer abc.def-123 e shpat_SEGREDO em https://x.io/a?token=SECRETO&b=1 ' + 'x'.repeat(800),
    );
    const c = classifyJobError(err);
    expect(c.message).not.toContain('joao@exemplo.com');
    expect(c.message).not.toContain('abc.def-123');
    expect(c.message).not.toContain('shpat_SEGREDO');
    expect(c.message).not.toContain('SECRETO');
    expect(c.message.length).toBe(500);
  });
});

describe('RetryPolicy', () => {
  it('última tentativa = attemptsMade + 1 >= attempts', () => {
    expect(RetryPolicy.isLastAttempt({ attemptsMade: 0, opts: { attempts: 3 } })).toBe(false);
    expect(RetryPolicy.isLastAttempt({ attemptsMade: 2, opts: { attempts: 3 } })).toBe(true);
    expect(RetryPolicy.isLastAttempt({ attemptsMade: 0 })).toBe(true);
    expect(RetryPolicy.maxAttemptsOf({ attemptsMade: 0, opts: { attempts: 0 } })).toBe(1);
  });

  it('decide: determinístico → failed; incerto → uncertain; transitório → retrying até a última', () => {
    expect(RetryPolicy.decide('deterministic', false)).toEqual({ state: 'failed', retry: false });
    expect(RetryPolicy.decide('uncertain', false)).toEqual({ state: 'uncertain', retry: false });
    expect(RetryPolicy.decide('transient', false)).toEqual({ state: 'retrying', retry: true });
    expect(RetryPolicy.decide('transient', true)).toEqual({ state: 'failed', retry: false });
  });
});

describe('sanitize/messageOf', () => {
  it('messageOf cobre Error sem message, string, objeto e primitivos', () => {
    expect(messageOf(new Error(''))).toBe('Error');
    expect(messageOf({ message: 'm' })).toBe('m');
    expect(messageOf({})).toBe('objeto lançado sem message');
    expect(messageOf(null)).toBe('null');
    expect(messageOf(42)).toBe('42');
  });

  it('sanitizeErrorText respeita o limite pedido', () => {
    expect(sanitizeErrorText('abcdef', 3)).toBe('abc');
  });
});
