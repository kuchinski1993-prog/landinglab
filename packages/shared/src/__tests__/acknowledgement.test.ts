import { describe, expect, it } from 'vitest';

import {
  ACK_WORTHY_CATEGORIES,
  renderAcknowledgement,
  shouldSendAcknowledgement,
} from '../inbound/acknowledgement.js';

const baseInput = {
  automationEnabled: false,
  acknowledgementAlwaysOn: true,
  acknowledgementSentAt: null,
};

describe('shouldSendAcknowledgement — decisão', () => {
  it('refund_request verified_match, shadow ON: envia (exceção shadow)', () => {
    const r = shouldSendAcknowledgement({
      ...baseInput,
      category: 'refund_request',
      verification: 'verified_match',
      status: 'converted_to_refund',
    });
    expect(r.send).toBe(true);
    expect(r.reason).toBe('ok');
  });

  it('refund_request unknown_sender: envia (pede order_number no template)', () => {
    const r = shouldSendAcknowledgement({
      ...baseInput,
      category: 'refund_request',
      verification: 'unknown_sender',
      status: 'pending_human',
    });
    expect(r.send).toBe(true);
  });

  it('SUSPICIOUS_CLAIM nunca recebe ack (vetor phishing)', () => {
    const r = shouldSendAcknowledgement({
      ...baseInput,
      category: 'refund_request',
      verification: 'suspicious_claim',
      status: 'pending_human',
    });
    expect(r.send).toBe(false);
    expect(r.reason).toBe('suspicious_claim');
  });

  it('idempotente: já enviou → não envia de novo', () => {
    const r = shouldSendAcknowledgement({
      ...baseInput,
      acknowledgementSentAt: new Date(),
      category: 'refund_request',
      verification: 'verified_match',
      status: 'converted_to_refund',
    });
    expect(r.send).toBe(false);
    expect(r.reason).toBe('already_sent');
  });

  it('spam_commercial: não recebe ack', () => {
    const r = shouldSendAcknowledgement({
      ...baseInput,
      category: 'spam_commercial',
      verification: 'unknown_sender',
      status: 'spam_auto',
    });
    expect(r.send).toBe(false);
    expect(r.reason).toBe('excluded_category');
  });

  it('system_transactional: não recebe ack', () => {
    const r = shouldSendAcknowledgement({
      ...baseInput,
      category: 'system_transactional',
      verification: 'unknown_sender',
      status: 'system_transactional',
    });
    expect(r.send).toBe(false);
    // pega excluded_status primeiro
    expect(r.reason).toBe('excluded_status');
  });

  it('auto_filtered: não recebe ack (é lixo/bot)', () => {
    const r = shouldSendAcknowledgement({
      ...baseInput,
      category: null,
      verification: 'unknown_sender',
      status: 'auto_filtered',
    });
    expect(r.send).toBe(false);
    expect(r.reason).toBe('excluded_status');
  });

  it('thank_you_closed: não recebe ack', () => {
    const r = shouldSendAcknowledgement({
      ...baseInput,
      category: 'thank_you_closed',
      verification: 'verified_match',
      status: 'resolved',
    });
    expect(r.send).toBe(false);
    expect(r.reason).toBe('excluded_category');
  });

  it('categoria fora do enum ACK_WORTHY: não envia', () => {
    const r = shouldSendAcknowledgement({
      ...baseInput,
      category: 'weird_new_category',
      verification: 'verified_match',
      status: 'pending_human',
    });
    expect(r.send).toBe(false);
    expect(r.reason).toBe('not_ack_worthy');
  });

  it('automation OFF e ack_always_on OFF: não envia (dono desligou tudo)', () => {
    const r = shouldSendAcknowledgement({
      category: 'refund_request',
      verification: 'verified_match',
      status: 'converted_to_refund',
      acknowledgementSentAt: null,
      automationEnabled: false,
      acknowledgementAlwaysOn: false,
    });
    expect(r.send).toBe(false);
    expect(r.reason).toBe('automation_off');
  });

  it('todas as categorias ACK_WORTHY disparam ack quando condições OK', () => {
    for (const cat of ACK_WORTHY_CATEGORIES) {
      const r = shouldSendAcknowledgement({
        ...baseInput,
        category: cat,
        verification: 'verified_match',
        status: 'pending_human',
      });
      expect(r.send, `category=${cat} deveria enviar`).toBe(true);
    }
  });
});

