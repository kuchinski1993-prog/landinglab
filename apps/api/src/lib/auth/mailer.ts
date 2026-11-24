// Story 22.1a-1 · AC20 (D11, A3/A7/A10) — remetente MÍNIMO dos e-mails de acesso.
//
// NÃO usa packages/email, send-email.processor, email-queue nem sendReply (zona protegida 1):
// chamada direta a POST https://api.resend.com/emails — mesmo padrão do adaptador do Suporte
// LandingLab (landing-support-resend-adapter.ts). Sem fila, SEM retry cego (envio não é
// idempotente: 429/5xx/timeout voltam como falha para o chamador mostrar ao owner).
//
// - Link SEMPRE de BACKOFFICE_URL (nunca de Host/Origin da requisição — A3); em produção exige https.
// - Sem remetente (AUTH_EMAIL_FROM), sem BACKOFFICE_URL válido ou sem chave no cofre ⇒
//   `not_configured` EXPLÍCITO. Mock só existe com NODE_ENV=test (A10: nunca silencioso).
// - Corpo: texto + HTML mínimo em pt-BR, assunto fixo, só o link — sem imagens nem rastreio.
// - Nada aqui loga; o resultado volta tipado e nunca contém token, link ou chave.
import { fetchWithTimeout, UpstreamTimeoutError } from '@blackshop/shared/http';

/** Chave do cofre (conta) — classificada em credentials-inventory.ts (17.3a). */
const AUTH_RESEND_VAULT_KEY = 'resend:api_key';
const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MS = 10_000;
export const PASSWORD_LINK_PATH = '/criar-senha';
/**
 * Story 22.1e · tela "Usuários → Pendentes" do painel (o painel usa `USERS_PATH` + `?aba=pendentes` —
 * teste de contrato em apps/backoffice). Constante: nada do solicitante entra no caminho nem na query.
 */
export const SIGNUP_REQUESTS_PATH = '/settings/conta/usuarios?aba=pendentes';

export type AuthMailKind = 'invite' | 'reset';

export type AuthMailMissing = 'from' | 'backoffice_url' | 'api_key';
export type AuthMailFailure = 'rate_limited' | 'rejected' | 'unavailable' | 'timeout' | 'network';

export type AuthMailResult =
  | { status: 'sent'; providerId: string | null }
  | { status: 'failed'; reason: AuthMailFailure; httpStatus: number | null }
  | { status: 'not_configured'; missing: AuthMailMissing[] };

export interface PasswordLinkMail {
  to: string;
  kind: AuthMailKind;
  /** Token em claro (só para montar o link; nunca gravado nem logado). */
  token: string;
  name?: string | null;
}

/** 22.1a-2 · D12 — aviso ao owner de que chegou uma solicitação de acesso (sem token, sem link de uso único). */
export interface SignupNoticeMail {
  /** Owner que recebe o aviso. */
  to: string;
  requesterName: string;
  requesterEmail: string;
}

export interface AuthMailer {
  sendPasswordLink(mail: PasswordLinkMail): Promise<AuthMailResult>;
  sendSignupNotice(mail: SignupNoticeMail): Promise<AuthMailResult>;
}

export interface VaultReader {
  getRaw(key: string): Promise<string | null>;
}

/** Lê a chave da conta Resend do cofre (nunca do env). */
export function loadAuthResendKey(vault: VaultReader): Promise<string | null> {
  return vault.getRaw(AUTH_RESEND_VAULT_KEY);
}

/**
 * Base do link a partir de BACKOFFICE_URL. `null` = inválida: não-http(s), com usuário/senha,
 * query/fragmento, ou http fora de `development`/`test`.
 */
