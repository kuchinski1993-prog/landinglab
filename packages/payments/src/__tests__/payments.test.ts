import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

import {
  StripeKeyError,
  StripeWebhookSignatureError,
  assertWebhookSecret,
  resolveAccountMode,
  selectStripeAccount,
  signStripeWebhookPayload,
  testStripeConnection,
  verifyStripeWebhook,
  type StripeAccountCandidate,
  type StripeClient,
} from '../index.js';

const PK_TEST = 'pk_test_51AbCdEfGhIjKlMnOp';
const PK_LIVE = 'pk_live_51AbCdEfGhIjKlMnOp';
const SK_TEST = 'sk_test_51AbCdEfGhIjKlMnOp';
const RK_LIVE = 'rk_live_51AbCdEfGhIjKlMnOp';

describe('chaves Stripe', () => {
  it('deriva o modo quando pk e secret combinam', () => {
    expect(resolveAccountMode(PK_TEST, SK_TEST)).toBe('test');
    expect(resolveAccountMode(PK_LIVE, RK_LIVE)).toBe('live');
  });

  it('recusa pk e secret de modos diferentes', () => {
    expect(() => resolveAccountMode(PK_LIVE, SK_TEST)).toThrow(StripeKeyError);
  });

  it('recusa formatos inválidos', () => {
    expect(() => resolveAccountMode('sk_test_x', SK_TEST)).toThrow(/Publishable/);
    expect(() => resolveAccountMode(PK_TEST, 'pk_test_51AbCdEfGhIjKlMnOp')).toThrow(/Secret/);
    expect(() => assertWebhookSecret('sk_test_abc')).toThrow(/whsec_/);
    expect(() => assertWebhookSecret('whsec_AbCdEfGhIjKlMnOp')).not.toThrow();
  });
});

describe('selectStripeAccount', () => {
  const base = (over: Partial<StripeAccountCandidate>): StripeAccountCandidate => ({
    id: 'a',
    priority: 1,
    status: 'active',
    dailyLimitMinor: 200_000,
    volumeTodayMinor: 0,
    ...over,
  });

  it('retorna null sem contas ativas', () => {
    expect(selectStripeAccount([])).toBeNull();
    expect(selectStripeAccount([base({ status: 'inactive' })])).toBeNull();
  });

  it('com uma conta abaixo do limite, usa ela', () => {
    const result = selectStripeAccount([base({ volumeTodayMinor: 1000 })]);
    expect(result).toEqual({ account: expect.objectContaining({ id: 'a' }), overLimit: false });
  });

  it('com uma conta acima do limite, continua nela e sinaliza overLimit', () => {
    const result = selectStripeAccount([base({ volumeTodayMinor: 200_000 })]);
    expect(result?.account.id).toBe('a');
    expect(result?.overLimit).toBe(true);
  });

  it('rotaciona para a próxima prioridade quando a principal bate o limite', () => {
    const result = selectStripeAccount([
      base({ id: 'c', priority: 3 }),
      base({ id: 'a', priority: 1, volumeTodayMinor: 250_000 }),
      base({ id: 'b', priority: 2, volumeTodayMinor: 10 }),
    ]);
    expect(result?.account.id).toBe('b');
    expect(result?.overLimit).toBe(false);
  });

  it('ignora inativas e trata limite nulo como ilimitado', () => {
    const result = selectStripeAccount([
      base({ id: 'a', priority: 1, status: 'inactive' }),
      base({ id: 'b', priority: 2, dailyLimitMinor: null, volumeTodayMinor: 9_999_999 }),
    ]);
    expect(result?.account.id).toBe('b');
    expect(result?.overLimit).toBe(false);
  });

  it('com todas acima do limite, volta para a principal', () => {
    const result = selectStripeAccount([
      base({ id: 'b', priority: 2, volumeTodayMinor: 300_000 }),
      base({ id: 'a', priority: 1, volumeTodayMinor: 300_000 }),
    ]);
    expect(result?.account.id).toBe('a');
    expect(result?.overLimit).toBe(true);
  });
});

describe('webhook', () => {
  const secret = 'whsec_testSecretValue123456';
  const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'charge.refunded' });

  it('aceita assinatura válida', () => {
    const header = signStripeWebhookPayload(payload, secret);
    const event = verifyStripeWebhook(Buffer.from(payload), header, secret);
    expect(event.id).toBe('evt_1');
  });

  it('recusa assinatura de outro segredo ou corpo alterado', () => {
    const header = signStripeWebhookPayload(payload, 'whsec_otherSecretValue12345');
    expect(() => verifyStripeWebhook(Buffer.from(payload), header, secret)).toThrow(
      StripeWebhookSignatureError,
    );
    const valid = signStripeWebhookPayload(payload, secret);
    expect(() => verifyStripeWebhook(Buffer.from(`${payload} `), valid, secret)).toThrow(
      StripeWebhookSignatureError,
    );
  });
});

describe('testStripeConnection', () => {
  it('retorna dados da conta quando a chave é válida', async () => {
    const client = {
      accounts: {
        retrieveCurrent: async () => ({ id: 'acct_123', charges_enabled: true, default_currency: 'eur' }),
      },
    } as unknown as StripeClient;
    const result = await testStripeConnection(client);
    expect(result).toMatchObject({
      ok: true,
      accountRef: 'acct_123',
      defaultCurrency: 'EUR',
      chargesEnabled: true,
    });
  });

  it('chave restrita sem permissão de conta cai para balance', async () => {
    const client = {
      accounts: {
        retrieveCurrent: async () => {
          throw new Stripe.errors.StripePermissionError({ message: 'no perm', type: 'invalid_request_error' });
        },
      },
      balance: {
        retrieve: async () => ({ livemode: false, available: [{ currency: 'eur' }], pending: [] }),
      },
    } as unknown as StripeClient;
    const result = await testStripeConnection(client);
    expect(result.ok).toBe(true);
    expect(result.defaultCurrency).toBe('EUR');
    expect(result.accountRef).toBeNull();
  });

  it('chave recusada retorna erro sem vazar a chave', async () => {
    const client = {
      accounts: {
        retrieveCurrent: async () => {
          throw new Stripe.errors.StripeAuthenticationError({
            message: 'Invalid API Key provided: sk_test_***',
            type: 'invalid_request_error',
          });
        },
      },
    } as unknown as StripeClient;
    const result = await testStripeConnection(client);
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('sk_');
  });
});
