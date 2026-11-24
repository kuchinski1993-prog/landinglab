// Story 17.6c · AC6 — ack por idioma. en-GB (ou sem idioma) = golden; pt-BR com as mesmas regras.
import { describe, expect, it } from 'vitest';

import { renderAcknowledgement, type RenderAckInput } from '../inbound/acknowledgement.js';

const AUTHEN: RenderAckInput['brand'] = {
  name: 'AuthenLondon',
  supportEmail: 'support@authenlondon.com',
  postalAddress: '35 Weir Rd, London SW12 0NU, United Kingdom',
};
const BELA: RenderAckInput['brand'] = {
  name: 'Loja Bela',
  supportEmail: 'contato@lojabela.com.br',
  postalAddress: 'Rua A, 10 — São Paulo/SP',
};

const CATEGORIES = [
  'refund_request', 'exchange_request', 'order_status', 'delivery_problem', 'complaint_general',
  'policy_question', 'product_question_pre_purchase', 'chargeback_threat', 'unclear',
];
const VERIFICATIONS = ['verified_match', 'verified_via_order', 'unknown_sender'];

function pt(category: string, verification: string, extra: Partial<RenderAckInput> = {}) {
  return renderAcknowledgement({
    category,
    verification,
    customerFirstName: 'Ana',
    orderNumber: '5001',
    brand: BELA,
    slaWindow: '1 dia útil',
    language: 'pt-BR',
    ...extra,
  });
}

describe('ack en-GB = texto de hoje', () => {
  it('language en-GB explícito é idêntico a sem idioma', () => {
    for (const category of CATEGORIES) {
      for (const verification of VERIFICATIONS) {
        const base = { category, verification, customerFirstName: 'Al', orderNumber: '1', brand: AUTHEN, slaWindow: '1 business day' };
        expect(renderAcknowledgement({ ...base, language: 'en-GB' })).toEqual(renderAcknowledgement(base));
      }
    }
  });

  it('assinatura configurada substitui só o fecho', () => {
    const base = { category: 'unclear', verification: 'verified_match', customerFirstName: 'Al', orderNumber: null, brand: AUTHEN, slaWindow: '1 business day' };
    const a = renderAcknowledgement(base);
    const b = renderAcknowledgement({ ...base, signature: 'Sophie, AuthenLondon care' });
    expect(b.textBody).toBe(a.textBody.replace('The AuthenLondon team', 'Sophie, AuthenLondon care'));
  });
});

describe('ack pt-BR', () => {
  it('assunto, corpo, HTML, "Equipe {marca}" e rodapé com o endereço da loja', () => {
    const r = pt('order_status', 'verified_match');
    expect(r.subject).toBe('Recebemos sua mensagem sobre o pedido #5001');
    expect(r.textBody.startsWith('Olá, Ana,\n\nObrigado por entrar em contato sobre o pedido #5001.')).toBe(true);
    expect(r.textBody).toContain('em até 1 dia útil');
    expect(r.textBody.endsWith('Atenciosamente,\nEquipe Loja Bela')).toBe(true);
    expect(r.htmlBody).toContain('<html lang="pt-BR">');
    expect(r.htmlBody).toContain('Loja Bela · Rua A, 10 — São Paulo/SP');
    expect(r.htmlBody).toContain('mailto:contato@lojabela.com.br');
    expect(r.subject + r.textBody + r.htmlBody).not.toMatch(/AuthenLondon|authenlondon|Weir|GMT|business day|Kind regards|Hello/);
  });

  it('remetente desconhecido pede número do pedido e e-mail da compra', () => {
    const r = pt('unclear', 'unknown_sender', { customerFirstName: null, orderNumber: null });
    expect(r.subject).toBe('Recebemos sua mensagem');
    expect(r.textBody.startsWith('Olá,\n\n')).toBe(true);
    expect(r.textBody).toContain('O número do seu pedido');
    expect(r.textBody).toContain('O e-mail usado na compra');
  });

  it('nunca promete dinheiro (mesma régua do inglês), em todas as categorias e verificações', () => {
    for (const category of CATEGORIES) {
      for (const verification of VERIFICATIONS) {
        const t = pt(category, verification).textBody.toLowerCase();
        expect(t).not.toMatch(/reembolso (foi|será) (processado|aprovado|efetuado|creditado)/);
        expect(t).not.toMatch(/vamos reembolsar|garantimos o reembolso|seu dinheiro/);
      }
    }
    expect(pt('refund_request', 'verified_match').textBody).toContain('tomadas caso a caso');
  });

  it('assinatura configurada e escape de HTML no rodapé', () => {
    const r = pt('unclear', 'verified_match', {
      signature: 'Ana — Loja Bela',
      brand: { ...BELA, name: 'Loja & Cia' },
    });
    expect(r.textBody.endsWith('Atenciosamente,\nAna — Loja Bela')).toBe(true);
    expect(r.htmlBody).toContain('Loja &amp; Cia · ');
  });
});
