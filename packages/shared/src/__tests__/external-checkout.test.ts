// Story 16.3 — validador, parser, regra de repasse, tracker do Sphere e script do modo `external`
// (AC 2, 4, 5, 11, 12, 13, 19a/c/e/h).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  CHECKOUT_PROVIDERS,
  EXTERNAL_CHECKOUT_PASSTHROUGH,
  PROTECTED_DESTINATION_PARAMS,
  SPHERE_TRACKER_URL,
  applyExternalPassthrough,
  applySphereTrackerPolicy,
  buildExternalCheckoutScript,
  buildExternalCheckoutScriptBody,
  isCheckoutProvider,
  mergeExternalCheckoutIntoCtaConfig,
  missingExternalKits,
  normalizeCheckoutProvider,
  parseExternalCheckoutInput,
  readExternalCheckoutConfig,
  resolveDefaultKit,
  validateExternalCheckoutUrl,
  type ExternalCheckoutConfig,
} from '../external-checkout.js';

// Paridade (AC 11/19h): lê as listas espelhadas direto do fonte dos outros pacotes (sem import
// cruzado, para não alterar o rootDir do build de nenhum pacote).
const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');
const listOf = (rel: string, name: string): string[] => {
  const m = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(src(rel));
  if (!m?.[1]) throw new Error(`${name} não encontrado em ${rel}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]!);
};
const CHECKOUT_PARAMS = listOf('vsl-hosting/src/runtime.ts', 'CHECKOUT_PARAMS');
const DEFAULT_PASSTHROUGH = listOf('vsl-hosting/src/funnel-config.ts', 'DEFAULT_PASSTHROUGH');
const PROTECTED_VSL = listOf('vsl-hosting/src/funnel-config.ts', 'PROTECTED_DESTINATION_PARAMS');

describe('CheckoutProvider', () => {
  it('aceita shopify/stripe/external e normaliza o resto para shopify', () => {
    expect(CHECKOUT_PROVIDERS).toEqual(['shopify', 'stripe', 'external']);
    expect(isCheckoutProvider('external')).toBe(true);
    expect(isCheckoutProvider('paypal')).toBe(false);
    expect(normalizeCheckoutProvider('stripe')).toBe('stripe');
    expect(normalizeCheckoutProvider(null)).toBe('shopify');
    expect(normalizeCheckoutProvider('foo')).toBe('shopify');
  });
});

describe('validateExternalCheckoutUrl (AC 2/19a)', () => {
  it('aceita https público', () => {
    expect(validateExternalCheckoutUrl('https://aeterna-eu.shop/checkout?fn=abc')).toEqual({ ok: true, url: 'https://aeterna-eu.shop/checkout?fn=abc' });
    expect(validateExternalCheckoutUrl('https://boostert-eu.shop:443/c')).toMatchObject({ ok: true });
  });
  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    [42, 'empty'],
    ['nota url', 'invalid_url'],
    ['http://aeterna-eu.shop/c', 'not_https'],
    ['javascript:alert(1)', 'not_https'],
    ['https://user:pw@aeterna-eu.shop/c', 'credentials'],
    ['https://aeterna-eu.shop:8443/c', 'port'],
    ['https://127.0.0.1/c', 'host'],
    ['https://[::1]/c', 'host'],
    ['https://localhost/c', 'host'],
    ['https://shop.local/c', 'host'],
    ['https://intranet/c', 'host'],
    [`https://aeterna-eu.shop/${'a'.repeat(2050)}`, 'too_long'],
  ])('recusa %s (%s)', (raw, reason) => {
    expect(validateExternalCheckoutUrl(raw)).toEqual({ ok: false, reason });
  });
});