export function resolveBackofficeBase(backofficeUrl: string | null | undefined, nodeEnv: string | undefined): string | null {
  if (!backofficeUrl || typeof backofficeUrl !== 'string') return null;
  let url: URL;
  try {
    url = new URL(backofficeUrl.trim());
  } catch {
    return null;
  }
  const httpAllowed = nodeEnv === 'development' || nodeEnv === 'test';
  if (url.protocol !== 'https:' && !(httpAllowed && url.protocol === 'http:')) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** `${BACKOFFICE_URL}/criar-senha?token=…` — `null` se a base for inválida. */
export function buildPasswordLink(backofficeUrl: string | null | undefined, token: string, nodeEnv: string | undefined): string | null {
  const base = resolveBackofficeBase(backofficeUrl, nodeEnv);
  if (!base) return null;
  return `${base}${PASSWORD_LINK_PATH}?token=${encodeURIComponent(token)}`;
}

/** 22.1e · `${BACKOFFICE_URL}/settings/conta/usuarios?aba=pendentes` — `null` se a base for inválida. */
export function buildSignupRequestsLink(backofficeUrl: string | null | undefined, nodeEnv: string | undefined): string | null {
  const base = resolveBackofficeBase(backofficeUrl, nodeEnv);
  return base ? `${base}${SIGNUP_REQUESTS_PATH}` : null;
}

const SUBJECTS: Readonly<Record<AuthMailKind, string>> = {
  invite: 'BlackShop — crie sua senha de acesso',
  reset: 'BlackShop — redefinição de senha',
};

const LINK_VALIDITY: Readonly<Record<AuthMailKind, string>> = {
  invite: 'O link vale por 48 horas e só pode ser usado uma vez.',
  reset: 'O link vale por 60 minutos e só pode ser usado uma vez.',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

export function renderPasswordEmail(kind: AuthMailKind, link: string, name?: string | null): { subject: string; text: string; html: string } {
  const cleanName = (name ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120);
  const greeting = cleanName ? `Olá, ${cleanName}.` : 'Olá.';
  const intro =
    kind === 'invite'
      ? 'Seu acesso ao painel da BlackShop foi aprovado. Para entrar, crie sua senha pelo link abaixo:'
      : 'Recebemos um pedido para redefinir a senha do seu acesso ao painel da BlackShop. Para criar uma nova senha, use o link abaixo:';
  const ignore = 'Se você não pediu isso, ignore este e-mail — nada muda na sua conta.';
  const text = [greeting, '', intro, link, '', LINK_VALIDITY[kind], ignore].join('\n');
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(intro)}</p>`,
    `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
    `<p>${escapeHtml(LINK_VALIDITY[kind])}<br>${escapeHtml(ignore)}</p>`,
  ].join('\n');
  return { subject: SUBJECTS[kind], text, html };
}
export const EMAIL_SHAPE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/** Aviso de nova solicitação (D12): nome e e-mail de quem pediu + link do painel. Assunto fixo. */
export function renderSignupNoticeEmail(
  requesterName: string,
  requesterEmail: string,
  panelUrl: string,
): { subject: string; text: string; html: string } {
  const name = requesterName.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120) || '(sem nome)';
  const email = requesterEmail.replace(/[\r\n\t\s]+/g, '').slice(0, 254);
  const intro = 'Chegou uma nova solicitação de acesso ao painel da BlackShop:';
  const action = 'Abra o painel para aprovar ou recusar. Ninguém entra sem a sua aprovação.';
  const text = ['Olá.', '', intro, `${name} <${email}>`, '', action, panelUrl].join('\n');
  const html = [
    '<p>Olá.</p>',
    `<p>${escapeHtml(intro)}</p>`,
    `<p><strong>${escapeHtml(name)}</strong> &lt;${escapeHtml(email)}&gt;</p>`,
    `<p>${escapeHtml(action)}<br><a href="${escapeHtml(panelUrl)}">${escapeHtml(panelUrl)}</a></p>`,
  ].join('\n');
  return { subject: 'BlackShop — nova solicitação de acesso', text, html };
}

