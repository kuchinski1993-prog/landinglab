// Story 15.4 — políticas padrão por mercado/idioma (AC11) e reembolso (AC5).
import { describe, expect, it } from 'vitest';

import { createRefund } from '../payment-intents.js';
import {
  POLICY_SLUGS,
  defaultPolicyHtml,
  ownerMarkers,
  parseMarketPolicies,
  parseSellerInfo,
  policyPublishIssues,
  policySource,
  policyTitle,
  renderPolicy,
  sanitizePolicyHtml,
  type PolicyContext,
} from '../policies.js';
import type { StripeClient } from '../stripe-client.js';

const market = {
  locale: 'it',
  currency: 'EUR',
  countryCodes: ['IT'],
  shippingFreeEnabled: true,
  shippingFreeLabel: 'Spedizione gratuita',
  shippingFreeMinDays: 10,
  shippingFreeMaxDays: 20,
  shippingExpressEnabled: true,
  shippingExpressLabel: 'Spedizione espressa',
  shippingExpressMinor: 990,
  shippingExpressMinDays: 5,
  shippingExpressMaxDays: 8,
};

const fullSeller = {
  legalName: 'Cubipiccanti LTD',
  legalAddress: 'Via Roma 1\n00100 Roma',
  vatId: 'IT12345678901',
  refundWindowDays: 14,
  returnShippingPayer: 'customer' as const,
};

/** Simula o owner preenchendo cada [PREENCHER: ...] no editor. */
function fillMarkers(html: string): string {
  return html.replace(/\[PREENCHER[^\]]*\]/g, 'Dato del venditore');
}

function ctx(seller = {}): PolicyContext {
  return { brand: 'Vigorex', seller, market, supportEmail: 'support@cubipiccanti.online' };
}

