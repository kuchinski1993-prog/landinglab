// Story 16.3 — tracker do Sphere opt-in no sanitizador (AC 13/19e) e variante `external`
// do injector de checkout (AC 4/19c): sem POST /api/landing-checkout.
import { describe, expect, it } from 'vitest';

import { injectCheckoutHandler } from './agents/checkout-handler-injector.js';
import { SPHERE_TRACKER_URL, extractMissingStaticScripts, sanitizeHtml } from './orchestrator.js';

const TRACKER = `<script src="${SPHERE_TRACKER_URL}"></script>`;
const OTHER = '<script src="https://sphereaffiliate.com/api/public/other.js"></script>';
const INLINE = '<script>window.x="https://sphereaffiliate.com/api/collect"</script>';
const UX = '<script>document.querySelector(".faq")</script>';
const page = (head: string) => `<html><head>${head}</head><body><p>oi</p>${UX}</body></html>`;

describe('sanitizeHtml + tracker do Sphere', () => {
  it('URL do tracker fixa (paridade com @blackshop/shared/external-checkout testada no shared)', () => {
    expect(SPHERE_TRACKER_URL).toBe('https://sphereaffiliate.com/api/public/tracker.js');
  });

  it('flag desligada (chamada antiga sem 2º argumento) remove o tracker e qualquer sphereaffiliate', () => {
    const out = sanitizeHtml(page(TRACKER + OTHER + INLINE));
    expect(out).not.toContain('sphereaffiliate');
    expect(out).toContain(UX);
    expect(sanitizeHtml(page(TRACKER), { allowSphereTracker: false })).not.toContain('sphereaffiliate');
  });

  it('flag ligada preserva exatamente o tracker e remove outros scripts sphereaffiliate', () => {
    const out = sanitizeHtml(page(TRACKER + OTHER + INLINE), { allowSphereTracker: true });
    expect(out).toContain(TRACKER);
    expect(out).not.toContain('other.js');
    expect(out).not.toContain('api/collect');
    expect(out.match(/tracker\.js/g)).toHaveLength(1);
  });

  it('flag ligada injeta o tracker no <head> se ausente, de forma idempotente', () => {
    const once = sanitizeHtml(page('<title>t</title>'), { allowSphereTracker: true });
    expect(once).toMatch(/<head>(?:(?!<\/head>)[\s\S])*<script src="https:\/\/sphereaffiliate\.com\/api\/public\/tracker\.js"/);
    const twice = sanitizeHtml(once, { allowSphereTracker: true });
    expect(twice.match(/tracker\.js/g)).toHaveLength(1);
  });

  it('tracker com corpo inline ou em outro host/caminho não é tratado como o tracker exato', () => {
    const lookalike = '<script src="https://sphereaffiliate.com.evil.io/api/public/tracker.js"></script>';
    const withBody = `<script src="${SPHERE_TRACKER_URL}">alert(1)</script>`;
    const out = sanitizeHtml(page(lookalike + withBody), { allowSphereTracker: true });
    expect(out).not.toContain('alert(1)');
    expect(out).not.toContain('sphereaffiliate.com.evil.io');
  });

  it('extractMissingStaticScripts aplica a mesma regra', () => {
    const staticHtml = `<html><head>${TRACKER}${OTHER}<script src="https://cdn.example.com/app.js"></script></head></html>`;
    const off = extractMissingStaticScripts([], staticHtml, 'https://origem.com/');
    expect(off).toEqual(['https://cdn.example.com/app.js']);
    const on = extractMissingStaticScripts([], staticHtml, 'https://origem.com/', { allowSphereTracker: true });
    expect(on).toEqual([SPHERE_TRACKER_URL, 'https://cdn.example.com/app.js']);
  });
});

describe('injectCheckoutHandler provider external', () => {
  const html = '<html><head></head><body><a data-landing-cta="buy">Comprar</a></body></html>';

  it('não injeta o POST /api/landing-checkout nem __LL_CHECKOUT_API__, mas mantém CSS mobile/popup', () => {
    const out = injectCheckoutHandler(html, { provider: 'external' });
    expect(out).not.toContain('/api/landing-checkout');
    expect(out).not.toContain('__LL_CHECKOUT_API__');
    expect(out).toContain('id="ll-mobile-overflow-fix"');
    expect(out).toContain('id="ll-popup-kill"');
  });

  it('shopify/stripe/sem opção mantêm o script legado (não regressão)', () => {
    for (const out of [injectCheckoutHandler(html), injectCheckoutHandler(html, { provider: 'shopify' }), injectCheckoutHandler(html, { provider: 'stripe' })]) {
      expect(out).toContain('__LL_CHECKOUT_API__');
      expect(out).toContain('/api/landing-checkout');
    }
  });
});
