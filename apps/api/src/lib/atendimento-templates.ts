// Story 17.6c · Modelos iniciais de e-mail de REEMBOLSO por loja e idioma (Decisão 8).
//
// en-GB = DEFAULT_TEMPLATES de scripts/seed-email-templates.ts (importado; o script não muda) com o
// cabeçalho e a assinatura da LOJA no lugar da logo/nome da AuthenLondon. pt-BR = conjunto novo
// (rascunho a revisar pelo owner — pendência P2 da story). Modelos de pedido ficam fora (17.9).
import type { AtendimentoLanguage } from '@blackshop/shared';

import { DEFAULT_TEMPLATES, LOGO_HEADER, type TemplateRow } from '../scripts/seed-email-templates.js';

export const REFUND_TEMPLATE_KEYS = ['refund_requested', 'refund_approved', 'refund_rejected', 'refund_status_update'] as const;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Cabeçalho com o NOME da loja (texto) — nunca a logo da AuthenLondon. */
function storeHeader(brandName: string): string {
  return `<div style="text-align:center; padding:16px 0 24px; font-size:22px; font-weight:600; letter-spacing:0.02em;">${escapeHtml(brandName)}</div>`;
}

const BODY_OPEN = (lang: string) => `<!doctype html>
<html lang="${lang}">
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px;">`;
const BUTTON = (label: string) =>
  `<p><a href="{{tracking_url}}" style="display: inline-block; background: #000; color: #fff; padding: 10px 18px; text-decoration: none; border-radius: 4px;">${label}</a></p>`;
const FOOTER = (ref: string) => `  <hr style="border: 0; border-top: 1px solid #e5e5e5; margin: 24px 0;" />
  <p style="font-size: 12px; color: #666;">${ref}: {{ticket_id}}</p>
</body>
</html>`;

function ptBrTemplates(brandName: string): TemplateRow[] {
  const header = storeHeader(brandName);
  const sign = `<p>— Equipe ${escapeHtml(brandName)}</p>`;
  return [
    {
      eventKey: 'refund_requested',
      subject: `Recebemos a sua solicitação — pedido #{{order_number}}`,
      htmlBody: `${BODY_OPEN('pt-BR')}
  ${header}
  <p>Olá, {{customer_name}},</p>
  <p>Obrigado por entrar em contato sobre o pedido <strong>#{{order_number}}</strong>. Recebemos a sua solicitação e um membro da nossa equipe vai analisá-la em breve.</p>
  <p>Vamos mantê-lo informado por e-mail. Você também pode acompanhar o andamento a qualquer momento:</p>
  ${BUTTON('Acompanhar solicitação')}
  <p>Se quiser acrescentar alguma informação, basta responder a este e-mail.</p>
  ${sign}
${FOOTER('Referência')}`,
    },
    {
      eventKey: 'refund_approved',
      subject: `A sua solicitação foi aprovada — pedido #{{order_number}}`,
      htmlBody: `${BODY_OPEN('pt-BR')}
  ${header}
  <p>Olá, {{customer_name}},</p>
  <p>Boa notícia: a sua solicitação referente ao pedido <strong>#{{order_number}}</strong> foi aprovada.</p>
  <p>{{next_steps}}</p>
  <p>Depois que o reembolso for emitido pelo nosso meio de pagamento, o prazo para o valor aparecer na sua fatura ou conta depende do seu banco ou operadora do cartão.</p>
  ${BUTTON('Ver solicitação')}
  <p>Obrigado pela paciência.</p>
  ${sign}
${FOOTER('Referência')}`,
    },
    {
      eventKey: 'refund_rejected',
      subject: `Atualização sobre a sua solicitação — pedido #{{order_number}}`,
      htmlBody: `${BODY_OPEN('pt-BR')}
  ${header}
  <p>Olá, {{customer_name}},</p>
  <p>Analisamos a sua solicitação referente ao pedido <strong>#{{order_number}}</strong>. Depois de verificar os detalhes, não conseguimos aprová-la desta vez.</p>
  <p><strong>Motivo:</strong> {{reason}}</p>
  <p>Se acredita que a decisão deve ser revista, responda a este e-mail com qualquer informação adicional e analisaremos novamente.</p>
  ${BUTTON('Ver solicitação')}
  ${sign}
${FOOTER('Referência')}`,
    },
    {
      eventKey: 'refund_status_update',
      subject: `Nova atualização na sua solicitação — pedido #{{order_number}}`,
      htmlBody: `${BODY_OPEN('pt-BR')}
  ${header}
  <p>Olá, {{customer_name}},</p>
  <p>Há uma nova atualização na sua solicitação referente ao pedido <strong>#{{order_number}}</strong>:</p>
  <blockquote style="border-left: 3px solid #000; margin: 16px 0; padding: 4px 0 4px 12px; color: #333;">{{message}}</blockquote>
  ${BUTTON('Abrir a conversa')}
  ${sign}
${FOOTER('Referência')}`,
    },
  ];
}

function enGbTemplates(brandName: string): TemplateRow[] {
  const safe = escapeHtml(brandName);
  return DEFAULT_TEMPLATES.filter((t) => (REFUND_TEMPLATE_KEYS as readonly string[]).includes(t.eventKey)).map((t) => ({
    eventKey: t.eventKey,
    subject: t.subject.split('AuthenLondon').join(brandName),
    htmlBody: t.htmlBody.split(LOGO_HEADER).join(storeHeader(brandName)).split('AuthenLondon').join(safe),
  }));
}

/** Os 4 modelos de reembolso da loja no idioma pedido, com o nome da loja. */
export function buildRefundTemplates(language: AtendimentoLanguage, brandName: string): TemplateRow[] {
  return language === 'pt-BR' ? ptBrTemplates(brandName) : enGbTemplates(brandName);
}