describe('políticas padrão', () => {
  it('cinco políticas em italiano com título e texto', () => {
    for (const slug of POLICY_SLUGS) {
      expect(policyTitle(slug, 'it')).toBeTruthy();
      expect(defaultPolicyHtml(slug, 'it')).toContain('<');
    }
    expect(policyTitle('refund-policy', 'it')).toBe('Politica di rimborso');
  });

  it('fallback de idioma para en', () => {
    expect(policyTitle('privacy-policy', 'de')).toBe('Privacy policy');
    expect(defaultPolicyHtml('terms-of-service', null)).toBe(defaultPolicyHtml('terms-of-service', 'en'));
  });

  it('envio usa a faixa de prazo de cada método do mercado (D12)', () => {
    const { html, missing } = renderPolicy(defaultPolicyHtml('shipping-policy', 'it'), ctx(fullSeller));
    expect(missing).toEqual([]);
    expect(html).toContain('Spedizione gratuita');
    expect(html).toContain('10–20 giorni lavorativi');
    expect(html).toContain('5–8 giorni lavorativi');
    expect(html).toMatch(/9,90\s?€/);
    expect(html).toContain('Italia');
  });

  it('textos it trazem marcadores [PREENCHER] e não dependem de seller_info', () => {
    for (const slug of POLICY_SLUGS) {
      const html = defaultPolicyHtml(slug, 'it');
      const markers = ownerMarkers(html);
      expect(markers.length).toBeGreaterThan(0);
      for (const m of markers) expect(m).toMatch(/^\[PREENCHER: [^[\]]+\]$/);
      // Identidade jurídica agora vai direto no texto: nenhum placeholder de seller_info.
      expect(html).not.toMatch(/\{\{\s*(legal_name|legal_address|vat_line|refund_window_days|return_shipping_payer)\s*\}\}/);
    }
  });

  it('publicação bloqueada enquanto houver [PREENCHER] (Story 15.7)', () => {
    for (const slug of POLICY_SLUGS) {
      const source = defaultPolicyHtml(slug, 'it');
      const issues = policyPublishIssues(source, ctx(fullSeller));
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ code: 'pending_owner_text' });
      const n = ownerMarkers(source).length;
      expect(issues[0]!.message).toContain(n === 1 ? 'Falta 1 trecho' : `Faltam ${n} trechos`);
      expect(issues[0]!.message).toContain('Primeiro: ');
      expect(issues[0]!.message).not.toContain('[PREENCHER:');
    }
    const one = policyPublishIssues('<p>Venditore: [PREENCHER: razão social, ex.: "X S.r.l."]</p>', ctx());
    expect(one[0]!.message).toMatch(/^Falta 1 trecho .*Primeiro: razão social, ex\.: "X S\.r\.l\."$/);
    // Marcador sem fechar também bloqueia.
    expect(policyPublishIssues('<p>[PREENCHER sem fechar</p>', ctx())[0]).toMatchObject({ code: 'pending_owner_text' });
  });

  it('sem marcador e sem seller_info: publicável; placeholders antigos continuam exigindo seller_info', () => {
    for (const slug of POLICY_SLUGS) {
      const filled = fillMarkers(defaultPolicyHtml(slug, 'it'));
      expect(policyPublishIssues(filled, ctx())).toEqual([]);
      const { html, missing } = renderPolicy(filled, ctx());
      expect(missing).toEqual([]);
      expect(html).not.toMatch(/\{\{|\[\[|PREENCHER/);
    }
    const legacy = policyPublishIssues('<p>{{legal_name}} — {{refund_window_days}} giorni, {{return_shipping_payer}}</p>', ctx());
    expect(legacy.map((i) => i.field).sort()).toEqual(['legalName', 'refundWindowDays', 'returnShippingPayer']);
    expect(policyPublishIssues('<p>{{legal_name}} — {{refund_window_days}} giorni</p>', ctx(fullSeller))).toEqual([]);
  });

  it('com dados preenchidos, renderiza sem placeholders e escapa valores', () => {
    for (const slug of POLICY_SLUGS) {
      const { html } = renderPolicy(fillMarkers(defaultPolicyHtml(slug, 'it')), ctx(fullSeller));
      expect(html).not.toMatch(/\{\{|\[\[/);
      expect(html).not.toContain('{{brand}}');
    }
    const { html } = renderPolicy('<p>{{legal_name}} {{legal_address}}</p>', ctx({ ...fullSeller, legalName: '<b>x</b>' }));
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('Via Roma 1<br>00100 Roma');
  });

  it('VAT é opcional; placeholder desconhecido bloqueia', () => {
    const noVat = { ...fullSeller, vatId: undefined };
    expect(policyPublishIssues('<p>{{legal_name}}<br>{{vat_line}}{{support_email}}</p>', ctx(noVat))).toEqual([]);
    const issues = policyPublishIssues('<p>{{foo}}</p>', ctx(fullSeller));
    expect(issues[0]).toMatchObject({ code: 'unknown_placeholder', field: 'foo' });
    expect(policyPublishIssues('<p>  </p>', ctx(fullSeller))[0]).toMatchObject({ code: 'empty_text' });
  });

  it('nenhuma política it promete data de entrega', () => {
    for (const slug of POLICY_SLUGS) {
      const { html } = renderPolicy(fillMarkers(defaultPolicyHtml(slug, 'it')), ctx(fullSeller));
      const text = html.replace(/<[^>]*>/g, ' ');
      expect(text).not.toMatch(/consegna (entro|il giorno)|arriv\w* entro|ricev\w* (il pacco|l'ordine|i prodotti) entro|consegna garantita entro|consegnato entro/i);
      // Nenhuma data de calendário (a data da versão é um marcador do owner).
      expect(text).not.toMatch(/\b\d{1,2} (gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\b/i);
    }
    expect(defaultPolicyHtml('shipping-policy', 'it')).toContain('non costituiscono una data di consegna garantita');
    expect(defaultPolicyHtml('shipping-policy', 'it')).toContain('{{shipping_methods}}');
    expect(defaultPolicyHtml('shipping-policy', 'it')).toContain('{{countries}}');
  });

  it('textos it cobrem Stripe (requisitos de site) e direito do consumidor/GDPR', () => {
    const topics: Record<(typeof POLICY_SLUGS)[number], string[]> = {
      'refund-policy': [
        'recedere dal contratto',
        'entro 14 giorni',
        'Modulo di recesso tipo',
        'Allegato I, parte B',
        'Cancellare la dicitura inutile',
        'entro 14 giorni dal giorno in cui siamo informati',
        'stesso mezzo di pagamento',
        'Stripe',
        'garanzia legale di conformità di 24 mesi',
        "Cancellazione dell'abbonamento",
        'alla fine del periodo già pagato',
        'art. 59',
      ],
      'shipping-policy': [
        '{{countries}}',
        '{{shipping_methods}}',
        'giorni lavorativi',
        'solo con il primo pagamento',
        'Restrizioni legali e di esportazione',
        'art. 63',
      ],
      'privacy-policy': [
        'Titolare del trattamento',
        'Regolamento (UE) 2016/679',
        'Stripe',
        'Resend',
        'Vercel',
        'Supabase',
        'Meta',
        'Conversions API',
        'clausole contrattuali standard',
        '10 anni',
        'Garante per la protezione dei dati personali',
        'Cookie e Pixel di Meta',
        'PCI DSS',
      ],
      'terms-of-service': [
        '1. Venditore',
        'Conclusione del contratto',
        'IVA',
        'Stripe',
        'entro 14 giorni',
        'garanzia legale di conformità',
        '24 mesi',
        "Cancellazione dell'abbonamento",
        'alla fine del periodo già pagato',
        'non verranno addebitati ulteriori rinnovi',
        'Promozioni e sconti',
        'Restrizioni legali e di esportazione',
        'legge italiana',
        'art. 66-bis',
      ],
      'contact-information': ['{{support_email}}', 'Gestisci l’abbonamento', 'modulo di recesso tipo', 'Traccia il tuo ordine'],
    };
    for (const slug of POLICY_SLUGS) {
      const html = defaultPolicyHtml(slug, 'it');
      for (const topic of topics[slug]) expect(html, `${slug}: ${topic}`).toContain(topic);
      // Plataforma ODR da UE foi descontinuada (2025): não citar.
      expect(html).not.toMatch(/\bODR\b|ec\.europa\.eu\/consumers\/odr/i);
    }
  });

  it('sanitiza HTML do owner e lê o jsonb', () => {
    expect(sanitizePolicyHtml('<p onclick="x()">a</p><script>alert(1)</script><a href="javascript:x">l</a>')).toBe(
      '<p>a</p><a href="#">l</a>',
    );
    const parsed = parseMarketPolicies({
      'refund-policy': { status: 'published', html: '<p>x</p>', publishedAt: '2026-10-06' },
      'shipping-policy': { status: 'weird' },
      bogus: { status: 'published' },
    });
    expect(parsed['refund-policy']?.status).toBe('published');
    expect(parsed['shipping-policy']?.status).toBe('draft');
    expect(Object.keys(parsed)).toEqual(['refund-policy', 'shipping-policy']);
    expect(policySource('shipping-policy', parsed['shipping-policy'], 'it')).toBe(defaultPolicyHtml('shipping-policy', 'it'));
    expect(parseSellerInfo({ legalName: '  ', refundWindowDays: 0, returnShippingPayer: 'x' })).toEqual({});
  });
});

describe('createRefund', () => {
  it('reembolso parcial com idempotency key; total omite amount', async () => {
    const calls: Array<{ params: Record<string, unknown>; key?: string }> = [];
    const client = {
      refunds: {
        create: async (params: Record<string, unknown>, opts?: { idempotencyKey?: string }) => {
          calls.push({ params, key: opts?.idempotencyKey });
          return { id: 're_1', amount: (params['amount'] as number) ?? 5980, currency: 'eur', status: 'succeeded' };
        },
      },
    } as unknown as StripeClient;
    const partial = await createRefund(client, { paymentIntentId: 'pi_1', amountMinor: 1000, currency: 'EUR', idempotencyKey: 'k1' });
    expect(partial).toEqual({ id: 're_1', amountMinor: 1000, currency: 'EUR', status: 'succeeded' });
    await createRefund(client, { paymentIntentId: 'pi_1', currency: 'EUR', idempotencyKey: 'k2' });
    expect(calls[0]).toEqual({ params: { payment_intent: 'pi_1', amount: 1000 }, key: 'k1' });
    expect(calls[1]!.params).toEqual({ payment_intent: 'pi_1' });
  });
});
