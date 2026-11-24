// AC10–AC12 · Logger sanitizado: saída capturada do pino real; o raiz não muda.
import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { runWithCorrelation } from '../correlation.js';
import { createContextLogger, createSanitizedLogger, sanitizeLogArgs, serializeError } from '../logger.js';
import { REDACTED, UNSERIALIZABLE } from '../sanitize.js';
import { createLogCapture } from '../testing.js';

const SECRET = 'S3CR3T-VALUE-xyz';

function setup() {
  const capture = createLogCapture();
  const root = pino({ level: 'info', base: { service: 'test' } }, capture.stream);
  return { capture, root, safe: createSanitizedLogger(root) };
}

describe('createSanitizedLogger', () => {
  it('redige campos em objetos, arrays e err.cause (nenhum valor na saída)', () => {
    const { capture, safe } = setup();
    const cause = Object.assign(new Error('inner'), { client_secret: SECRET });
    safe.info(
      {
        headers: { authorization: SECRET, cookie: SECRET, 'set-cookie': [SECRET], 'x-api-key': SECRET, 'stripe-signature': SECRET },
        body: { password: SECRET, token: SECRET, secret: SECRET, apiKey: SECRET, access_token: SECRET, refresh_token: SECRET },
        list: [{ credentials: SECRET }],
        err: new Error('outer', { cause }),
      },
      'pedido',
    );
    expect(capture.raw.join('')).not.toContain(SECRET);
    const line = capture.lines[0]!;
    expect((line['headers'] as Record<string, unknown>)['authorization']).toBe(REDACTED);
    expect((line['body'] as Record<string, unknown>)['password']).toBe(REDACTED);
    expect(line['msg']).toBe('pedido');
    expect(line['service']).toBe('test');
  });

  it('mascara padrões na mensagem, nos argumentos e no erro', () => {
    const { capture, safe } = setup();
    safe.warn('falhou com Bearer abc.def para joao.silva@gmail.com');
    safe.info({ a: 1 }, 'url %s', '/x?token=xyz');
    safe.error(new Error('sk_live_51Habcdefghijklmnop recusada'));
    safe.error({ err: new Error('postgres://app:senha@db.example.com/db') });
    safe.info(42 as unknown as string);
    const raw = capture.raw.join('');
    for (const secret of ['abc.def', 'joao.silva', '51Habcdefghijklmnop', 'senha', 'token=xyz']) expect(raw).not.toContain(secret);
    expect(capture.lines[2]!['msg']).toBe(`sk_live_${REDACTED} recusada`);
    expect((capture.lines[2]!['err'] as Record<string, unknown>)['type']).toBe('Error');
  });

  it('serializer de req tira os valores de query e os headers sensíveis', () => {
    const { capture, safe } = setup();
    safe.info({ req: { method: 'GET', url: '/portal?email=a@b.com', headers: { authorization: SECRET } } }, 'incoming');
    const req = capture.lines[0]!['req'] as Record<string, unknown>;
    expect(req['url']).toBe(`/portal?email=${REDACTED}`);
    expect(capture.raw.join('')).not.toContain(SECRET);
  });

  it('nunca lança: getter que lança, circular, 5 MB, BigInt, Symbol', () => {
    const { capture, safe } = setup();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const hostile = {
      get boom(): string {
        throw new Error('x');
      },
    };
    expect(() =>
      safe.info({ hostile, circular, big: 'a'.repeat(5 * 1024 * 1024), n: 10n, s: Symbol('s') }, 'x'),
    ).not.toThrow();
    const line = capture.lines[0]!;
    expect(line['hostile']).toEqual({ boom: UNSERIALIZABLE });
    expect(line['n']).toBe('10');
    expect(String(line['big']).length).toBeLessThan(2100);
  });

  it('o logger raiz continua sem sanitização (filho é derivado)', () => {
    const { capture, root, safe } = setup();
    expect(safe).not.toBe(root);
    root.info({ token: SECRET }, 'Bearer abc.def');
    expect(capture.lines[0]).toMatchObject({ token: SECRET, msg: 'Bearer abc.def' });
  });

  it('filhos do logger sanitizado herdam a sanitização e são cacheados', () => {
    const { capture, root, safe } = setup();
    expect(createSanitizedLogger(root)).toBe(safe);
    safe.child({ correlationId: 'ABCDEFGH-1' }).info({ password: SECRET }, 'ok');
    expect(capture.lines[0]).toMatchObject({ correlationId: 'ABCDEFGH-1', password: REDACTED });
  });

  it('respeita logMethod já existente no raiz', () => {
    const capture = createLogCapture();
    const calls: unknown[][] = [];
    const root = pino(
      {
        hooks: {
          logMethod(args, method) {
            calls.push(args);
            return method.apply(this, args);
          },
        },
      },
      capture.stream,
    );
    createSanitizedLogger(root).info('Bearer abc.def');
    expect(calls[0]).toEqual([`Bearer ${REDACTED}`]);
  });

  it('logger que não é pino volta como veio', () => {
    const noop = { child: () => noop, info: () => undefined };
    expect(createSanitizedLogger(noop)).toBe(noop);
    expect(createSanitizedLogger(null)).toBeNull();
  });
});

describe('sanitizeLogArgs / serializeError', () => {
  it('erro como primeiro argumento com mensagem explícita', () => {
    const err = new Error('x');
    expect(sanitizeLogArgs([err, 'Bearer a.b', 'c@d.com', { token: 1 }])).toEqual([
      { err },
      `Bearer ${REDACTED}`,
      'c***@d***.com',
      { token: REDACTED },
    ]);
  });

  it('nunca lança', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('x');
        },
      },
    );
    expect(() => sanitizeLogArgs([hostile])).not.toThrow();
  });

  it('serializeError aceita string e objeto', () => {
    expect(serializeError('Bearer a.b')).toBe(`Bearer ${REDACTED}`);
    expect(serializeError({ token: 1 })).toEqual({ token: REDACTED });
  });
});

describe('createContextLogger', () => {
  it('sem contexto: saída idêntica ao raiz', () => {
    const plain = createLogCapture();
    const proxied = createLogCapture();
    const a = pino({ base: { service: 'worker' }, timestamp: false }, plain.stream);
    const b = createContextLogger(pino({ base: { service: 'worker' }, timestamp: false }, proxied.stream));
    a.info({ to: 'a@b.com', token: SECRET }, 'Bearer abc.def');
    b.info({ to: 'a@b.com', token: SECRET }, 'Bearer abc.def');
    expect(proxied.raw).toEqual(plain.raw);
  });

  it('com contexto: usa o logger do contexto (correlationId + sanitização)', () => {
    const capture = createLogCapture();
    const root = pino({ base: { service: 'worker' } }, capture.stream);
    const logger = createContextLogger(root);
    const contextual = createSanitizedLogger(root).child({ correlationId: 'ABCDEFGH-1' });
    runWithCorrelation({ correlationId: 'ABCDEFGH-1', logger: contextual }, () => logger.info({ token: SECRET }, 'ok'));
    expect(capture.lines[0]).toMatchObject({ service: 'worker', correlationId: 'ABCDEFGH-1', token: REDACTED });
  });

  it('propriedades e escrita passam para o raiz', () => {
    const root = pino({ level: 'info' }, createLogCapture().stream);
    const logger = createContextLogger(root);
    expect(logger.level).toBe('info');
    logger.level = 'warn';
    expect(root.level).toBe('warn');
  });
});
