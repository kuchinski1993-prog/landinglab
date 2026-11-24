// Story 17.6c · AC1/AC2 — GOLDEN do acuse-recebimento (ack) da loja `default` (AuthenLondon).
//
// Gravado ANTES de qualquer mudança no código protegido (1º commit do PR 17.6c-1) e CONGELADO:
// nenhum commit posterior altera este arquivo nem o snapshot (condição (a) do owner). Registra,
// byte a byte, assunto, texto, HTML e notas internas do ack com os literais que o worker passa hoje
// (analyze-inbound.processor.ts) — o ack por idioma da 17.6c não pode mudar nada disto.
import { describe, expect, it } from 'vitest';

import { renderAcknowledgement, type RenderAckInput } from '../../inbound/acknowledgement.js';

const BRAND: RenderAckInput['brand'] = {
  name: 'AuthenLondon',
  supportEmail: 'support@authenlondon.com',
  postalAddress: '35 Weir Rd, London SW12 0NU, United Kingdom',
};

const CATEGORIES = [
  'refund_request', 'exchange_request', 'order_status', 'delivery_problem', 'complaint_general',
  'policy_question', 'product_question_pre_purchase', 'chargeback_threat', 'unclear',
];

describe('golden default · renderAcknowledgement', () => {
  for (const category of CATEGORIES) {
    it(`${category} — verificado com pedido, verificado sem pedido, desconhecido`, () => {
      const base = { category, brand: BRAND, slaWindow: '1 business day', policyUrl: null, portalUrl: null };
      expect({
        verifiedWithOrder: renderAcknowledgement({ ...base, verification: 'verified_match', customerFirstName: 'Alice', orderNumber: '1001' }),
        verifiedViaOrderNoNumber: renderAcknowledgement({ ...base, verification: 'verified_via_order', customerFirstName: null, orderNumber: null }),
        unknownSender: renderAcknowledgement({ ...base, verification: 'unknown_sender', customerFirstName: '  ', orderNumber: '1002' }),
      }).toMatchSnapshot();
    });
  }

  it('com policyUrl/portalUrl e caracteres que exigem escape no HTML', () => {
    expect(
      renderAcknowledgement({
        category: 'refund_request',
        verification: 'verified_match',
        customerFirstName: "O'Brien <b>",
        orderNumber: '7&8',
        brand: BRAND,
        slaWindow: '1 business day',
        policyUrl: 'https://authenlondon.com/policies/refund-policy',
        portalUrl: 'https://authenlondon.com/support',
      }),
    ).toMatchSnapshot();
  });
});