describe('parseExternalCheckoutInput (AC 2)', () => {
  it('aceita ao menos 1 kit válido; kits ausentes ficam pendentes; tracker default off', () => {
    const r = parseExternalCheckoutInput({ '1': 'https://a.shop/1', '3': '', '5': null });
    expect(r).toEqual({ ok: true, config: { '1': 'https://a.shop/1', allowSphereTracker: false } });
    if (r.ok) expect(missingExternalKits(r.config)).toEqual(['3', '5']);
  });
  it('URL inválida → erro com kit e motivo', () => {
    const r = parseExternalCheckoutInput({ '1': 'https://a.shop/1', '3': 'http://a.shop/3' });
    expect(r).toEqual({ ok: false, errors: [{ kit: '3', reason: 'só https é aceito' }] });
  });
  it('nenhum kit → erro', () => {
    expect(parseExternalCheckoutInput({})).toMatchObject({ ok: false, errors: [{ kit: 'config' }] });
    expect(parseExternalCheckoutInput(null)).toMatchObject({ ok: false });
  });
  it('default precisa apontar para kit configurado', () => {
    expect(parseExternalCheckoutInput({ '1': 'https://a.shop/1', default: '3' })).toMatchObject({ ok: false, errors: [{ kit: 'default' }] });
    expect(parseExternalCheckoutInput({ '1': 'https://a.shop/1', default: '7' })).toMatchObject({ ok: false });
    expect(parseExternalCheckoutInput({ '3': 'https://a.shop/3', default: '3', allowSphereTracker: true })).toEqual({
      ok: true,
      config: { '3': 'https://a.shop/3', default: '3', allowSphereTracker: true },
    });
  });
  it('allowSphereTracker não booleano → erro', () => {
    expect(parseExternalCheckoutInput({ '1': 'https://a.shop/1', allowSphereTracker: 'yes' })).toMatchObject({ ok: false });
  });
});

describe('readExternalCheckoutConfig / defaults', () => {
  it('revalida e descarta URLs inválidas do jsonb; preserva mappings no merge', () => {
    const cta = { mappings: [{ selector: 'a' }], lastRewriteAt: 'x', externalCheckout: { '1': 'http://evil.shop', '3': 'https://a.shop/3', default: '1', allowSphereTracker: 'true' } };
    expect(readExternalCheckoutConfig(cta)).toEqual({ '3': 'https://a.shop/3', allowSphereTracker: false });
    expect(readExternalCheckoutConfig(null)).toEqual({});
    expect(mergeExternalCheckoutIntoCtaConfig(cta, { '5': 'https://a.shop/5' })).toEqual({
      mappings: [{ selector: 'a' }],
      lastRewriteAt: 'x',
      externalCheckout: { '5': 'https://a.shop/5' },
    });
  });
  it('kit padrão: default → 1 → primeiro disponível → null', () => {
    expect(resolveDefaultKit({ '1': 'u', '3': 'u', default: '3' })).toBe('3');
    expect(resolveDefaultKit({ '1': 'u', '5': 'u' })).toBe('1');
    expect(resolveDefaultKit({ '5': 'u', '3': 'u' })).toBe('3');
    expect(resolveDefaultKit({})).toBeNull();
  });
});

describe('repasse de parâmetros (AC 10/11/19f/19h)', () => {
  it('paridade com CHECKOUT_PARAMS e DEFAULT_PASSTHROUGH do VSL', () => {
    expect([...EXTERNAL_CHECKOUT_PASSTHROUGH].sort()).toEqual([...CHECKOUT_PARAMS].sort());
    expect([...EXTERNAL_CHECKOUT_PASSTHROUGH].sort()).toEqual([...DEFAULT_PASSTHROUGH].sort());
    expect(EXTERNAL_CHECKOUT_PASSTHROUGH).toContain('ref');
    expect(EXTERNAL_CHECKOUT_PASSTHROUGH).not.toContain('fn');
    expect(PROTECTED_VSL).toEqual([...PROTECTED_DESTINATION_PARAMS]);
    // espelhos no backoffice (labels) e no runtime do browser do VSL
    expect(listOf('../apps/backoffice/src/lib/vsl/labels.ts', 'DEFAULT_PASSTHROUGH').sort()).toEqual([...EXTERNAL_CHECKOUT_PASSTHROUGH].sort());
    expect(src('../apps/vsl-storefront/browser/runtime.js')).toContain("'sck', 'ref']");
  });
  it('URL do tracker do Sphere igual ao espelho do cloner', () => {
    expect(src('landinglab-cloner/src/orchestrator.ts')).toContain(`SPHERE_TRACKER_URL = '${SPHERE_TRACKER_URL}'`);
  });
  it('repassa só o que está na página; nunca sobrescreve ref/fn do destino', () => {
    expect(applyExternalPassthrough('https://a.shop/c?fn=f1', '?ref=zjk&utm_source=x&foo=1')).toBe('https://a.shop/c?fn=f1&utm_source=x&ref=zjk');
    expect(applyExternalPassthrough('https://a.shop/c?fn=f1', '?utm_source=x')).toBe('https://a.shop/c?fn=f1&utm_source=x');
    expect(applyExternalPassthrough('https://a.shop/c?ref=prod&fn=f1', '?ref=visit&fn=hack')).toBe('https://a.shop/c?ref=prod&fn=f1');
  });
});

