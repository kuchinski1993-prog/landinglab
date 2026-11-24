// Story 18.4 · Zonas protegidas (CLAUDE.md raiz) ficam FORA da observabilidade: sem header, sem
// campo de log, sem mascaramento novo, sem métrica, sem wrapper. Lista de EXCLUSÃO — revisada
// pelo owner no PR. Derivada dos registros em apps/api/src/server.ts:
//   Tracker — backend: routes/tracker/{campaigns,streams,clicks,access-rules}.routes.ts
//     (/admin/tracker/*) e routes/tracker/edge.routes.ts (/api/t/:slug);
//   TrustShield — responder clientes: inbound-email.routes.ts (/webhooks/email/inbound,
//     /inbound-emails), inbox.routes.ts e inbox-mail.routes.ts (/inbox/*), refunds.routes.ts
//     (/refunds/*, /storefront/refunds/* — enfileira os e-mails ao cliente),
//     automation-config.routes.ts (/automation-config — modo autônomo, auto-reply e acks),
//     notifications.routes.ts (/notifications — sino do TrustShield), email-templates.routes.ts
//     (/email-templates — modelos dos e-mails ao cliente, "TrustShield Fase 8") e portal.routes.ts
//     (/storefront/support — vira inbound_email + analyze-inbound; /storefront/orders/* — portal
//     do cliente). Postura conservadora (QA 18.4 ARCH-001): na dúvida sobre TrustShield, protegido.

export const PROTECTED_ROUTE_PREFIXES: readonly string[] = [
  '/admin/tracker',
  '/api/t',
  '/webhooks/email/inbound',
  '/inbound-emails',
  '/inbox',
  '/refunds',
  '/storefront/refunds',
  '/automation-config',
  '/notifications',
  '/email-templates',
  '/storefront/support',
  '/storefront/orders',
];

/** Mesma lista de `@blackshop/jobs/worker` (Story 18.3); um teste do worker garante a igualdade. */
export const PROTECTED_QUEUES: readonly string[] = ['email-queue', 'inbound-classify-queue', 'tracker-capi-queue'];

function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/** Casa por segmento: `/inbox` cobre `/inbox` e `/inbox/mail`, mas não `/inboxes`. */
export function isProtectedPath(url: string | undefined, prefixes: readonly string[] = PROTECTED_ROUTE_PREFIXES): boolean {
  if (!url) return false;
  const path = pathOf(url);
  for (const prefix of prefixes) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

export function isProtectedQueue(queue: string, queues: readonly string[] = PROTECTED_QUEUES): boolean {
  return queues.includes(queue);
}
