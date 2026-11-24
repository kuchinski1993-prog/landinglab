// Story 16.3 — rota da landing no modo `external` (AC 4, 7, 12, 13): sem __LL_CHECKOUT_API__,
// sem Engine V2/stripeCheckout, script de navegação direta com o mapa do servidor; tracker do
// Sphere só com opt-in. Shopify/Stripe intactos (não regressão).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state: { landing: Record<string, unknown> } = { landing: {} };

vi.mock('@/lib/resolve-landing', () => ({
  resolveLanding: async () => state.landing,
}));

vi.mock('@/lib/db', () => {
  const rows = [
    { position: 0, title: 'Acquista 1', qty: 1, variantId: null, priceCents: 1900, compareAtCents: null, saveText: null, badge: null, isPreselected: true },
  ];
  const chain = { select: () => chain, from: () => chain, where: () => chain, orderBy: async () => rows, limit: async () => [] };
  return { getDb: () => chain };
});

const TRACKER = '<script src="https://sphereaffiliate.com/api/public/tracker.js"></script>';
const LEGACY = '<script>window.__LL_CHECKOUT_API__ = window.__LL_CHECKOUT_API__ || "/api/landing-checkout";</script>';

function base(overrides: Record<string, unknown>) {
  return {
    landingPageId: '11111111-1111-4111-8111-111111111111',
    title: 'Aeterna',
    slug: 'aeterna',
    htmlBody: `<html><head>${TRACKER}</head><body><a data-landing-cta="buy" href="/checkout">Comprar</a>${LEGACY}</body></html>`,
    customCss: null,
    status: 'published',
    isDefaultRoot: false,
    domainId: 'd',
    domain: 'lp.example.com',
    seoTitle: null,
    seoDescription: null,
    seoImage: null,
    mediaUrls: [],
    contentLanguage: 'de',
    manufacturer: null,
    productType: null,
    price: '0.00',
    currency: 'EUR',
    compareAtPrice: null,
    useNewBundleEngine: true,
    bundleOffers: [],
    checkoutProvider: 'external',
    externalCheckout: { '1': 'https://aeterna-eu.shop/p1?fn=f1', '3': 'https://aeterna-eu.shop/p3' },
    ...overrides,
  };
}

async function render(): Promise<string> {
  const { GET } = await import('../app/landing/[host]/[[...slug]]/route');
  const res = await GET(new Request('https://lp.example.com/'), { params: { host: 'lp.example.com' } });
  return res.text();
}

describe('rota da landing — provider external', () => {
  beforeEach(() => {
    state.landing = base({});
  });

  it('serve o script external com o mapa do servidor, sem API de checkout nem Engine V2', async () => {
    const html = await render();
    const m = /<script data-landinglab-engine="external-checkout">([\s\S]*?)<\/script>/.exec(html);
    expect(m).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    expect(() => new Function(m![1]!)).not.toThrow();
    expect(m![1]).toContain('https://aeterna-eu.shop/p1?fn=f1');
    expect(html).not.toContain('__LL_CHECKOUT_API__');
    expect(html).not.toContain('/api/landing-checkout');
    expect(html).not.toContain('ll-bundle-runtime');
    expect(html).not.toContain('stripeCheckout');
  });

  it('tracker do Sphere removido por padrão e preservado só com opt-in', async () => {
    expect(await render()).not.toContain('sphereaffiliate');
    state.landing = base({ externalCheckout: { '1': 'https://aeterna-eu.shop/p1', allowSphereTracker: true } });
    const html = await render();
    expect(html.match(/sphereaffiliate\.com\/api\/public\/tracker\.js/g)).toHaveLength(1);
  });

  it('sem kit válido não injeta script (CTA não reescrito) e continua sem API de checkout', async () => {
    state.landing = base({ externalCheckout: {} });
    const html = await render();
    expect(html).not.toContain('external-checkout');
    expect(html).not.toContain('__LL_CHECKOUT_API__');
  });

  it('não regressão: stripe continua com __LL_CHECKOUT_API__ e Engine V2', async () => {
    state.landing = base({ checkoutProvider: 'stripe', externalCheckout: {} });
    const html = await render();
    expect(html).toContain('window.__LL_CHECKOUT_API__=');
    expect(html).toContain('id="ll-bundle-runtime"');
    expect(html).not.toContain('external-checkout');
    expect(html).not.toContain('sphereaffiliate');
  });
});
