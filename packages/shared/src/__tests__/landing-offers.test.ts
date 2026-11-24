// Story 25.1 — modo das ofertas: busca de elementos marcados, remoção do bloco original, render do
// bloco do sistema, validação de bullets e prioridade do link da oferta (AC 5, 9, 10, 11, 12).
import { describe, expect, it, vi } from 'vitest';

import {
  applySystemOffers,
  buildOffersScript,
  buildOffersScriptBody,
  findMarkedElementRanges,
  formatOfferPrice,
  hasSystemOffersPlacement,
  normalizeOffersSource,
  parseBulletsText,
  removeMarkedElements,
  renderSystemOffersBlock,
  validateOfferBullets,
  type LandingOfferView,
} from '../landing-offers.js';

function offer(p: Partial<LandingOfferView> & { position: number }): LandingOfferView {
  return {
    title: `Oferta ${p.position}`,
    qty: 1,
    priceCents: 1000,
    compareAtCents: null,
    saveText: null,
    badge: null,
    bullets: [],
    checkoutUrl: null,
    variantId: null,
    isPreselected: false,
    ...p,
  };
}

const OPTS = { currency: 'EUR', locale: 'de-DE', lang: 'de' };

describe('modo e bullets', () => {
  it('normaliza o modo (padrão página)', () => {
    expect(normalizeOffersSource('system')).toBe('system');
    expect(normalizeOffersSource('x')).toBe('page');
    expect(normalizeOffersSource(null)).toBe('page');
  });
  it('um bullet por linha, sem linhas vazias', () => {
    expect(parseBulletsText(' a \n\n b\r\nc ')).toEqual(['a', 'b', 'c']);
  });
  it('máx. 8 bullets de 120 caracteres', () => {
    expect(validateOfferBullets(['a', ' b ', ''])).toEqual({ ok: true, bullets: ['a', 'b'] });
    expect(validateOfferBullets(undefined)).toEqual({ ok: true, bullets: [] });
    expect(validateOfferBullets(Array(9).fill('x'))).toEqual({ ok: false, reason: 'too_many' });
    expect(validateOfferBullets(['x'.repeat(121)])).toEqual({ ok: false, reason: 'too_long' });
    expect(validateOfferBullets('a')).toEqual({ ok: false, reason: 'invalid' });
    expect(validateOfferBullets([1])).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('elementos marcados', () => {
  const html =
    '<body><h1>T</h1><div class="w" data-ll-bundle-root><div><div>card</div></div><img src=x></div>' +
    '<script>var s = "<div data-ll-bundle-root>";</script><!-- <div data-ll-bundle-root> --><p>fim</p></body>';
  it('acha o elemento inteiro com divs aninhadas; ignora script e comentário', () => {
    const r = findMarkedElementRanges(html, 'data-ll-bundle-root');
    expect(r).toHaveLength(1);
    expect(html.slice(r[0]!.start, r[0]!.end)).toBe(
      '<div class="w" data-ll-bundle-root><div><div>card</div></div><img src=x></div>',
    );
  });
  it('remove só o bloco marcado', () => {
    expect(removeMarkedElements(html, 'data-ll-bundle-root')).toBe(
      '<body><h1>T</h1><script>var s = "<div data-ll-bundle-root>";</script><!-- <div data-ll-bundle-root> --><p>fim</p></body>',
    );
  });
  it('atributo dentro de valor entre aspas não conta; sem fechamento não remove', () => {
    expect(findMarkedElementRanges('<div title="data-ll-bundle-root">x</div>', 'data-ll-bundle-root')).toEqual([]);
    expect(findMarkedElementRanges('<div data-ll-bundle-root><p>x', 'data-ll-bundle-root')).toEqual([]);
  });
  it('marcado dentro de marcado não repete', () => {
    const h = '<section data-ll-bundle-root="manual"><div data-ll-bundle-root>x</div></section>';
    expect(findMarkedElementRanges(h, 'data-ll-bundle-root')).toHaveLength(1);
  });
  it('detecta se o modo sistema tem posição', () => {
    expect(hasSystemOffersPlacement('<p>x</p>')).toBe(false);
    expect(hasSystemOffersPlacement('<p data-ll-offers-anchor>x</p>')).toBe(true);
  });
});

describe('bloco do sistema', () => {
  const offers = [
    offer({ position: 0, qty: 1, priceCents: 2990 }),
    offer({
      position: 1,
      qty: 3,
      title: 'Kit <b>3</b>',
      priceCents: 5990,
      compareAtCents: 8970,
      saveText: 'Spare 33%',
      badge: 'Bestseller',
      bullets: ['Frete grátis', '<img onerror=x>'],
      variantId: '123',
      isPreselected: true,
    }),
  ];
  it('renderiza cards com preço formatado, riscado, save, badge, bullets e pré-seleção, tudo escapado', () => {
    const block = renderSystemOffersBlock(offers, OPTS).replace(/\u00a0/g, ' ');
    expect(block).toContain('data-ll-system-offers="1"');
    expect(block).toContain('29,90 €');
    expect(block).toContain('<s class="ll-sys-offer__compare">89,70 €</s>');
    expect(block).toContain('Spare 33%');
    expect(block).toContain('>Bestseller<');
    expect(block).toContain('<li>Frete grátis</li>');
    expect(block).toContain('&lt;img onerror=x&gt;');
    expect(block).toContain('Kit &lt;b&gt;3&lt;/b&gt;');
    expect(block).not.toContain('<b>3</b>');
    expect(block).toMatch(/data-ll-offer="1" data-landing-position="1" data-landing-qty="3" data-landing-variant-id="123" data-landing-variant-active="true"/);
    expect(block).not.toMatch(/data-ll-offer="0"[^>]*data-landing-variant-active/);
    expect(block).toContain('data-landing-cta="buy" data-ll-system-buy="1">Jetzt kaufen</button>');
  });
  it('moeda sem casas decimais (JPY)', () => {
    expect(formatOfferPrice(7980, 'JPY', 'ja-JP')).toMatch(/7,980/);
  });
  it('substitui a primeira raiz e remove as outras', () => {
    const html = '<main><h1>P</h1><div data-ll-bundle-root><p>sold out</p></div><p>meio</p><div data-ll-bundle-root>2</div></main>';
    const r = applySystemOffers(html, offers, OPTS);
    expect(r.applied).toBe(true);
    expect(r.html).not.toContain('sold out');
    expect(r.html).not.toContain('>2</div>');
    expect(r.html.indexOf('<h1>P</h1>')).toBeLessThan(r.html.indexOf('ll-sys-offers'));
    expect(r.html.indexOf('ll-sys-offers')).toBeLessThan(r.html.indexOf('<p>meio</p>'));
  });
  it('com âncora: entra depois dela e as raízes saem', () => {
    const html = '<div data-ll-bundle-root>velho</div><p class="price" data-ll-offers-anchor>€</p><p>fim</p>';
    const r = applySystemOffers(html, offers, OPTS);
    expect(r.html.startsWith('<p class="price" data-ll-offers-anchor>€</p><div class="ll-sys-offers"')).toBe(true);
    expect(r.html).not.toContain('velho');
    expect(r.html.endsWith('<p>fim</p>')).toBe(true);
  });
  it('âncora dentro do bloco removido: entra no lugar do bloco', () => {
    const html = '<p>a</p><div data-ll-bundle-root><span data-ll-offers-anchor>x</span></div><p>b</p>';
    const r = applySystemOffers(html, offers, OPTS);
    expect(r.html.startsWith('<p>a</p><div class="ll-sys-offers"')).toBe(true);
    expect(r.html.endsWith('</div><p>b</p>')).toBe(true);
    expect(r.html).not.toContain('data-ll-offers-anchor');
  });
  it('sem posição ou sem ofertas: não aplica', () => {
    expect(applySystemOffers('<p>x</p>', offers, OPTS)).toEqual({ applied: false, html: '<p>x</p>', reason: 'no_placement' });
    expect(applySystemOffers('<div data-ll-bundle-root>x</div>', [], OPTS)).toMatchObject({ applied: false, reason: 'no_offers' });
  });
});

// DOM falso mínimo para o script de ofertas.
interface FakeEl {
  attrs: Record<string, string>;
  getAttribute(n: string): string | null;
  closest(sel: string): FakeEl | null;
}
function el(attrs: Record<string, string>): FakeEl {
  const node: FakeEl = {
    attrs,
    getAttribute: (n) => (n in attrs ? attrs[n]! : null),
    closest(sel) {
      if (sel.includes('[data-ll-offer]') && sel.length < 20) return 'data-ll-offer' in attrs ? node : null;
      if (sel.includes('cart-drawer')) return null;
      if (sel.includes('[data-landing-cta="buy"]')) return attrs['data-landing-cta'] === 'buy' ? node : null;
      return null;
    },
  };
  return node;
}

function run(offers: LandingOfferView[], pageUrl: string, active: FakeEl | null = null) {
  let click: ((ev: unknown) => void) | null = null;
  const assign = vi.fn();
  const loc = new URL(pageUrl);
  const win: Record<string, unknown> = {
    location: { search: loc.search, assign },
    addEventListener: (type: string, fn: (ev: unknown) => void, capture: boolean) => {
      expect(capture).toBe(true);
      if (type === 'click') click = fn;
    },
  };
  const doc = {
    readyState: 'complete',
    querySelector: (sel: string) => (sel.includes('variant-active') && active ? active : null),
    querySelectorAll: () => [],
  };
  const body = buildOffersScriptBody(offers, { source: 'system', currency: 'EUR' });
  new Function('window', 'document', 'setInterval', body)(win, doc, () => 0);
  const fire = (target: FakeEl) => {
    const ev = { target, preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn() };
    click!(ev);
    return ev;
  };
  return { assign, fire, win };
}

describe('script de ofertas: prioridade do link (AC 10, 11)', () => {
  const offers = [
    offer({ position: 0, checkoutUrl: 'https://pay.example.com/a?ref=prod' }),
    offer({ position: 1, isPreselected: true }),
    offer({ position: 2, checkoutUrl: 'https://pay.example.com/c' }),
  ];
  it('oferta ativa com link navega direto, repassando tracking sem sobrescrever o do link', () => {
    const { assign, fire } = run(offers, 'https://lp.test/p?utm_source=fb&ref=x&evil=1', el({ 'data-ll-offer': '0' }));
    const ev = fire(el({ 'data-landing-cta': 'buy' }));
    expect(assign).toHaveBeenCalledWith('https://pay.example.com/a?ref=prod&utm_source=fb');
    expect(ev.stopImmediatePropagation).toHaveBeenCalled();
  });
  it('oferta sem link: deixa o clique seguir para o provider', () => {
    const { assign, fire } = run(offers, 'https://lp.test/p');
    const ev = fire(el({ 'data-landing-cta': 'buy' })); // nenhuma ativa → pré-selecionada (sem link)
    expect(assign).not.toHaveBeenCalled();
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });
  it('último card clicado vale quando nada está marcado como ativo', () => {
    const { assign, fire } = run(offers, 'https://lp.test/p');
    fire(el({ 'data-ll-offer': '2' }));
    fire(el({ 'data-landing-cta': 'buy' }));
    expect(assign).toHaveBeenCalledWith('https://pay.example.com/c');
  });
  it('link não-https é ignorado', () => {
    const { assign, fire } = run([offer({ position: 0, checkoutUrl: 'http://x.com' })], 'https://lp.test/p');
    fire(el({ 'data-landing-cta': 'buy' }));
    expect(assign).not.toHaveBeenCalled();
  });
  it('dados escapados no script; sem ofertas não gera script', () => {
    const tag = buildOffersScript([offer({ position: 0, title: '</script><script>alert(1)</script>' })], {
      source: 'page',
      currency: 'EUR',
    });
    expect(tag).toContain('data-landinglab-engine="offers"');
    expect(tag.match(/<\/script>/g)).toHaveLength(1);
    expect(buildOffersScript([], { source: 'page', currency: 'EUR' })).toBe('');
  });
});
