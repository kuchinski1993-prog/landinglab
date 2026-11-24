// Story 22.1b (AC12/AC13) — telas de acesso abertas sem sessão. Lista ÚNICA usada pelo middleware
// (não redireciona para /login) e pelo apiClient (401 nessas telas não recarrega a página: o erro
// fica na tela). Comparação exata do caminho (barra final tolerada) — nada de prefixo solto.

export const LOGIN_PATH = '/login';
export const SIGNUP_PATH = '/login/criar-conta';
export const FORGOT_PATH = '/login/esqueci';
export const SET_PASSWORD_PATH = '/login/criar-senha';
export const EMERGENCY_PATH = '/login/emergencia';
/** Caminho do link enviado por e-mail pela API (22.1a, `PASSWORD_LINK_PATH`) — mesma tela de criar senha. */
export const EMAIL_LINK_PATH = '/criar-senha';

export const PUBLIC_ROUTES: readonly string[] = Object.freeze([
  LOGIN_PATH,
  SIGNUP_PATH,
  FORGOT_PATH,
  SET_PASSWORD_PATH,
  EMERGENCY_PATH,
  EMAIL_LINK_PATH,
]);

function normalize(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

export function isPublicRoute(pathname: string | null | undefined): boolean {
  if (typeof pathname !== 'string' || pathname === '') return false;
  return PUBLIC_ROUTES.includes(normalize(pathname));
}

/** Qualquer caminho da área de acesso (`/login`, `/login/*`, `/criar-senha*`) — nunca é destino pós-login. */
export function isAccessArea(pathname: string): boolean {
  const p = normalize(pathname.toLowerCase());
  return p === LOGIN_PATH || p.startsWith(`${LOGIN_PATH}/`) || p === EMAIL_LINK_PATH || p.startsWith(`${EMAIL_LINK_PATH}/`);
}
