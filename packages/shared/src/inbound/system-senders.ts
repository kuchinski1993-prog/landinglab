// Allowlist de remetentes transacionais legítimos.
//
// Emails de plataformas sobre a conta/pedidos/segurança NÃO são spam nem
// são atendimento de cliente — são notificações de sistema pro dono ver.
// Sem essa allowlist, o classificador IA tende a rotular email genérico
// "Verifique seu endereço" da Shopify como spam_commercial → status
// spam_auto → dono nunca vê. Caso real observado em staging.
//
// USO: prefilterInbound checa isTransactionalSender(from) antes de
// enfileirar pra classificação. Se casar, marca status='system_transactional'.

/** Domínios (e subdomínios) de plataformas cuja comunicação transacional é
 *  legítima por padrão. */
export const TRANSACTIONAL_DOMAINS: readonly string[] = [
  // Shopify (plataforma da loja) — usa vários subdomínios de mailer
  'shopify.com',
  'shopifyemail.com',
  'myshopify.com',
  'shopifysupport.com',
  // Payment gateways
  'stripe.com',
  'stripemail.com',
  'paypal.com',
  // Infra
  'cloudflare.com',
  // CRM/tracking transacional
  'klaviyo.com',
  'aftership.com',
  // Google Workspace (alerts de segurança da conta google do dono)
  'accounts.google.com',
  // GitHub (notificações de dev — dono pode receber)
  'github.com',
] as const;

/**
 * Retorna true quando o remetente pertence a uma plataforma cuja comunicação
 * transacional deve ser tratada como sistema (não spam, não atendimento).
 * Match por domínio exato ou subdomínio (mailer3.shopify.com casa shopify.com).
 */
export function isTransactionalSender(fromAddress: string | null | undefined): boolean {
  if (!fromAddress || typeof fromAddress !== 'string') return false;
  const at = fromAddress.lastIndexOf('@');
  if (at < 0) return false;
  const domain = fromAddress.slice(at + 1).trim().toLowerCase();
  if (!domain) return false;
  return TRANSACTIONAL_DOMAINS.some(
    (allow) => domain === allow || domain.endsWith('.' + allow),
  );
}
