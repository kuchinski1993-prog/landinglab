// Story 18.3 · Texto de erro seguro para o ledger (job_runs.last_error) e para logs.
// Nunca guarda e-mail, token ou segredo em query string; limite de 500 caracteres (CHECK da 0097).

export const LAST_ERROR_MAX = 500;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const AUTH_RE = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const SHOPIFY_TOKEN_RE = /\bshp(?:at|ca|pa|ss)_[A-Za-z0-9]+/g;
const SECRET_PARAM_RE = /([?&](?:access_token|api_key|apikey|token|key|secret|signature|sig|password)=)[^&\s"']+/gi;

export function sanitizeErrorText(text: string, max = LAST_ERROR_MAX): string {
  const clean = text
    .replace(EMAIL_RE, '[e-mail]')
    .replace(AUTH_RE, '$1 [redacted]')
    .replace(SHOPIFY_TOKEN_RE, '[token]')
    .replace(SECRET_PARAM_RE, '$1[redacted]');
  return clean.length > max ? clean.slice(0, max) : clean;
}

/** Mensagem de qualquer valor lançado (Error, string, objeto sem `message`, undefined). */
export function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message || value.name || 'Error';
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
    return 'objeto lançado sem message';
  }
  return String(value);
}