describe('renderAcknowledgement — conteúdo', () => {
  const baseBrand = {
    name: 'AuthenLondon',
    supportEmail: 'support@authenlondon.com',
    postalAddress: '35 Weir Rd, London SW12 0NU, United Kingdom',
  };

  it('inglês UK, saudação + SLA + assinatura', () => {
    const r = renderAcknowledgement({
      category: 'refund_request',
      verification: 'verified_match',
      customerFirstName: 'John',
      orderNumber: '1002',
      brand: baseBrand,
      slaWindow: '1 business day',
    });
    expect(r.subject).toContain('order #1002');
    expect(r.textBody).toContain('Hello John');
    expect(r.textBody).toContain('1 business day');
    expect(r.textBody).toContain('The AuthenLondon team');
    expect(r.htmlBody).toContain('AuthenLondon');
    expect(r.htmlBody).toContain('35 Weir Rd, London SW12 0NU');
  });

  it('refund_request: menciona que decisão é individual e sem promessa', () => {
    const r = renderAcknowledgement({
      category: 'refund_request',
      verification: 'verified_match',
      customerFirstName: 'John',
      orderNumber: '1001',
      brand: baseBrand,
      slaWindow: '1 business day',
    });
    expect(r.textBody.toLowerCase()).toContain('refund');
    expect(r.textBody).toContain('reviewed');
    // Nunca promete refund
    expect(r.textBody.toLowerCase()).not.toContain('your refund has been');
    expect(r.textBody.toLowerCase()).not.toContain('will refund');
    expect(r.textBody.toLowerCase()).not.toContain('will be refunded');
  });

  it('unknown_sender: pede número do pedido + email do checkout', () => {
    const r = renderAcknowledgement({
      category: 'order_status',
      verification: 'unknown_sender',
      customerFirstName: 'Sam',
      orderNumber: null,
      brand: baseBrand,
      slaWindow: '1 business day',
    });
    expect(r.textBody.toLowerCase()).toContain('order number');
    expect(r.textBody.toLowerCase()).toContain('email address you used at checkout');
  });

  it('chargeback_threat: ack seguro, escala, NUNCA discute mérito', () => {
    const r = renderAcknowledgement({
      category: 'chargeback_threat',
      verification: 'unknown_sender',
      customerFirstName: null,
      orderNumber: null,
      brand: baseBrand,
      slaWindow: '1 business day',
    });
    expect(r.textBody.toLowerCase()).toContain('payment concern');
    expect(r.textBody.toLowerCase()).toContain('follow up');
    // Não promete/discute:
    expect(r.textBody.toLowerCase()).not.toContain('refund');
    expect(r.textBody.toLowerCase()).not.toContain('chargeback');
  });

  it('policyUrl/portalUrl: sem eles, não renderiza link (comportamento default)', () => {
    const r = renderAcknowledgement({
      category: 'refund_request',
      verification: 'verified_match',
      customerFirstName: 'John',
      orderNumber: '1001',
      brand: baseBrand,
      slaWindow: '1 business day',
      policyUrl: null,
      portalUrl: null,
    });
    expect(r.textBody).not.toContain('policy is available here');
    expect(r.textBody).not.toContain('track this request in our support portal');
  });

  it('policyUrl setado: renderiza o link', () => {
    const r = renderAcknowledgement({
      category: 'refund_request',
      verification: 'verified_match',
      customerFirstName: 'John',
      orderNumber: '1001',
      brand: baseBrand,
      slaWindow: '1 business day',
      policyUrl: 'https://authenlondon.com/policies/refunds',
    });
    expect(r.textBody).toContain('https://authenlondon.com/policies/refunds');
  });

  it('fallback firstName "there" quando customerFirstName é null/vazio', () => {
    const r = renderAcknowledgement({
      category: 'unclear',
      verification: 'unknown_sender',
      customerFirstName: null,
      orderNumber: null,
      brand: baseBrand,
      slaWindow: '1 business day',
    });
    expect(r.textBody).toContain('Hello there');
  });
});
