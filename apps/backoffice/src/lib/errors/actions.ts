// Story 18.1b — ações de recuperação de erro decididas pelo `code` (e, sem código conhecido,
// pelo status HTTP). Os renderizadores (DS e legacy) só desenham o que `describeError` devolve.

/**
 * - `retry`  — "Tentar de novo" (só aparece se a tela passou `onRetry`)
 * - `reload` — "Recarregar" (`onReload` ou recarrega a página)
 * - `login`  — "Entrar de novo" (link para /login)
 * - `fix`    — corrigir campos: sem botão; a tela destaca os campos usando `details`
 * - `link`   — vai para outra tela (`href` + rótulo da tabela de links)
 * - `none`   — só a mensagem
 */
export type ErrorAction = 'retry' | 'reload' | 'login' | 'fix' | 'link' | 'none';

/** Destinos conhecidos das ações `link`. */
export type ErrorLinkTarget = 'domains' | 'checklist' | 'settings';

export interface ErrorLink {
  label: string;
  /** Sem `href` (ex.: checklist, que depende do funil aberto) a tela informa via `options.hrefs`. */
  href?: string;
}

export const ERROR_LINKS: Readonly<Record<ErrorLinkTarget, ErrorLink>> = {
  domains: { label: 'Gerenciar domínios', href: '/vsl/domains' },
  checklist: { label: 'Ver checklist' },
  settings: { label: 'Abrir configurações', href: '/settings' },
};

export const ACTION_LABELS = {
  retry: 'Tentar de novo',
  reload: 'Recarregar',
  login: 'Entrar de novo',
} as const;

export const LOGIN_HREF = '/login';

/** Dica acrescentada quando o erro pede para esperar antes de tentar de novo (429 / rate limit). */
export const WAIT_HINT = 'Aguarde alguns instantes antes de tentar de novo.';

export interface CodeAction {
  action: ErrorAction;
  link?: ErrorLinkTarget;
  /** A mensagem ganha a dica de esperar (`WAIT_HINT`). */
  wait?: boolean;
}

/** Ação por código, para códigos de qualquer módulo (vale mesmo sem mensagem própria na UI). */
export const CODE_ACTIONS: Readonly<Record<string, CodeAction>> = {
  validation_failed: { action: 'fix' },
  unauthorized: { action: 'login' },
  cross_site_rejected: { action: 'reload' },
  version_conflict: { action: 'reload' },
  constraint_conflict: { action: 'reload' },
  rate_limited: { action: 'retry', wait: true },
  internal_error: { action: 'retry' },
  service_unavailable: { action: 'retry' },
  UPSTREAM_TIMEOUT: { action: 'retry' },
  UPSTREAM_RATE_LIMITED: { action: 'retry', wait: true },
  domain_not_verified: { action: 'link', link: 'domains' },
  publish_check_failed: { action: 'link', link: 'checklist' },
};

/** Ação quando não há código conhecido: decide pelo status HTTP. */
export function actionForStatus(status: number): CodeAction {
  if (status === 401) return { action: 'login' };
  if (status === 409) return { action: 'reload' };
  if (status === 429) return { action: 'retry', wait: true };
  if (status >= 500) return { action: 'retry' };
  return { action: 'none' };
}
