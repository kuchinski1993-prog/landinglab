// Story 22.1b (AC4, T1) — destino depois de entrar: só caminho interno do painel. Qualquer coisa
// que possa sair do domínio (esquema, `//host`, barra invertida, codificação disfarçada, controle)
// ou que volte para as telas de acesso vira `/`.

import { isAccessArea } from './public-routes';

export const DEFAULT_AFTER_LOGIN = '/';
export const CALLBACK_MAX_LENGTH = 512;

const BASE = 'http://painel.invalid';
// Controle C0/C1, espaço, DEL e separadores de linha/parágrafo Unicode (é exatamente o que se quer barrar).
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000- \u007f-\u009f\u2028\u2029]/;

/** Decodifica até estabilizar (no máx. 3 voltas); `null` se a codificação for inválida. */
function fullyDecoded(value: string): string | null {
  let current = value;
  for (let i = 0; i < 3; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

function looksHostile(value: string): boolean {
  if (!value.startsWith('/')) return true;
  if (value.startsWith('//') || value.includes('\\')) return true;
  return FORBIDDEN_CHARS.test(value);
}

export function safeCallbackUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '' || raw.length > CALLBACK_MAX_LENGTH) return DEFAULT_AFTER_LOGIN;
  if (looksHostile(raw)) return DEFAULT_AFTER_LOGIN;
  const decoded = fullyDecoded(raw);
  if (decoded === null || looksHostile(decoded)) return DEFAULT_AFTER_LOGIN;
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return DEFAULT_AFTER_LOGIN;
  }
  if (url.origin !== BASE) return DEFAULT_AFTER_LOGIN;
  const decodedPath = fullyDecoded(url.pathname);
  if (decodedPath === null || isAccessArea(url.pathname) || isAccessArea(decodedPath)) return DEFAULT_AFTER_LOGIN;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** `/login` com `callbackUrl` só quando o destino é diferente de `/`. */
export function loginUrlFor(path: string): string {
  const target = safeCallbackUrl(path);
  return target === DEFAULT_AFTER_LOGIN ? '/login' : `/login?callbackUrl=${encodeURIComponent(target)}`;
}
