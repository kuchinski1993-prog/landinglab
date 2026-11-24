// Acuse-recebimento determinístico — TrustShield Fase 1 (Atlas).
//
// RÉGUA: comunica (confirma recebimento, pede info se necessário, escala
// para humano), NUNCA decide dinheiro. Ack é a exceção ao shadow mode
// porque é 100% determinístico e não faz promessa — silêncio é o gatilho
// documentado de chargeback (Gorgias/Zendesk industry consensus).
//
// Este módulo é PURO (sem I/O). O caller (analyze-inbound.processor)
// decide se enfileira e faz o UPDATE do lock idempotente.

/**
 * Categorias que SEMPRE recebem ack quando o email é legítimo.
 * Escolha explícita do dono: TODO contato de cliente = ack, exceto
 * suspicious_claim (vetor phishing/spoof) e não-atendimento (spam,
 * transactional de sistema, thank_you_closed).
 */
export const ACK_WORTHY_CATEGORIES: readonly string[] = [
  'refund_request',
  'exchange_request',
  'order_status',
  'delivery_problem',
  'complaint_general',
  'policy_question',
  'product_question_pre_purchase',
  'chargeback_threat', // ack seguro; NUNCA discute mérito; escala + notifica
  'unclear', // dúvida = merece resposta educada
] as const;

/**
 * Categorias que NUNCA recebem ack (não é atendimento de cliente).
 */
export const ACK_EXCLUDED_CATEGORIES: readonly string[] = [
  'spam_commercial',
  'thank_you_closed',
  'system_transactional', // notificação de sistema (Shopify, Stripe...)
] as const;

export interface ShouldAckInput {
  category: string | null;
  verification: string | null; // verified_match, verified_via_order, unknown_sender, suspicious_claim
  status: string; // received, pending_human, spam_auto, spam_confirmed, auto_filtered, etc.
  acknowledgementSentAt: Date | null;
  automationEnabled: boolean;
  acknowledgementAlwaysOn: boolean;
}

export type ShouldAckReason =
  | 'ok'
  | 'already_sent'
  | 'suspicious_claim'
  | 'not_ack_worthy'
  | 'excluded_category'
  | 'excluded_status'
  | 'automation_off'; // só quando ack_always_on também está off

export interface ShouldAckResult {
  send: boolean;
  reason: ShouldAckReason;
}

/**
 * Decide se um ack determinístico deve ser enfileirado agora.
 * Regras (avaliação em ordem):
 *   1. Se já foi enviado (acknowledgementSentAt !== null) → não envia
 *   2. Se suspicious_claim → NUNCA envia (vetor phishing)
 *   3. Se status é terminal-lixo (spam_confirmed, auto_filtered,
 *      auto_quarantined, system_transactional) → não envia
 *   4. Se category está em EXCLUDED → não envia
 *   5. Se category NÃO está em ACK_WORTHY → não envia
 *   6. Se automation e ack_always_on ambos off → não envia (dono desligou tudo)
 *   7. Envia.
 */
export function shouldSendAcknowledgement(input: ShouldAckInput): ShouldAckResult {
  if (input.acknowledgementSentAt !== null) {
    return { send: false, reason: 'already_sent' };
  }
  if (input.verification === 'suspicious_claim') {
    return { send: false, reason: 'suspicious_claim' };
  }
  const excludedStatuses = new Set([
    'spam_confirmed',
    'auto_filtered',
    'auto_quarantined',
    'system_transactional',
  ]);
  if (excludedStatuses.has(input.status)) {
    return { send: false, reason: 'excluded_status' };
  }
  const cat = input.category ?? 'unclear';
  if (ACK_EXCLUDED_CATEGORIES.includes(cat)) {
    return { send: false, reason: 'excluded_category' };
  }
  if (!ACK_WORTHY_CATEGORIES.includes(cat)) {
    return { send: false, reason: 'not_ack_worthy' };
  }
  if (!input.automationEnabled && !input.acknowledgementAlwaysOn) {
    return { send: false, reason: 'automation_off' };
  }
  return { send: true, reason: 'ok' };
}

