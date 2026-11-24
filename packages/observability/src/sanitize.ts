// Story 18.4 · Sanitização de logs — lista ÚNICA de campos redigidos e padrões de segredo.
// Para adicionar um segredo novo: inclua o campo em REDACTED_KEYS ou o padrão em SECRET_PATTERNS
// e um caso em src/__tests__/sanitize.test.ts (com um texto parecido que NÃO deve ser mascarado).
// Nunca lança: valor que não dá para ler vira '[unserializable]'.

export const REDACTED = '[REDACTED]';
export const UNSERIALIZABLE = '[unserializable]';
export const TRUNCATED_SUFFIX = '…[truncated]';

/** Limite por campo de texto livre (2 KB). */
export const MAX_FIELD_LENGTH = 2048;
/** Profundidade máxima percorrida em objetos aninhados. */
export const MAX_DEPTH = 6;
const MAX_KEYS = 100;
const MAX_ITEMS = 100;

/**
 * Campos cujo VALOR nunca vai para o log (comparação sem maiúsculas, `-` e `_`):
 * `x-api-key`, `X_API_KEY` e `xApiKey` caem na mesma entrada.
 */
export const REDACTED_KEYS: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-shopify-hmac-sha256',
  'stripe-signature',
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

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

const REDACTED_KEY_SET = new Set(REDACTED_KEYS.map(normalizeKey));

/**
 * Palavras que, em qualquer posição do nome da chave (camelCase, snake_case, kebab-case), fazem o
 * valor ser redigido: `sessionToken`, `webhookSecret`, `passwordHash`, `db_password`, `authCookie`…
 */
export const REDACTED_KEY_WORDS: readonly string[] = [
  'token',
  'tokens',
  'secret',
  'secrets',
  'password',
  'passwd',
  'passphrase',
  'authorization',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'session',
  'signature',
];

/** Pares de palavras consecutivas redigidos: `apiKey`, `x-api-key`, `privateKey`, `secretKey`, `sessionId`… */
export const REDACTED_KEY_PAIRS: readonly (readonly [string, string])[] = [
  ['api', 'key'],
  ['private', 'key'],
  ['access', 'key'],
  ['signing', 'key'],
  ['encryption', 'key'],
  ['session', 'id'],
  ['encrypted', 'value'],
];

/**
 * Não redige quando o nome descreve um METADADO do segredo, não o segredo: última palavra de
 * medida (`tokenCount`, `tokensUsed`, `passwordLength`, `sessionTtl`) ou primeira palavra de
 * predicado (`hasSignature`, `isSecret`). Decisão (QA 18.4 SEC-002): `tokensCount` NÃO é redigido.
 */
const METADATA_LAST_WORDS = new Set(['count', 'counts', 'total', 'used', 'limit', 'length', 'size', 'max', 'min', 'remaining', 'ttl', 'type', 'expires', 'expiry', 'expired', 'at', 'ms', 'present', 'configured', 'set', 'missing', 'ok', 'valid', 'source']);
const PREDICATE_FIRST_WORDS = new Set(['has', 'is', 'should', 'can', 'with', 'without', 'no']);

const KEY_WORD_SET = new Set(REDACTED_KEY_WORDS);
const KEY_CACHE_MAX = 2000;
const keyCache = new Map<string, boolean>();

export function splitKeyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function computeRedacted(key: string): boolean {
  if (REDACTED_KEY_SET.has(normalizeKey(key))) return true;
  const words = splitKeyWords(key);
  if (words.length === 0) return false;
  if (words.length > 1 && (PREDICATE_FIRST_WORDS.has(words[0]!) || METADATA_LAST_WORDS.has(words[words.length - 1]!))) return false;
  if (words.some((w) => KEY_WORD_SET.has(w))) return true;
  for (let i = 0; i < words.length - 1; i++) {
    for (const [a, b] of REDACTED_KEY_PAIRS) if (words[i] === a && words[i + 1] === b) return true;
  }
  return false;
}

/** Nome exato da lista OU palavra/par sensível no nome (sem os metadados acima). Cacheado. */
export function isRedactedKey(key: string): boolean {
  const cached = keyCache.get(key);
  if (cached !== undefined) return cached;
  const result = computeRedacted(key);
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.clear();
  keyCache.set(key, result);
  return result;
}

export interface SecretPattern {
  name: string;
  pattern: RegExp;
  replace: string;
}

