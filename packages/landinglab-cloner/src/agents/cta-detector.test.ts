// Tests de extractCtas + rewriteCtas.
// Cobre: categorização por URL path, buttons de venda por texto, seletor
// estável via data-cta-idx, rewrite substituindo/removendo/convertindo,
// preservação de href quando newHref=null.

import { describe, expect, it } from 'vitest';

import { extractCtas, rewriteCtas } from './cta-detector.js';

const SIMPLE_HTML = `
<html>
<body>
  <nav>
    <a href="/">Home</a>
    <a href="https://origin.com/pages/contact">Contact</a>
  </nav>
  <main>
    <a href="https://origin.com/products/x">Buy Product</a>
    <a href="#reviews">See reviews</a>
    <a href="mailto:hi@origin.com">Email us</a>
    <button>Acquista 1 pack ¥7,120</button>
    <button>Menu</button>
  </main>
</body>
</html>`.trim();

describe('extractCtas', () => {
  it('detecta anchors e sale-buttons no HTML', () => {
    const { ctas } = extractCtas(SIMPLE_HTML, { sourceUrl: 'https://origin.com' });
    // 5 anchors + 1 sale button (o "Menu" não é sale, é ignorado)
    expect(ctas.length).toBe(6);
  });

  it('categoriza sale corretamente por URL path', () => {
    const { ctas } = extractCtas(SIMPLE_HTML, { sourceUrl: 'https://origin.com' });
    const sale = ctas.filter((c) => c.category === 'sale');
    // 1 anchor /products/x + 1 button "Acquista"
    expect(sale.length).toBe(2);
    expect(sale.some((c) => c.currentHref === 'https://origin.com/products/x')).toBe(true);
    expect(sale.some((c) => c.tag === 'button')).toBe(true);
  });

  it('categoriza nav pra /pages e /blog', () => {
    const { ctas } = extractCtas(SIMPLE_HTML, { sourceUrl: 'https://origin.com' });
    const nav = ctas.filter((c) => c.category === 'nav');
    expect(nav.length).toBe(1);
    expect(nav[0]!.currentHref).toBe('https://origin.com/pages/contact');
  });

  it('categoriza # como internal', () => {
    const { ctas } = extractCtas(SIMPLE_HTML);
    const internal = ctas.filter((c) => c.category === 'internal');
    expect(internal.length).toBe(1);
    expect(internal[0]!.currentHref).toBe('#reviews');
  });

  it('categoriza mailto como external', () => {
    const { ctas } = extractCtas(SIMPLE_HTML);
    const external = ctas.filter((c) => c.category === 'external');
    expect(external.length).toBe(1);
    expect(external[0]!.currentHref).toBe('mailto:hi@origin.com');
  });

  it('categoriza href="/" como placeholder', () => {
    const { ctas } = extractCtas(SIMPLE_HTML);
    const placeholder = ctas.filter((c) => c.category === 'placeholder');
    expect(placeholder.length).toBe(1);
  });

  it('marca isChrome=true pra elementos dentro de <nav>', () => {
    const { ctas } = extractCtas(SIMPLE_HTML);
    const homeLink = ctas.find((c) => c.text === 'Home');
    expect(homeLink?.isChrome).toBe(true);
    const buyLink = ctas.find((c) => c.currentHref === 'https://origin.com/products/x');
    expect(buyLink?.isChrome).toBe(false);
  });

  it('ignora buttons sem texto de venda', () => {
    const { ctas } = extractCtas(SIMPLE_HTML);
    const menuButton = ctas.find((c) => c.tag === 'button' && c.text === 'Menu');
    expect(menuButton).toBeUndefined();
  });

  it('anota HTML com data-cta-idx e data-cta-href', () => {
    const { html } = extractCtas(SIMPLE_HTML);
    expect(html).toContain('data-cta-idx');
    expect(html).toContain('data-cta-href');
  });

  it('extrai texto do CTA truncado em 80 chars', () => {
    const longText = 'A'.repeat(200);
    const html = `<html><body><a href="/products/x">${longText}</a></body></html>`;
    const { ctas } = extractCtas(html, { sourceUrl: 'https://origin.com' });
    expect(ctas[0]!.text.length).toBeLessThanOrEqual(80);
  });

  it('detecta sale-button multi-idioma (comprar, buy, kaufen)', () => {
    const html = `
      <html><body>
        <button>Comprar agora €39</button>
        <button>Buy now $79</button>
        <button>Jetzt kaufen 79€</button>
      </body></html>`;
    const { ctas } = extractCtas(html);
    expect(ctas.filter((c) => c.tag === 'button').length).toBe(3);
  });
});