// ── Rendering ────────────────────────────────────────────────────────────

export interface RenderAckInput {
  category: string;
  verification: string; // verified_match | verified_via_order | unknown_sender
  customerFirstName: string | null;
  orderNumber: string | null; // preenchido quando verified_* e orderId conhecido
  brand: { name: string; supportEmail: string; postalAddress: string };
  slaWindow: string; // ex.: '1 business day'
  /**
   * Ponto de extensão: quando o dono publicar a política de reembolso
   * e/ou portal, passar aqui e o wording usa. Se null, o ack NÃO menciona
   * link (fica limpo).
   */
  policyUrl?: string | null;
  portalUrl?: string | null;
  /**
   * Story 17.6c · idioma da loja. Ausente/`en-GB` = texto de hoje (inglês UK); `pt-BR` = textos
   * próprios, mesma estrutura e mesmas regras (nunca promete dinheiro).
   */
  language?: 'en-GB' | 'pt-BR';
  /** Story 17.6c · assinatura da loja no fecho. Ausente = "The {brand} team" (hoje). */
  signature?: string | null;
}

export interface RenderedAck {
  subject: string;
  textBody: string;
  htmlBody: string;
  /**
   * Motivos internos (não vão pro cliente) — usado em Dev Notes e
   * inbound_ai_actions.error/context.
   */
  internalNotes: string;
}

/**
 * Renderiza subject + body do ack (inglês UK, honesto, não decide $).
 * Determinístico: mesmo input → mesmo output. Sem chamadas de rede.
 *
 * Se o guard reprovar, caller usa `defaultSafeAck` (também aqui).
 */
