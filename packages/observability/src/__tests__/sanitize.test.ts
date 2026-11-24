// AC10–AC12 · Sanitização: campos, padrões em texto livre, falsos positivos e quebra.
import { describe, expect, it } from 'vitest';

import {
  isRedactedKey,
  MAX_DEPTH,
  REDACTED,
  sanitizeLogObject,
  sanitizeText,
  sanitizeUrl,
  sanitizeValue,
  TRUNCATED_SUFFIX,
  UNSERIALIZABLE,
} from '../sanitize.js';

const SECRET = 'S3CR3T-VALUE-xyz';

describe('campos redigidos (AC10)', () => {
  const keys = [
    'authorization',
    'Authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'stripe-signature',
    'x-shopify-hmac-sha256',
    'password',
    'token',
    'secret',
    'apiKey',
    'api_key',
    'access_token',
    'refresh_token',
    'client_secret',
    'credentials',
    'encryptedValue',
    'iv',
    'salt',
  ];

  it.each(keys)('%s', (key) => {
    expect(isRedactedKey(key)).toBe(true);
    const out = sanitizeValue({ [key]: SECRET, nested: { deep: [{ [key]: SECRET }] } });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect((out as Record<string, unknown>)[key]).toBe(REDACTED);
  });

  it('dentro de err.cause e de propriedades do erro', () => {
    const cause = Object.assign(new Error('inner'), { token: SECRET });
    const err = Object.assign(new Error('outer', { cause }), { config: { headers: { authorization: SECRET } } });
    const out = JSON.stringify(sanitizeValue(err));
    expect(out).not.toContain(SECRET);
    expect(out).toContain(REDACTED);
    expect(out).toContain('inner');
  });

  it.each([
    'sessionToken',
    'webhookSecret',
    'apiSecret',
    'privateKey',
    'private_key',
    'secretKey',
    'passwd',
    'db_password',
    'passwordHash',
    'authCookie',
    'Set-Cookie',
    'refreshTokens',
    'session',
    'sessionId',
    'session_id',
    'x-webhook-signature',
    'clientCredentials',
    'API_KEY',
    'stripeApiKey',
    'X-Api-Key',
    'signingKey',
  ])('SEC-002 — redige por palavra/par no nome: %s', (key) => {
    expect(isRedactedKey(key)).toBe(true);
    expect(JSON.stringify(sanitizeValue({ nested: { [key]: SECRET } }))).not.toContain(SECRET);
  });

  it.each([
    'tokenCount',
    'tokensCount',
    'tokensUsed',
    'passwordLength',
    'sessionTtl',
    'tokenExpiresAt',
    'hasSignature',
    'isSecret',
    'hasToken',
    'secretariat',
    'tokenizer',
    'sessions_total',
    'keyboard',
    'apiVersion',
    'monkey',
    'storeId',
    'customerSessionCount',
  ])('SEC-002 — sem falso positivo: %s', (key) => {
    expect(isRedactedKey(key)).toBe(false);
  });

  it('cache de chaves não cresce sem limite', () => {
    for (let i = 0; i < 2500; i++) isRedactedKey(`campo${i}`);
    expect(isRedactedKey('sessionToken')).toBe(true);
    expect(isRedactedKey('campo1')).toBe(false);
  });

  it('não redige chaves parecidas', () => {
    expect(isRedactedKey('tokenCount')).toBe(false);
    expect(isRedactedKey('storeId')).toBe(false);
    expect(sanitizeValue({ tokenCount: 3 })).toEqual({ tokenCount: 3 });
  });
});