describe('rewriteCtas', () => {
  it('substitui href de anchor pelo selector estável', () => {
    const { html, ctas } = extractCtas(SIMPLE_HTML, { sourceUrl: 'https://origin.com' });
    const sale = ctas.find((c) => c.currentHref === 'https://origin.com/products/x')!;
    const { html: rewritten, applied } = rewriteCtas(html, [
      { selector: sale.selector, newHref: 'https://blackshop.com/checkout' },
    ]);
    expect(applied).toBe(1);
    expect(rewritten).toContain('href="https://blackshop.com/checkout"');
    // O href real do anchor mudou. O atributo data-cta-href preserva o
    // original (é marca de anotação, não o link ativo). Validamos que não
    // sobrou nenhum href="..." (não-data) apontando pra origin.
    expect(rewritten).not.toMatch(/[^-]href="https:\/\/origin\.com\/products\/x"/);
  });

  it('adiciona target=_blank e rel=noopener em URLs externas', () => {
    const { html, ctas } = extractCtas(SIMPLE_HTML, { sourceUrl: 'https://origin.com' });
    const sale = ctas.find((c) => c.currentHref === 'https://origin.com/products/x')!;
    const { html: rewritten } = rewriteCtas(html, [
      { selector: sale.selector, newHref: 'https://blackshop.com/checkout' },
    ]);
    expect(rewritten).toContain('target="_blank"');
    expect(rewritten).toContain('rel="noopener noreferrer"');
  });

  it('converte button em anchor quando newHref definido', () => {
    const { html, ctas } = extractCtas(SIMPLE_HTML);
    const btn = ctas.find((c) => c.tag === 'button')!;
    const { html: rewritten, applied } = rewriteCtas(html, [
      { selector: btn.selector, newHref: 'https://blackshop.com/buy' },
    ]);
    expect(applied).toBe(1);
    // O button virou anchor
    expect(rewritten).toContain('<a data-cta-idx');
    expect(rewritten).toContain('href="https://blackshop.com/buy"');
  });

  it('converte em span quando newHref é string vazia', () => {
    const { html, ctas } = extractCtas(SIMPLE_HTML);
    const link = ctas.find((c) => c.currentHref === '#reviews')!;
    const { html: rewritten, applied } = rewriteCtas(html, [
      { selector: link.selector, newHref: '' },
    ]);
    expect(applied).toBe(1);
    expect(rewritten).toContain('<span');
  });

  it('preserva href quando newHref=null (skipped incrementa)', () => {
    const { html, ctas } = extractCtas(SIMPLE_HTML, { sourceUrl: 'https://origin.com' });
    const sale = ctas.find((c) => c.currentHref === 'https://origin.com/products/x')!;
    const { html: rewritten, applied, skipped } = rewriteCtas(html, [
      { selector: sale.selector, newHref: null },
    ]);
    expect(applied).toBe(0);
    expect(skipped).toBe(1);
    // href original preservado
    expect(rewritten).toContain('href="https://origin.com/products/x"');
  });

  it('mappings sem selector match não quebram', () => {
    const { html } = extractCtas(SIMPLE_HTML);
    const { applied } = rewriteCtas(html, [
      { selector: "a[data-cta-idx='999'][data-cta-href='fake']", newHref: 'https://x.com' },
    ]);
    expect(applied).toBe(0);
  });

  it('array de mappings vazio retorna html intacto', () => {
    const { html: original } = extractCtas(SIMPLE_HTML);
    const { html: rewritten, applied } = rewriteCtas(original, []);
    expect(rewritten).toBe(original);
    expect(applied).toBe(0);
  });
});

describe('rewriteCtas — landingVariantId (buy button annotation)', () => {
  it('adiciona data-landing-cta="buy" e data-landing-variant-id quando landingVariantId presente', () => {
    const { html, ctas } = extractCtas(SIMPLE_HTML, { sourceUrl: 'https://origin.com' });
    const sale = ctas.find((c) => c.currentHref === 'https://origin.com/products/x')!;
    const { html: rewritten, applied } = rewriteCtas(html, [
      {
        selector: sale.selector,
        newHref: null,
        landingVariantId: 'lv-uuid-123',
      },
    ]);
    expect(applied).toBe(1);
    expect(rewritten).toContain('data-landing-cta="buy"');
    expect(rewritten).toContain('data-landing-variant-id="lv-uuid-123"');
  });

  it('adiciona data-landing-qty quando quantity > 1', () => {
    const { html, ctas } = extractCtas(SIMPLE_HTML);
    const btn = ctas.find((c) => c.tag === 'button')!;
    const { html: rewritten } = rewriteCtas(html, [
      {
        selector: btn.selector,
        newHref: null,
        landingVariantId: 'lv-x',
        quantity: 3,
      },
    ]);
    expect(rewritten).toContain('data-landing-qty="3"');
  });

  it('não adiciona data-landing-qty quando quantity=1 ou omitido', () => {
    const { html, ctas } = extractCtas(SIMPLE_HTML);
    const btn = ctas.find((c) => c.tag === 'button')!;
    const { html: rewritten } = rewriteCtas(html, [
      { selector: btn.selector, newHref: null, landingVariantId: 'lv-x' },
    ]);
    expect(rewritten).not.toContain('data-landing-qty');
  });

  it('combina rewrite de href + annotate como buy quando ambos fornecidos', () => {
    const { html, ctas } = extractCtas(SIMPLE_HTML, { sourceUrl: 'https://origin.com' });
    const sale = ctas.find((c) => c.currentHref === 'https://origin.com/products/x')!;
    const { html: rewritten, applied } = rewriteCtas(html, [
      {
        selector: sale.selector,
        newHref: 'https://blackshop.com/checkout',
        landingVariantId: 'lv-99',
      },
    ]);
    expect(applied).toBe(1);
    expect(rewritten).toContain('href="https://blackshop.com/checkout"');
    expect(rewritten).toContain('data-landing-cta="buy"');
    expect(rewritten).toContain('data-landing-variant-id="lv-99"');
  });

  it('adiciona cursor:pointer no style quando anota como buy', () => {
    const { html, ctas } = extractCtas(SIMPLE_HTML);
    const btn = ctas.find((c) => c.tag === 'button')!;
    const { html: rewritten } = rewriteCtas(html, [
      { selector: btn.selector, newHref: null, landingVariantId: 'lv-x' },
    ]);
    expect(rewritten).toMatch(/style="[^"]*cursor:pointer/);
  });

  it('sem landingVariantId + newHref null continua sendo skipped', () => {
    const { html, ctas } = extractCtas(SIMPLE_HTML);
    const btn = ctas.find((c) => c.tag === 'button')!;
    const { html: rewritten, skipped } = rewriteCtas(html, [
      { selector: btn.selector, newHref: null },
    ]);
    expect(skipped).toBe(1);
    expect(rewritten).not.toContain('data-landing-cta');
  });
});