export function renderAcknowledgement(input: RenderAckInput): RenderedAck {
  if (input.language === 'pt-BR') return renderAcknowledgementPtBr(input);
  const firstName = (input.customerFirstName ?? '').trim() || 'there';
  const brand = input.brand.name;
  const isVerified =
    input.verification === 'verified_match' ||
    input.verification === 'verified_via_order';
  const orderRef = input.orderNumber ? `#${input.orderNumber}` : null;

  // Contextual subject
  let subject: string;
  if (orderRef) {
    subject = `We've received your message about order ${orderRef}`;
  } else {
    subject = `We've received your message`;
  }

  // Contextual opening + body
  const lines: string[] = [];
  lines.push(`Hello ${firstName},`);
  lines.push('');

  if (isVerified && orderRef) {
    lines.push(
      `Thank you for getting in touch about order ${orderRef}. We've received your message and our team will review it and get back to you within ${input.slaWindow} (Monday to Friday, 9am–6pm GMT).`,
    );
  } else if (isVerified) {
    lines.push(
      `Thank you for getting in touch. We've received your message and our team will review it and get back to you within ${input.slaWindow} (Monday to Friday, 9am–6pm GMT).`,
    );
  } else {
    // unknown_sender: pede order number + confirmação de email do checkout
    lines.push(
      `Thank you for getting in touch. We've received your message and our team will review it and get back to you within ${input.slaWindow} (Monday to Friday, 9am–6pm GMT).`,
    );
    lines.push('');
    lines.push(
      `To help us look into this as quickly as possible, please reply with:`,
    );
    lines.push(`• Your order number (if you haven't already included it)`);
    lines.push(`• The email address you used at checkout, if different from this one`);
  }

  // Category-specific note (honesto — nunca decide dinheiro).
  if (input.category === 'refund_request') {
    lines.push('');
    lines.push(
      `Your refund request has been recorded and will be reviewed by a member of our team. Refund decisions are made individually — we'll confirm the outcome in a follow-up email within ${input.slaWindow}.`,
    );
  } else if (input.category === 'chargeback_threat') {
    lines.push('');
    lines.push(
      `We take payment concerns seriously. A member of our team will follow up directly within 1 business day. Simply reply to this email if you have any additional information to share.`,
    );
  } else if (input.category === 'delivery_problem') {
    lines.push('');
    lines.push(
      `We're sorry to hear there's an issue with delivery. Our team will look into the carrier information and get back to you shortly.`,
    );
  } else if (input.category === 'exchange_request') {
    lines.push('');
    lines.push(
      `Your exchange request has been recorded and our team will confirm the next steps within ${input.slaWindow}.`,
    );
  }

  // Ponto de extensão: policy/portal URLs. Quando o dono publicar as
  // políticas, o caller passa aqui e o wording usa. Sem eles, ficamos
  // limpos (sem link quebrado, sem promessa).
  // TODO(policy-url): quando existir página real de política de reembolso,
  //   passar via policyUrl e o texto abaixo será renderizado.
  if (input.policyUrl) {
    lines.push('');
    lines.push(`Our returns and refunds policy is available here: ${input.policyUrl}`);
  }
  // TODO(portal-url): quando existir portal de tickets, passar via portalUrl.
  if (input.portalUrl) {
    lines.push('');
    lines.push(`You can also track this request in our support portal: ${input.portalUrl}`);
  }

  lines.push('');
  lines.push(`Kind regards,`);
  lines.push(input.signature ? input.signature : `The ${brand} team`);

  const textBody = lines.join('\n');
  const htmlBody = textToHtml(textBody, input.brand);
  const internalNotes =
    `Deterministic acknowledgement. category=${input.category}, ` +
    `verification=${input.verification}, orderRef=${orderRef ?? 'none'}, ` +
    `policyUrl=${input.policyUrl ? 'set' : 'none'}, portalUrl=${input.portalUrl ? 'set' : 'none'}`;

  return { subject, textBody, htmlBody, internalNotes };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function textToHtml(text: string, brand: { name: string; supportEmail: string; postalAddress: string }): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').map(escapeHtml);
      // preserva quebras via <br>
      return `<p style="font-size:15px;line-height:1.55;color:#3b3d40;margin:0 0 12px 0;">${lines.join('<br>')}</p>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en-GB">
<head><meta charset="UTF-8"><meta name="color-scheme" content="light dark"></head>
<body style="margin:0;padding:0;background:#f6f6f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f7;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">
      <tr><td style="padding:32px;">${paragraphs}</td></tr>
      <tr><td style="padding:0 32px 32px 32px;text-align:center;font-size:12px;color:#6d7175;line-height:1.6;">
        <div style="border-top:1px solid #e1e3e5;padding-top:16px;">
          Questions? Reply to this email or write to <a href="mailto:${brand.supportEmail}" style="color:#6d7175;">${brand.supportEmail}</a>.<br>
          Can't find our emails? Check your spam folder and add us to your contacts.<br><br>
          ${brand.name} · ${brand.postalAddress}
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ── Story 17.6c · ack em pt-BR ───────────────────────────────────────────
// Mesma estrutura e mesmas regras do texto em inglês (confirma recebimento, pede o número do
// pedido quando o remetente é desconhecido, nunca decide nem promete dinheiro). Rascunho a revisar
// pelo owner (pendência P2 da story).

function renderAcknowledgementPtBr(input: RenderAckInput): RenderedAck {
  const firstName = (input.customerFirstName ?? '').trim();
  const brand = input.brand.name;
  const sla = input.slaWindow;
  const isVerified =
    input.verification === 'verified_match' ||
    input.verification === 'verified_via_order';
  const orderRef = input.orderNumber ? `#${input.orderNumber}` : null;

  const subject = orderRef
    ? `Recebemos sua mensagem sobre o pedido ${orderRef}`
    : `Recebemos sua mensagem`;

  const received = `Recebemos sua mensagem e nossa equipe vai analisá-la e responder em até ${sla} (de segunda a sexta, em horário comercial).`;
  const lines: string[] = [];
  lines.push(firstName ? `Olá, ${firstName},` : `Olá,`);
  lines.push('');
  if (isVerified && orderRef) {
    lines.push(`Obrigado por entrar em contato sobre o pedido ${orderRef}. ${received}`);
  } else if (isVerified) {
    lines.push(`Obrigado por entrar em contato. ${received}`);
  } else {
    lines.push(`Obrigado por entrar em contato. ${received}`);
    lines.push('');
    lines.push(`Para analisarmos o seu caso o mais rápido possível, responda a este e-mail com:`);
    lines.push(`• O número do seu pedido (se ainda não o incluiu)`);
    lines.push(`• O e-mail usado na compra, se for diferente deste`);
  }

  if (input.category === 'refund_request') {
    lines.push('');
    lines.push(
      `Seu pedido de reembolso foi registrado e será analisado por um membro da nossa equipe. As decisões de reembolso são tomadas caso a caso — confirmaremos o resultado em um próximo e-mail em até ${sla}.`,
    );
  } else if (input.category === 'chargeback_threat') {
    lines.push('');
    lines.push(
      `Levamos a sério qualquer preocupação com pagamentos. Um membro da nossa equipe vai retornar diretamente em até ${sla}. Basta responder a este e-mail se tiver mais informações para compartilhar.`,
    );
  } else if (input.category === 'delivery_problem') {
    lines.push('');
    lines.push(
      `Sentimos muito pelo problema com a entrega. Nossa equipe vai verificar as informações da transportadora e retornará em breve.`,
    );
  } else if (input.category === 'exchange_request') {
    lines.push('');
    lines.push(`Seu pedido de troca foi registrado e nossa equipe vai confirmar os próximos passos em até ${sla}.`);
  }

  if (input.policyUrl) {
    lines.push('');
    lines.push(`Nossa política de trocas e reembolsos está disponível aqui: ${input.policyUrl}`);
  }
  if (input.portalUrl) {
    lines.push('');
    lines.push(`Você também pode acompanhar esta solicitação no nosso portal de atendimento: ${input.portalUrl}`);
  }

  lines.push('');
  lines.push(`Atenciosamente,`);
  lines.push(input.signature ? input.signature : `Equipe ${brand}`);

  const textBody = lines.join('\n');
  const htmlBody = textToHtmlPtBr(textBody, input.brand);
  const internalNotes =
    `Deterministic acknowledgement. language=pt-BR, category=${input.category}, ` +
    `verification=${input.verification}, orderRef=${orderRef ?? 'none'}, ` +
    `policyUrl=${input.policyUrl ? 'set' : 'none'}, portalUrl=${input.portalUrl ? 'set' : 'none'}`;

  return { subject, textBody, htmlBody, internalNotes };
}

function textToHtmlPtBr(text: string, brand: { name: string; supportEmail: string; postalAddress: string }): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').map(escapeHtml);
      return `<p style="font-size:15px;line-height:1.55;color:#3b3d40;margin:0 0 12px 0;">${lines.join('<br>')}</p>`;
    })
    .join('');
  const email = escapeHtml(brand.supportEmail);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="color-scheme" content="light dark"></head>
<body style="margin:0;padding:0;background:#f6f6f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f7;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">
      <tr><td style="padding:32px;">${paragraphs}</td></tr>
      <tr><td style="padding:0 32px 32px 32px;text-align:center;font-size:12px;color:#6d7175;line-height:1.6;">
        <div style="border-top:1px solid #e1e3e5;padding-top:16px;">
          Dúvidas? Responda a este e-mail ou escreva para <a href="mailto:${email}" style="color:#6d7175;">${email}</a>.<br>
          Não encontrou nossos e-mails? Verifique a pasta de spam e adicione-nos aos seus contatos.<br><br>
          ${escapeHtml(brand.name)} · ${escapeHtml(brand.postalAddress)}
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}