/** Padrões mascarados em texto livre. Ordem importa: credenciais em URL antes de e-mail. */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'connection-string', pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^:/\s@]+):([^@\s/]+)@/gi, replace: `$1$2:${REDACTED}@` },
  { name: 'bearer', pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, replace: `$1 ${REDACTED}` },
  { name: 'stripe-key', pattern: /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]+/g, replace: `$1_$2_${REDACTED}` },
  { name: 'stripe-webhook-secret', pattern: /\bwhsec_[A-Za-z0-9]+/g, replace: `whsec_${REDACTED}` },
  { name: 'stripe-client-secret', pattern: /\bpi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g, replace: `pi_${REDACTED}` },
  { name: 'shopify-token', pattern: /\bshp(at|ss|ca|pa)_[A-Za-z0-9]+/g, replace: `shp$1_${REDACTED}` },
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]+/g, replace: `sk-ant-${REDACTED}` },
  { name: 'resend-key', pattern: /\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9_]{6,}|\bre_[A-Za-z0-9]{20,}/g, replace: `re_${REDACTED}` },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replace: REDACTED },
  { name: 'meta-token', pattern: /\bEAA[A-Za-z0-9]{20,}/g, replace: `EAA${REDACTED}` },
  { name: 'query-value', pattern: /([?&][A-Za-z0-9_.[\]-]+=)[^&#\s"']*/g, replace: `$1${REDACTED}` },
  {
    name: 'email',
    pattern: /\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9])[A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.([A-Za-z]{2,})\b/g,
    replace: '$1***@$2***.$3',
  },
  { name: 'phone-intl', pattern: /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,5}){2,4}/g, replace: '[phone]' },
  { name: 'phone-br', pattern: /\(\d{2}\)\s?9?\d{4}-?\d{4}/g, replace: '[phone]' },
];

/** Mascara padrões de segredo e corta em `max` caracteres. */
export function sanitizeText(text: string, max = MAX_FIELD_LENGTH): string {
  const truncated = text.length > max;
  let out = truncated ? text.slice(0, max) : text;
  for (const { pattern, replace } of SECRET_PATTERNS) out = out.replace(pattern, replace);
  return truncated ? `${out}${TRUNCATED_SUFFIX}` : out;
}

/** URL sem valores de query (`/x?email=a@b.com` → `/x?email=[REDACTED]`) e sem segredos no caminho. */
export function sanitizeUrl(url: unknown): unknown {
  return typeof url === 'string' ? sanitizeText(url) : url;
}

function sanitizeError(error: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: safeRead(() => error.constructor?.name) ?? error.name,
    message: sanitizeText(String(safeRead(() => error.message) ?? '')),
  };
  const stack = safeRead(() => error.stack);
  if (typeof stack === 'string') out['stack'] = sanitizeText(stack, MAX_FIELD_LENGTH * 2);
  for (const key of Object.keys(error).slice(0, MAX_KEYS)) {
    if (key === 'message' || key === 'stack') continue;
    out[key] = sanitizeEntry(key, () => (error as unknown as Record<string, unknown>)[key], depth, seen);
  }
  const cause = safeRead(() => (error as { cause?: unknown }).cause);
  if (cause !== undefined) out['cause'] = sanitizeValueAt(cause, depth + 1, seen);
  return out;
}

function safeRead<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function sanitizeEntry(key: string, read: () => unknown, depth: number, seen: WeakSet<object>): unknown {
  if (isRedactedKey(key)) return REDACTED;
  let value: unknown;
  try {
    value = read();
  } catch {
    return UNSERIALIZABLE;
  }
  return sanitizeValueAt(value, depth + 1, seen);
}

function sanitizeValueAt(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  try {
    switch (typeof value) {
      case 'string':
        return sanitizeText(value);
      case 'number':
      case 'boolean':
      case 'undefined':
        return value;
      case 'bigint':
        return value.toString();
      case 'symbol':
        return value.toString();
      case 'function':
        return '[function]';
      default:
        break;
    }
    if (value === null) return null;
    const obj = value as object;
    if (seen.has(obj)) return '[circular]';
    if (depth > MAX_DEPTH) return '[depth]';
    if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString();
    if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return `[binary ${obj.byteLength} bytes]`;
    if (obj instanceof Map || obj instanceof Set) return `[${obj.constructor.name} ${obj.size}]`;
    seen.add(obj);
    try {
      if (obj instanceof Error) return sanitizeError(obj, depth, seen);
      if (Array.isArray(obj)) {
        const items = obj.slice(0, MAX_ITEMS).map((item) => sanitizeValueAt(item, depth + 1, seen));
        if (obj.length > MAX_ITEMS) items.push(`[+${obj.length - MAX_ITEMS} items]`);
        return items;
      }
      const out: Record<string, unknown> = {};
      const keys = Object.keys(obj);
      for (const key of keys.slice(0, MAX_KEYS)) {
        out[key] = sanitizeEntry(key, () => (obj as Record<string, unknown>)[key], depth, seen);
      }
      if (keys.length > MAX_KEYS) out['…'] = `[+${keys.length - MAX_KEYS} keys]`;
      return out;
    } finally {
      seen.delete(obj);
    }
  } catch {
    return UNSERIALIZABLE;
  }
}

/** Cópia sanitizada de qualquer valor: campos redigidos, padrões mascarados, limites aplicados. */
export function sanitizeValue(value: unknown): unknown {
  return sanitizeValueAt(value, 0, new WeakSet());
}

/** Sanitiza as chaves de primeiro nível de um objeto de log; `skip` fica para os serializers. */
export function sanitizeLogObject(obj: Record<string, unknown>, skip: ReadonlySet<string>): Record<string, unknown> {
  const seen = new WeakSet<object>([obj]);
  const out: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(obj);
  } catch {
    return { log: UNSERIALIZABLE };
  }
  for (const key of keys) {
    if (skip.has(key)) {
      const value = safeRead(() => obj[key]);
      out[key] = value;
      continue;
    }
    out[key] = sanitizeEntry(key, () => obj[key], 0, seen);
  }
  return out;
}
