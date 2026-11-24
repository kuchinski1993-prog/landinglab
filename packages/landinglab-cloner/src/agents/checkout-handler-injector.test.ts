// Tests do injectCheckoutHandler.
// Cobre: injeção antes de </body>, idempotência, preservação de conteúdo,
// resiliência a HTML sem <body>, compatibilidade com sanitizeHtml.

import { describe, expect, it } from 'vitest';

import { sanitizeHtml } from '../orchestrator.js';

import { injectCheckoutHandler } from './checkout-handler-injector.js';

describe('injectCheckoutHandler', () => {
  it('injeta script antes de </body>', () => {
    const html = '<html><body><h1>Landing</h1></body></html>';
    const out = injectCheckoutHandler(html);
    expect(out).toContain('__LL_CHECKOUT_API__');
    expect(out.indexOf('__LL_CHECKOUT_API__')).toBeLessThan(out.indexOf('</body>'));
  });

  it('inclui rota padrão /api/landing-checkout', () => {
    const out = injectCheckoutHandler('<body></body>');
    expect(out).toContain('/api/landing-checkout');
  });

  it('inclui proteção contra popups Chemistry Club e Alia recriados em runtime', () => {
    const out = injectCheckoutHandler('<html><head></head><body></body></html>');

    expect(out).toContain('#sc-subscribe-popup, .sc-popup-overlay');
    expect(out).toContain('[id^="alia-root-"], [id^="alia-popup-root-"]');
  });

  it('preserva conteúdo original intocado', () => {
    const html = '<html><body><h1>Título</h1><p>Texto</p></body></html>';
    const out = injectCheckoutHandler(html);
    expect(out).toContain('<h1>Título</h1>');
    expect(out).toContain('<p>Texto</p>');
  });

  it('fallback: append no fim quando não tem </body>', () => {
    const html = '<div>fragmento</div>';
    const out = injectCheckoutHandler(html);
    expect(out).toContain('<div>fragmento</div>');
    expect(out).toContain('__LL_CHECKOUT_API__');
  });

  it('idempotente: 2 chamadas não duplicam script', () => {
    const html = '<body></body>';
    const once = injectCheckoutHandler(html);
    const twice = injectCheckoutHandler(once);
    const matches = twice.match(/__LL_CHECKOUT_API__/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('sobrevive ao sanitizeHtml se aplicado ANTES (Fase 5.A.2)', () => {
    // Fase 5.A.2: sanitize agora preserva UX scripts + só remove trackers.
    // Ordem correta continua: sanitize primeiro, inject depois.
    const html =
      '<body><script src="https://googletagmanager.com/gtm.js"></script><h1>x</h1></body>';
    const sanitized = sanitizeHtml(html);
    const injected = injectCheckoutHandler(sanitized);
    // Tracker foi removido pelo sanitize
    expect(injected).not.toContain('googletagmanager');
    // Injeção do checkout ficou intacta
    expect(injected).toContain('__LL_CHECKOUT_API__');
  });

  it('script inclui coleta de attribution (fbp, fbc, fbclid, utm)', () => {
    const out = injectCheckoutHandler('<body></body>');
    expect(out).toContain('_fbp');
    expect(out).toContain('_fbc');
    expect(out).toContain('fbclid');
    expect(out).toContain('utm_source');
  });

  it('script inclui detecção de variant selector', () => {
    const out = injectCheckoutHandler('<body></body>');
    expect(out).toContain('data-landing-variant-id');
    expect(out).toContain('data-landing-cta');
  });

  it('script inclui fallback error UI (alert)', () => {
    const out = injectCheckoutHandler('<body></body>');
    expect(out).toContain('alert');
  });
});