describe('tracker do Sphere (AC 13/19e)', () => {
  const tracker = `<script src="${SPHERE_TRACKER_URL}"></script>`;
  const other = '<script src="https://sphereaffiliate.com/api/public/other.js"></script>';
  const inline = '<script>fetch("https://sphereaffiliate.com/x")</script>';
  const html = `<html><head>${tracker}${other}${inline}<script src="/app.js"></script></head><body></body></html>`;

  it('flag desligada remove tracker e qualquer script sphereaffiliate', () => {
    const out = applySphereTrackerPolicy(html, false);
    expect(out).not.toContain('sphereaffiliate');
    expect(out).toContain('/app.js');
  });
  it('flag ligada preserva só o tracker exato', () => {
    const out = applySphereTrackerPolicy(html, true);
    expect(out).toContain(tracker);
    expect(out).not.toContain('other.js');
    expect(out).not.toContain('sphereaffiliate.com/x');
  });
  it('flag ligada injeta no <head> se ausente (uma vez)', () => {
    const out = applySphereTrackerPolicy('<html><head><title>t</title></head></html>', true);
    expect(out).toMatch(/<head><script src="https:\/\/sphereaffiliate\.com\/api\/public\/tracker\.js"/);
    expect(applySphereTrackerPolicy(out, true).match(/tracker\.js/g)).toHaveLength(1);
  });
});

// ── Script do modo external executado contra um DOM mínimo ───────────────────────────────
interface FakeEl {
  nodeType: 1;
  attrs: Record<string, string>;
  parentElement: FakeEl | null;
  getAttribute(n: string): string | null;
  closest(sel: string): FakeEl | null;
}
function el(attrs: Record<string, string>, parent: FakeEl | null = null): FakeEl {
  const node: FakeEl = {
    nodeType: 1,
    attrs,
    parentElement: parent,
    getAttribute: (n) => (n in attrs ? attrs[n]! : null),
    closest(sel) {
      for (let n: FakeEl | null = node; n; n = n.parentElement) {
        if (sel === '[data-landing-cta="buy"]' && n.attrs['data-landing-cta'] === 'buy') return n;
        if (sel === 'a[href]' && n.attrs.tag === 'a' && n.attrs.href !== undefined) return n;
      }
      return null;
    },
  };
  return node;
}

function run(config: ExternalCheckoutConfig, pageUrl: string, selected: FakeEl | null = null) {
  const listeners: Record<string, (ev: unknown) => void> = {};
  const assign = vi.fn();
  const loc = new URL(pageUrl);
  const win: Record<string, unknown> = {
    location: { href: loc.href, search: loc.search, origin: loc.origin, assign },
    addEventListener: (type: string, fn: (ev: unknown) => void, capture: boolean) => {
      expect(capture).toBe(true);
      listeners[type] = fn;
    },
  };
  const doc = { querySelector: () => selected };
  const body = buildExternalCheckoutScriptBody(config);
  new Function('window', 'document', body)(win, doc);
  const click = (target: FakeEl) => {
    const ev = { target, preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn() };
    listeners.click!(ev);
    return ev;
  };
  const submit = (target: FakeEl) => {
    const ev = { target, preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn() };
    listeners.submit!(ev);
    return ev;
  };
  return { assign, click, submit };
}

