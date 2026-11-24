// Story 25.1 — rota da landing com ofertas do sistema (AC 8–11): bloco original removido no
// servidor, bloco do sistema no lugar, script de ofertas antes do script do provider, runtime da
// Engine V2 expondo a seleção; sem posição, volta ao modo "página".
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state: { landing: Record<string, unknown>; source: string; failExtras: boolean } = {
  landing: {},
  source: 'system',
  failExtras: false,
};

vi.mock('@/lib/resolve-landing', () => ({
  resolveLanding: async () => state.landing,
}));

vi.mock('@/lib/db', () => {
  const rows = [
    { position: 0, title: 'Kauf 1', qty: 1, variantId: '111', priceCents: 1900, compareAtCents: null, saveText: null, badge: null, isPreselected: false, bullets: [], checkoutUrl: null },
    { position: 1, title: 'Kauf 3', qty: 3, variantId: '333', priceCents: 4500, compareAtCents: 5700, saveText: 'Spare 21%', badge: 'Bestseller', isPreselected: true, bullets: ['Gratis Versand'], checkoutUrl: 'https://pay.example.com/k3' },
  ];
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: async () => {
      if (state.failExtras) throw new Error('column "bullets" does not exist');
      return rows;
    },
    limit: async () => [{ offersSource: state.source }],
  };
  return { getDb: () => chain };
});

function base(overrides: Record<string, unknown>) {
  return {
    landingPageId: '11111111-1111-4111-8111-111111111111',
    title: 'Aeterna',
    slug: 'aeterna',
    htmlBody:
      '<html><head></head><body><h1>Produkt</h1>' +
      '<div class="kaching-bundles" data-ll-bundle-root><div data-ll-offer="0">SOLD OUT</div></div>' +
      '<button name="add">Kaufen</button></body></html>',
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
    marketLocale: 'de-DE',
    manufacturer: null,
    productType: null,
    price: '0.00',
    currency: 'EUR',
    compareAtPrice: null,
    useNewBundleEngine: true,
    bundleOffers: [],
    checkoutProvider: 'shopify',
    externalCheckout: null,
    ...overrides,
  };
}

async function render(): Promise<string> {
  const { GET } = await import('../app/landing/[host]/[[...slug]]/route');
  const res = await GET(new Request('https://lp.example.com/'), { params: { host: 'lp.example.com' } });
  return res.text();
}

describe('rota da landing — modo das ofertas', () => {
  beforeEach(() => {
    state.landing = base({});
    state.source = 'system';
    state.failExtras = false;
  });

  it('sistema: remove o bloco original e serve o bloco próprio com bullets e pré-seleção', async () => {
    const html = await render();
    expect(html).not.toContain('SOLD OUT');
    expect(html).toContain('data-ll-system-offers="1"');
    expect(html).toContain('<li>Gratis Versand</li>');
    expect(html).toMatch(/data-landing-position="1" data-landing-qty="3" data-landing-variant-id="333" data-landing-variant-active="true"/);
    expect(html).toContain('window.__LL_SET_ACTIVE_OFFER__ = setActive');
  });

  it('script de ofertas entra antes do runtime do provider e leva o link da oferta', async () => {
    const html = await render();
    const offersAt = html.indexOf('data-landinglab-engine="offers"');
    expect(offersAt).toBeGreaterThan(-1);
    expect(offersAt).toBeLessThan(html.indexOf('__LL_CHECKOUT_API__'));
    expect(html).toContain('https://pay.example.com/k3');
  });

  it('external: script de ofertas antes do script external, com preenchimento de preços', async () => {
    state.landing = base({ checkoutProvider: 'external', externalCheckout: { '1': 'https://shop.example.com/p1' } });
    const html = await render();
    const offersAt = html.indexOf('data-landinglab-engine="offers"');
    expect(offersAt).toBeGreaterThan(-1);
    expect(offersAt).toBeLessThan(html.indexOf('data-landinglab-engine="external-checkout"'));
    expect(html).toContain('"fillPrices":true');
  });

  it('sistema sem posição marcada: mantém a página (modo efetivo "página")', async () => {
    state.landing = base({ htmlBody: '<html><head></head><body><div data-ll-offer="0">orig</div></body></html>' });
    const html = await render();
    expect(html).toContain('orig');
    expect(html).not.toContain('data-ll-system-offers="1"');
    expect(html).toContain('"source":"page"');
  });

  it('Story 26.1: runtime de edições só com marca do editor, antes do script de ofertas', async () => {
    expect(await render()).not.toContain('data-landinglab-engine="edits"');
    state.landing = base({
      htmlBody: '<html><head></head><body><a class="btn" data-ll-href="https://pay.example.com/x">Ir</a></body></html>',
    });
    const html = await render();
    const editsAt = html.indexOf('data-landinglab-engine="edits"');
    expect(editsAt).toBeGreaterThan(-1);
    expect(editsAt).toBeLessThan(html.indexOf('data-landinglab-engine="offers"'));
    expect(html).toContain('data-ll-href="https://pay.example.com/x"');
  });

  it('colunas da 0115 ausentes: segue no modo página sem quebrar', async () => {
    state.failExtras = true;
    const html = await render();
    expect(html).toContain('SOLD OUT');
    expect(html).not.toContain('data-ll-system-offers="1"');
  });
});
