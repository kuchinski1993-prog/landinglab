// Story 18.1b — regra única de "qual botão o banner de erro mostra", usada pelo banner do design system
// (components/ds/states.tsx; o visual em Polaris React da 18.1b saiu na 20.13a).

import { LOGIN_HREF } from './actions';
import { describeError, type DescribeErrorOptions, type ErrorInfo } from './describe';

export interface BannerCallbacks {
  onRetry?: () => void;
  onReload?: () => void;
}

export interface BannerRules {
  /**
   * Sem ação própria do erro, `onReload` vira "Recarregar" (regra da 20.1 no visual novo).
   * O legacy (VSL) usa `false`: lá "Recarregar" só aparece para erros que pedem recarregar.
   */
  reloadFallback: boolean;
}

export interface BannerLabels {
  retry: string;
  reload: string;
  login: string;
}

export interface BannerAction {
  label: string;
  onClick?: () => void;
  href?: string;
}

/** Story 18.11: repetir não resolve (sem permissão / método errado) — nenhum botão, nem com `onRetry`. */
const NO_RETRY_CODES: ReadonlySet<string> = new Set(['forbidden', 'method_not_allowed']);

function reloadPage(): void {
  if (typeof window !== 'undefined') window.location.reload();
}

/**
 * Botão do banner. Texto puro mantém a regra da 20.1 (onRetry → "Tentar de novo", senão onReload →
 * "Recarregar"). Erro: a ação vem de `describeError`; `retry` só com `onRetry` (nunca um botão que
 * não faz nada); sem ação própria, cai na regra antiga.
 */
export function bannerAction(
  info: ErrorInfo | null,
  { onRetry, onReload }: BannerCallbacks,
  labels: BannerLabels,
  rules: BannerRules = { reloadFallback: true },
): BannerAction | null {
  if (info?.action === 'reload') return { label: labels.reload, onClick: onReload ?? reloadPage };
  if (info?.action === 'login') return { label: labels.login, href: LOGIN_HREF };
  if (info?.action === 'link' && info.href && info.linkLabel) return { label: info.linkLabel, href: info.href };
  if (info && NO_RETRY_CODES.has(info.code)) return null;
  if (onRetry) return { label: labels.retry, onClick: onRetry };
  if (rules.reloadFallback && onReload && info?.action !== 'retry') return { label: labels.reload, onClick: onReload };
  return null;
}

/** Descreve o erro do banner: string não vazia é exibida como está (sem botão decidido por código). */
export function describeBannerError(
  error: unknown,
  options: DescribeErrorOptions,
): { message: string; info: ErrorInfo | null } {
  if (typeof error === 'string' && error.trim()) return { message: error, info: null };
  const info = describeError(error, options);
  return { message: info.message, info };
}