const CFG: ExternalCheckoutConfig = { '1': 'https://a.shop/p1?fn=f1', '3': 'https://a.shop/p3', '5': 'https://a.shop/p5?ref=prod' };

describe('script do modo external (AC 4/5/11/12/18/19c)', () => {
  it('não chama /api/landing-checkout, stripe nem __LL_CHECKOUT_API__', () => {
    const tag = buildExternalCheckoutScript(CFG);
    expect(tag).toContain('data-landinglab-engine="external-checkout"');
    expect(tag).not.toContain('/api/landing-checkout');
    expect(tag).not.toContain('__LL_CHECKOUT_API__');
    expect(tag.toLowerCase()).not.toContain('stripe');
  });
  it('sem kit válido → string vazia (CTA não reescrito)', () => {
    expect(buildExternalCheckoutScript({})).toBe('');
    expect(buildExternalCheckoutScript({ '1': 'http://a.shop' })).toBe('');
  });
  it('CTA com data-landing-kit navega para o kit, repassando só params da página', () => {
    const { assign, click } = run(CFG, 'https://lp.test.com/p?ref=zjk&utm_source=x&url=https://evil.com&next=//evil.com');
    const ev = click(el({ 'data-landing-cta': 'buy', 'data-landing-kit': '3' }));
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith('https://a.shop/p3?utm_source=x&ref=zjk');
  });
  it('kit herdado de ancestral (data-landing-pots); fn/ref do produtor preservados', () => {
    const { assign, click } = run(CFG, 'https://lp.test.com/p?ref=visit&fn=hack');
    const parent = el({ 'data-landing-pots': '5 potes' });
    click(el({ 'data-landing-cta': 'buy' }, parent));
    expect(assign).toHaveBeenCalledWith('https://a.shop/p5?ref=prod');
  });
  it('kit do bundle selecionado; sem ref na página não adiciona ref', () => {
    const { assign, click } = run(CFG, 'https://lp.test.com/p', el({ 'data-landing-qty': '3' }));
    click(el({ 'data-landing-cta': 'buy' }));
    expect(assign).toHaveBeenCalledWith('https://a.shop/p3');
  });
  it('kit indeterminado → default (1 pote); fn mantido', () => {
    const { assign, click } = run(CFG, 'https://lp.test.com/p?gclid=g');
    click(el({ 'data-landing-cta': 'buy', 'data-landing-kit': '2' }));
    expect(assign).toHaveBeenCalledWith('https://a.shop/p1?fn=f1&gclid=g');
  });
  it('default configurado vence o 1 pote', () => {
    const { assign, click } = run({ ...CFG, default: '5' }, 'https://lp.test.com/p');
    click(el({ 'data-landing-cta': 'buy' }));
    expect(assign).toHaveBeenCalledWith('https://a.shop/p5?ref=prod');
  });
  it('intercepta link relativo /checkout* e form /cart/add; ignora links externos', () => {
    const { assign, click, submit } = run(CFG, 'https://lp.test.com/p');
    click(el({ tag: 'a', href: '/checkouts/abc' }));
    submit(el({ action: '/cart/add' }));
    expect(assign).toHaveBeenCalledTimes(2);
    const ext = click(el({ tag: 'a', href: 'https://evil.com/checkout' }));
    const other = click(el({ tag: 'a', href: '/sobre' }));
    expect(ext.preventDefault).not.toHaveBeenCalled();
    expect(other.preventDefault).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledTimes(2);
  });
  it('mapa vem só do servidor: URL inválida no config nunca vira destino', () => {
    const { assign, click } = run({ '1': 'javascript:alert(1)', '3': 'https://a.shop/p3' } as ExternalCheckoutConfig, 'https://lp.test.com/p');
    click(el({ 'data-landing-cta': 'buy', 'data-landing-kit': '1' }));
    expect(assign).toHaveBeenCalledWith('https://a.shop/p3');
  });
  it('escapa </script> no mapa embutido', () => {
    const tag = buildExternalCheckoutScript({ '1': 'https://a.shop/x?q=</script><script>alert(1)' });
    expect(tag.match(/<\/script>/g)).toHaveLength(1);
  });
});
