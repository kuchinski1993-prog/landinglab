// E2E Stripe B-4 — o <script> da Engine V2 gerado pela rota da landing é JS
// válido (as funções inline de cta-runtime.ts entram sem quebrar o bloco).
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/resolve-landing', () => ({
  resolveLanding: async () => ({
    landingPageId: '11111111-1111-4111-8111-111111111111',
    title: 'Spicy Cubes',
    slug: 'chemistry-club',
    htmlBody: '<html><head></head><body><button name="add"><span class="button-text">Add to cart - €19.00</span></button></body></html>',
    customCss: null,
    status: 'published',
    isDefaultRoot: false,
    domainId: 'd',
    domain: 'cubipiccanti.online',
    seoTitle: null,
    seoDescription: null,
    seoImage: null,
    mediaUrls: [],
    contentLanguage: 'it',
    manufacturer: null,
    productType: null,
    price: '0.00',
    currency: 'EUR',
    compareAtPrice: null,
    useNewBundleEngine: true,
    bundleOffers: [],
    checkoutProvider: 'stripe',
    externalCheckout: {},
  }),
}));

vi.mock('@/lib/db', () => {
  const rows = [
    { position: 0, title: 'Acquista 1', qty: 1, variantId: null, priceCents: 1900, compareAtCents: null, saveText: null, badge: null, isPreselected: true },
  ];
  const chain = { select: () => chain, from: () => chain, where: () => chain, orderBy: async () => rows };
  return { getDb: () => chain };
});

describe('Engine V2 — script gerado', () => {
  it('compila como JavaScript (Stripe)', async () => {
    const { GET } = await import('../app/landing/[host]/[[...slug]]/route');
    const res = await GET(new Request('https://chemistry-club.cubipiccanti.online/'), {
      params: { host: 'chemistry-club.cubipiccanti.online' },
    });
    const html = await res.text();
    const match = /<script id="ll-bundle-runtime" data-landinglab-engine="v2">([\s\S]*?)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    expect(() => new Function(match![1]!)).not.toThrow();
    expect(match![1]).toContain('Math.round(priceCents * (100 - pct) / 100)');
    // Relay CAPI só depois do consentimento, com marketingConsent (libera IP + UA no servidor).
    expect(match![1]).toContain('window.__LL_ON_CONSENT__(sendCapi)');
    expect(match![1]).toContain('marketingConsent: true');
    // Banner vem antes do runtime (e de qualquer pixel do HTML).
    expect(html.indexOf('ll-consent-runtime')).toBeLessThan(html.indexOf('ll-bundle-runtime'));
    const consent = /<script id="ll-consent-runtime">([\s\S]*?)<\/script>/.exec(html);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    expect(() => new Function(consent![1]!)).not.toThrow();
    expect(html).toContain('Accetta');
    // Destaque do card acompanha o clique mesmo com o JS do Kaching quebrado
    // (sem reescrever a classe quando já está certa → sem loop no observer).
    expect(match![1]).toContain('syncKachingSelected(cards[j], cardPos === position)');
    expect(match![1]).toContain("if(selected && !has) card.classList.add(KACHING_SELECTED)");
    // Título do card = oferta cadastrada.
    expect(match![1]).toContain("titleEl.textContent = offer.title");
    // Instafeed hotlinkado (403) fica escondido.
    expect(html).toContain('[id*="__instafeed_app_block"]');
  });
});