describe('padrões em texto livre (AC11)', () => {
  it.each([
    ['Bearer abc.def', 'abc.def'],
    ['Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['sk_live_51Habcdefghijklmnop', '51Habcdefghijklmnop'],
    ['rk_test_abcdef123456', 'abcdef123456'],
    ['whsec_abcdefghijklmnop', 'abcdefghijklmnop'],
    ['pi_3Nabc_secret_xyz123', 'xyz123'],
    ['shpat_0123456789abcdef', '0123456789abcdef'],
    ['shpss_0123456789abcdef', '0123456789abcdef'],
    ['token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl', 'c2lnbmF0dXJl'],
    ['postgres://app:senha@db.example.com:5432/db', 'senha'],
    ['meta EAABsbCS1iHgBAKZBZCabcdefghijk123', 'EAABsbCS1iHgBAKZBZCabcdefghijk123'],
    ['resend re_123abc456def789ghi012jkl', '123abc456def789ghi012jkl'],
    ['resend re_AbCd1234_EfGh5678iJkL', 'EfGh5678iJkL'],
    ['anthropic sk-ant-api03-abcDEF_123', 'abcDEF_123'],
    ['cliente joao.silva@gmail.com', 'joao.silva@gmail.com'],
    ['tel +55 11 91234-5678', '91234-5678'],
    ['tel (11) 91234-5678', '91234-5678'],
    ['GET /portal?email=a@b.com&token=xyz', 'xyz'],
  ])('%s', (text, secret) => {
    const out = sanitizeText(text);
    expect(out).not.toContain(secret);
    expect(out).not.toBe(text);
  });

  it('e-mail fica no formato j***@g***.com', () => {
    expect(sanitizeText('joao.silva@gmail.com')).toBe('j***@g***.com');
  });

  it('URL perde os valores de query, mantém as chaves', () => {
    expect(sanitizeUrl('/portal?email=a@b.com&token=xyz')).toBe(`/portal?email=${REDACTED}&token=${REDACTED}`);
    expect(sanitizeUrl('/jobs/123')).toBe('/jobs/123');
    expect(sanitizeUrl(undefined)).toBeUndefined();
  });

  it.each([
    ['3f2a9c1e-6b7d-4e8f-9a0b-1c2d3e4f5a6b'],
    ['SKU BS-a3f9c1-001'],
    ['gid://shopify/Product/123'],
    ['Pedido #1001 pago em 2026-11-02 às 10:30'],
    ['job relink:abc-123:1730000000000 concluído em 250 ms'],
    ['https://cdn.shopify.com/s/files/1/0001/products/foto.jpg'],
    ['queue=publish-queue state=failed'],
    ['re_try falhou'],
  ])('sem falso positivo: %s', (text) => {
    expect(sanitizeText(text)).toBe(text);
  });
});

describe('quebra do sanitizador (AC12)', () => {
  it('getter que lança', () => {
    const obj = {
      ok: 1,
      get boom(): string {
        throw new Error('nope');
      },
    };
    expect(sanitizeValue(obj)).toEqual({ ok: 1, boom: UNSERIALIZABLE });
  });

  it('referência circular', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj['self'] = obj;
    obj['list'] = [obj];
    expect(sanitizeValue(obj)).toEqual({ a: 1, self: '[circular]', list: ['[circular]'] });
  });

  it('string de 5 MB é truncada', () => {
    const out = sanitizeText('a'.repeat(5 * 1024 * 1024));
    expect(out.length).toBeLessThan(2100);
    expect(out.endsWith(TRUNCATED_SUFFIX)).toBe(true);
  });

  it('BigInt, Symbol, função, Date, Map, Buffer', () => {
    const out = sanitizeValue({
      big: 10n,
      sym: Symbol('s'),
      fn: () => 1,
      date: new Date('2026-11-02T00:00:00Z'),
      bad: new Date('x'),
      map: new Map([[1, 2]]),
      buf: Buffer.from('abc'),
      nothing: undefined,
      nul: null,
    });
    expect(out).toEqual({
      big: '10',
      sym: 'Symbol(s)',
      fn: '[function]',
      date: '2026-11-02T00:00:00.000Z',
      bad: 'Invalid Date',
      map: '[Map 1]',
      buf: '[binary 3 bytes]',
      nothing: undefined,
      nul: null,
    });
  });

  it('profundidade limitada', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < MAX_DEPTH + 3; i++) deep = { next: deep };
    expect(JSON.stringify(sanitizeValue(deep))).toContain('[depth]');
  });

  it('arrays e objetos grandes são cortados', () => {
    const arr = sanitizeValue(Array.from({ length: 150 }, (_, i) => i)) as unknown[];
    expect(arr).toHaveLength(101);
    const big = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(sanitizeValue(big) as object)).toHaveLength(101);
  });

  it('Proxy que lança em ownKeys não derruba', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('hostile');
        },
      },
    );
    expect(sanitizeValue({ hostile })).toEqual({ hostile: UNSERIALIZABLE });
    expect(sanitizeLogObject(hostile as Record<string, unknown>, new Set())).toEqual({ log: UNSERIALIZABLE });
  });

  it('erro com getter de message que lança', () => {
    const err = new Error('x');
    Object.defineProperty(err, 'message', {
      get() {
        throw new Error('boom');
      },
    });
    const out = sanitizeValue(err) as Record<string, unknown>;
    expect(out['type']).toBe('Error');
    expect(out['message']).toBe('');
  });
});

describe('sanitizeLogObject', () => {
  it('pula as chaves deixadas para os serializers', () => {
    const req = { url: '/x?token=1' };
    const out = sanitizeLogObject({ req, password: SECRET, msgText: 'Bearer abc' }, new Set(['req']));
    expect(out['req']).toBe(req);
    expect(out['password']).toBe(REDACTED);
    expect(out['msgText']).toBe(`Bearer ${REDACTED}`);
  });
});