export interface ResendAuthMailerOptions {
  nodeEnv: string | undefined;
  /** AUTH_EMAIL_FROM — domínio já verificado no Resend. */
  from: string | null | undefined;
  /** BACKOFFICE_URL. */
  backofficeUrl: string | null | undefined;
  /** Lê a chave do cofre (`loadAuthResendKey(vault)`). */
  loadApiKey: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createResendAuthMailer(opts: ResendAuthMailerOptions): AuthMailer {
  /** Pré-condições comuns; `link` = null ⇒ BACKOFFICE_URL inválida. */
  async function prepare(link: string | null): Promise<{ from: string; apiKey: string } | { missing: AuthMailMissing[] }> {
    const missing: AuthMailMissing[] = [];
    const from = typeof opts.from === 'string' ? opts.from.trim() : '';
    if (!from) missing.push('from');
    if (!link) missing.push('backoffice_url');
    let apiKey: string | null = null;
    try {
      apiKey = (await opts.loadApiKey())?.trim() || null;
    } catch {
      apiKey = null;
    }
    if (!apiKey) missing.push('api_key');
    if (missing.length > 0 || !apiKey) return { missing };
    return { from, apiKey };
  }

  async function deliver(
    from: string,
    apiKey: string,
    toRaw: string,
    content: { subject: string; text: string; html: string },
  ): Promise<AuthMailResult> {
    const to = toRaw.trim().toLowerCase();
    if (!EMAIL_SHAPE.test(to)) return { status: 'failed', reason: 'rejected', httpStatus: null };
    let res: Response;
    try {
      res = await fetchWithTimeout(
        RESEND_EMAILS_URL,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ from, to: [to], subject: content.subject, text: content.text, html: content.html }),
        },
        { timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, label: 'resend-auth', uncertain: true, fetchImpl: opts.fetchImpl },
      );
    } catch (err) {
      return { status: 'failed', reason: err instanceof UpstreamTimeoutError ? 'timeout' : 'network', httpStatus: null };
    }

    if (res.ok) {
      let providerId: string | null = null;
      try {
        const body = (await res.json()) as { id?: unknown };
        providerId = typeof body.id === 'string' ? body.id : null;
      } catch {
        providerId = null;
      }
      return { status: 'sent', providerId };
    }
    if (res.status === 429) return { status: 'failed', reason: 'rate_limited', httpStatus: 429 };
    if (res.status >= 500) return { status: 'failed', reason: 'unavailable', httpStatus: res.status };
    return { status: 'failed', reason: 'rejected', httpStatus: res.status };
  }

  return {
    async sendPasswordLink(mail) {
      const link = buildPasswordLink(opts.backofficeUrl, mail.token, opts.nodeEnv);
      const ready = await prepare(link);
      if ('missing' in ready || !link) return { status: 'not_configured', missing: 'missing' in ready ? ready.missing : ['backoffice_url'] };
      return deliver(ready.from, ready.apiKey, mail.to, renderPasswordEmail(mail.kind, link, mail.name));
    },

    async sendSignupNotice(mail) {
      const panel = buildSignupRequestsLink(opts.backofficeUrl, opts.nodeEnv);
      const ready = await prepare(panel);
      if ('missing' in ready || !panel) return { status: 'not_configured', missing: 'missing' in ready ? ready.missing : ['backoffice_url'] };
      return deliver(ready.from, ready.apiKey, mail.to, renderSignupNoticeEmail(mail.requesterName, mail.requesterEmail, panel));
    },
  };
}

export interface MockAuthMailer extends AuthMailer {
  readonly sent: Array<PasswordLinkMail & { link: string | null }>;
  readonly notices: SignupNoticeMail[];
  /** Próximo resultado (padrão: `sent`). */
  nextResult: AuthMailResult | null;
}

/** Mock SÓ em NODE_ENV=test (fora disso lança — nunca "enviei" sem enviar). */
export function createMockAuthMailer(opts: { nodeEnv?: string; backofficeUrl?: string } = {}): MockAuthMailer {
  const nodeEnv = opts.nodeEnv ?? process.env['NODE_ENV'];
  if (nodeEnv !== 'test') throw new Error('AuthMailer mock só existe com NODE_ENV=test');
  const backofficeUrl = opts.backofficeUrl ?? 'https://painel.test';
  const take = (): AuthMailResult => {
    const result = mock.nextResult ?? { status: 'sent', providerId: 'mock' };
    mock.nextResult = null;
    return result;
  };
  const mock: MockAuthMailer = {
    sent: [],
    notices: [],
    nextResult: null,
    async sendPasswordLink(mail) {
      const result = take();
      if (result.status === 'sent') mock.sent.push({ ...mail, link: buildPasswordLink(backofficeUrl, mail.token, nodeEnv) });
      return result;
    },
    async sendSignupNotice(mail) {
      const result = take();
      if (result.status === 'sent') mock.notices.push({ ...mail });
      return result;
    },
  };
  return mock;
}
