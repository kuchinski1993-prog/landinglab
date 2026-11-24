// Story 18.4 · Logger sanitizado DERIVADO (filho) — nunca altera o logger raiz.
//
// createSanitizedLogger(base) devolve um filho do pino com:
//   (1) `redact` por caminho (headers sensíveis em req/res);
//   (2) serializers `err` e `req` que passam pelo sanitize (URL sem valores de query);
//   (3) hook `logMethod` (só neste filho e nos filhos dele) que sanitiza o objeto e a mensagem.
// Criado UMA vez por logger base (cache); por requisição/job só se faz `.child({ ... })`, barato.
// Sem contexto, o logger raiz continua escrevendo exatamente o que escrevia (zonas protegidas).
import { getCorrelationContext } from './correlation.js';
import { REDACTED, sanitizeLogObject, sanitizeText, sanitizeUrl, sanitizeValue, UNSERIALIZABLE } from './sanitize.js';

/** Caminhos redigidos pelo `redact` do pino (camada 1). */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-shopify-hmac-sha256"]',
  'req.headers["stripe-signature"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.apiKey',
  '*.api_key',
  '*.access_token',
  '*.refresh_token',
  '*.client_secret',
  '*.authorization',
  '*.cookie',
  '*.credentials',
  '*.encryptedValue',
  '*.iv',
  '*.salt',
];

const HOOKS = Symbol.for('pino.hooks');
const SERIALIZERS = Symbol.for('pino.serializers');
/** Chaves deixadas para os serializers do pino (Fastify loga `req`/`res` com objetos enormes). */
const SERIALIZED_KEYS: ReadonlySet<string> = new Set(['req', 'res', 'err']);

type LogFn = (...args: unknown[]) => void;

/** Forma mínima de um logger pino (o de `request.log`, o do worker). */
export interface PinoLike {
  level: string;
  child(bindings: Record<string, unknown>, options?: Record<string, unknown>): PinoLike;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  [key: symbol]: unknown;
}

type Serializer = (value: unknown) => unknown;
type LogMethodHook = (this: unknown, args: unknown[], method: LogFn, level: number) => void;

function isPino(logger: unknown): logger is PinoLike {
  return !!logger && typeof (logger as PinoLike).child === 'function' && HOOKS in (logger as object);
}

export function serializeError(value: unknown): unknown {
  if (value instanceof Error) return sanitizeValue(value);
  return typeof value === 'string' ? sanitizeText(value) : sanitizeValue(value);
}

function requestSerializer(parent: Serializer | undefined): Serializer {
  return (req: unknown) => {
    let out: unknown;
    try {
      out = parent ? parent(req) : req;
      if (!out || typeof out !== 'object') return out;
      const record = out as Record<string, unknown>;
      return { ...record, url: sanitizeUrl(record['url']) };
    } catch {
      return UNSERIALIZABLE;
    }
  };
}

/** Sanitiza os argumentos de uma chamada `log.info(obj?, msg?, ...args)`. Nunca lança. */
export function sanitizeLogArgs(args: unknown[]): unknown[] {
  try {
    const [first, ...rest] = args;
    const out: unknown[] = [];
    if (first instanceof Error) {
      // pino usaria err.message cru como mensagem: entrega a mensagem já sanitizada.
      out.push({ err: first }, typeof rest[0] === 'string' ? sanitizeText(rest[0]) : sanitizeText(first.message));
      for (const arg of rest.slice(1)) out.push(typeof arg === 'string' ? sanitizeText(arg) : sanitizeValue(arg));
      return out;
    }
    if (first !== null && typeof first === 'object') {
      const obj = sanitizeLogObject(first as Record<string, unknown>, SERIALIZED_KEYS);
      out.push(obj);
      const err = (first as { err?: unknown }).err;
      if (rest.length === 0 && err instanceof Error) out.push(sanitizeText(err.message));
    } else {
      out.push(typeof first === 'string' ? sanitizeText(first) : first);
    }
    for (const arg of rest) out.push(typeof arg === 'string' ? sanitizeText(arg) : sanitizeValue(arg));
    return out;
  } catch {
    return [UNSERIALIZABLE];
  }
}

function makeLogMethod(previous: LogMethodHook | undefined): LogMethodHook {
  return function logMethod(this: unknown, args, method, level) {
    const clean = sanitizeLogArgs(args);
    if (previous) return previous.call(this, clean, method, level);
    return method.apply(this, clean);
  };
}

const cache = new WeakMap<object, PinoLike>();

/**
 * Filho sanitizado de `base`. Logger que não é pino (ex.: Fastify com `logger: false`) volta
 * como veio. Cacheado por `base`.
 */
export function createSanitizedLogger<L>(base: L): L {
  if (!isPino(base)) return base;
  const cached = cache.get(base);
  if (cached) return cached as unknown as L;
  const parentSerializers = (base[SERIALIZERS] ?? {}) as Record<string, Serializer | undefined>;
  const child = base.child(
    {},
    {
      redact: { paths: [...REDACT_PATHS], censor: REDACTED },
      serializers: { err: serializeError, req: requestSerializer(parentSerializers['req']) },
    },
  );
  const hooks = (child[HOOKS] ?? {}) as { logMethod?: LogMethodHook };
  child[HOOKS] = { ...hooks, logMethod: makeLogMethod(hooks.logMethod) };
  // O pino liga o hook aos métodos de nível em setLevel: reatribuir o nível regenera os métodos.
  // eslint-disable-next-line no-self-assign
  child.level = child.level;
  cache.set(base, child);
  return child as unknown as L;
}

/**
 * Logger "de contexto" (worker): dentro de um contexto de correlação delega ao logger do
 * contexto (filho sanitizado com `correlationId`); fora dele delega ao `root`, sem nenhuma
 * diferença na saída. Nenhuma opção do `root` muda.
 */
export function createContextLogger<L extends object>(root: L): L {
  return new Proxy(root, {
    get(target, prop) {
      const contextual = getCorrelationContext()?.logger;
      const active = (contextual && typeof contextual === 'object' ? contextual : target) as Record<PropertyKey, unknown>;
      const value = Reflect.get(active, prop, active);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(active) : value;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value);
    },
  });
}
