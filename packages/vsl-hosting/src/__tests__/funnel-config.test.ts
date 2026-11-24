import { describe, expect, it } from 'vitest';

import {
  buildCheckoutUrl, collectStepPublishWarnings, DEFAULT_NATIVE_CTA_LABEL, DEFAULT_PASSTHROUGH, DEFAULT_VSL_PLAYER, resolveNativeCtaLabel, resolvePlayerConfig, validateCheckoutConfig,
  validateCtaConfig, validateCtaTargets, validateExternalHttps, validatePlayerConfig, validateTrackingConfig, validateVideoPlacementConfig,
} from '../funnel-config.js';
import { validatePublishSteps } from '../publication.js';
import { STREAM_PLAYER_SOURCE } from '../stream-player.js';

describe('VSL funnel configuration', () => {
  it('accepts generic HTTPS checkout and forwards only permitted parameters', () => {
    const checkout = validateCheckoutConfig({ url: 'https://pay.example.com/order?affiliate=abc',
      allowedParams: ['utm_source', 'custom'], customParams: { campaign: 'fixed' } }, true)!;
    const result = new URL(buildCheckoutUrl(checkout, new URLSearchParams('utm_source=ad&custom=ok&secret=no')));
    expect(result.searchParams.get('affiliate')).toBe('abc');
    expect(result.searchParams.get('utm_source')).toBe('ad');
    expect(result.searchParams.get('custom')).toBe('ok');
    expect(result.searchParams.get('campaign')).toBe('fixed');
    expect(result.searchParams.has('secret')).toBe(false);
  });
  it('rejects unsafe destinations and malformed CTA actions', () => {
    for (const url of ['http://pay.example.com', 'https://localhost/pay', 'https://127.0.0.1/pay', 'https://user:pass@pay.example.com'])
      expect(() => validateExternalHttps(url)).toThrow();
    expect(() => validateCtaConfig({ ctas: [{ id: 'next', selectors: ['[data-blackshop-cta]'], unlockAfterSeconds: 15,
      action: { type: 'NEXT_STEP' } }] }, false, false)).toThrow('missing');
    expect(validateCtaConfig({ ctas: [{ id: 'next', selectors: ['[data-blackshop-cta]'], unlockAfterSeconds: 15,
      action: { type: 'NEXT_STEP' } }] }, true, false).ctas).toHaveLength(1);
  });
  it('validates structured pixel IDs', () => {
    expect(validateTrackingConfig({ metaPixelId: '123456', googleAdsId: 'AW-123', tiktokPixelId: 'TK123' })).toHaveProperty('metaPixelId', '123456');
    expect(() => validateTrackingConfig({ customScript: '<script></script>' })).toThrow();
  });
  it('Story 16.3 (AC 10): ref forwarded only when on the page URL, never overwrites ref/fn of the destination', () => {
    expect(DEFAULT_PASSTHROUGH).toContain('ref');
    const ext = { url: 'https://aeterna-eu.shop/checkout?fn=f1' };
    expect(buildCheckoutUrl(ext, new URLSearchParams('ref=zjkzngqs1&utm_source=x'))).toBe('https://aeterna-eu.shop/checkout?fn=f1&utm_source=x&ref=zjkzngqs1');
    expect(buildCheckoutUrl(ext, new URLSearchParams('utm_source=x'))).toBe('https://aeterna-eu.shop/checkout?fn=f1&utm_source=x');
    expect(buildCheckoutUrl({ url: 'https://a.shop/c?ref=prod&fn=f1' }, new URLSearchParams('ref=visit&fn=hack'))).toBe('https://a.shop/c?ref=prod&fn=f1');
    expect(buildCheckoutUrl({ url: 'https://a.shop/c', allowedParams: ['utm_source'] }, new URLSearchParams('ref=zjk&utm_source=x'))).toBe('https://a.shop/c?utm_source=x');
  });

  it('forwards Hotmart/Kiwify src and sck by default', () => {
    expect(DEFAULT_PASSTHROUGH).toEqual(expect.arrayContaining(['src', 'sck', 'ttclid']));
    const url = new URL(buildCheckoutUrl({ url: 'https://pay.hotmart.com/X1' }, new URLSearchParams('src=ads&sck=abc&other=no')));
    expect(url.searchParams.get('src')).toBe('ads');
    expect(url.searchParams.get('sck')).toBe('abc');
    expect(url.searchParams.has('other')).toBe(false);
  });
  it('lets the ad value win over fixed checkout params (URL and customParams), keeping fixed ones when absent', () => {
    const config = { url: 'https://pay.hotmart.com/X1?sck=fixed&src=fixed', customParams: { utm_source: 'fixed', coupon: 'VIP' } };
    const fromAd = new URL(buildCheckoutUrl(config, new URLSearchParams('sck=ad&utm_source=fb')));
    expect(fromAd.searchParams.get('sck')).toBe('ad');
    expect(fromAd.searchParams.get('utm_source')).toBe('fb');
    expect(fromAd.searchParams.get('src')).toBe('fixed');
    expect(fromAd.searchParams.get('coupon')).toBe('VIP');
    const noAd = new URL(buildCheckoutUrl(config, new URLSearchParams('sck=')));
    expect(noAd.searchParams.get('sck')).toBe('fixed');
    expect(noAd.searchParams.get('utm_source')).toBe('fixed');
  });
  it('accepts keepOriginalTrackers as a boolean flag only', () => {
    expect(validateTrackingConfig({ keepOriginalTrackers: true, metaPixelId: '123456' })).toHaveProperty('keepOriginalTrackers', true);
    expect(() => validateTrackingConfig({ keepOriginalTrackers: 'yes' })).toThrow();
  });
  it('accepts optional waitSelectors (0..10, same selector rule) and checks them in the static HTML', () => {
    const rule = { id: 'buy', selectors: ['#qzCta'], unlockAfterSeconds: 30, action: { type: 'CHECKOUT' } };
    expect(validateCtaConfig({ ctas: [{ ...rule, waitSelectors: ['#qzWait', '.qz__wait'] }] }, false, true).ctas[0]!.waitSelectors).toEqual(['#qzWait', '.qz__wait']);
    expect(validateCtaConfig({ ctas: [{ ...rule, waitSelectors: [] }] }, false, true).ctas).toHaveLength(1);
    for (const waitSelectors of ['#qzWait', Array.from({ length: 11 }, (_, i) => `#w${i}`), [''], ['a{}'], ['<b>'], ['x'.repeat(201)], ['#a\u0001'], [1], null])
      expect(() => validateCtaConfig({ ctas: [{ ...rule, waitSelectors }] }, false, true)).toThrow('Invalid CTA rule');
    const config = validateCtaConfig({ ctas: [{ ...rule, waitSelectors: ['#absent'] }] }, false, true);
    expect(validateCtaTargets('<a id="qzCta">x</a>', config).dynamicSelectors).toEqual([]); // aviso ausente não vira alerta
    expect(() => validateCtaTargets('<a id="qzCta">x</a>', { ctas: [{ ...config.ctas[0]!, waitSelectors: ['div[[['] }] })).toThrow('Invalid CTA wait selector');
  });
  it('reports CTA selectors absent from static HTML as dynamic instead of failing', () => {
    const config = validateCtaConfig({ ctas: [{ id: 'quiz', selectors: ['.late-cta', '#static'], unlockAfterSeconds: 0, action: { type: 'CHECKOUT' } }] }, false, true);
    const report = validateCtaTargets('<html><body><a id="static">x</a></body></html>', config);
    expect(report.dynamicSelectors).toEqual([{ ctaId: 'quiz', selector: '.late-cta' }]);
    expect(() => validateCtaTargets('<p></p>', { ctas: [{ id: 'x', selectors: ['a[[['], unlockAfterSeconds: 0, action: { type: 'CHECKOUT' } }] })).toThrow('Invalid CTA selector');
  });
  it('collects publish-check warnings for dynamic selectors and timed CTA without video', () => {
    const ctaConfig = { ctas: [{ id: 'buy', selectors: ['.late'], unlockAfterSeconds: 30, action: { type: 'CHECKOUT' } }] };
    const warnings = collectStepPublishWarnings({ ctaConfig, html: '<p></p>', hasVideo: false });
    expect(warnings.map((warning) => warning.code)).toEqual(['CTA_SELECTOR_DYNAMIC', 'CTA_TIMED_WITHOUT_VIDEO']);
    expect(collectStepPublishWarnings({ ctaConfig, html: '<a class="late"></a>', hasVideo: true })).toEqual([]);
    expect(collectStepPublishWarnings({ ctaConfig: {}, hasVideo: false })).toEqual([]);
  });
  it('validates the VTurb-style player config with sensible defaults', () => {
    expect(validatePlayerConfig(undefined)).toEqual({ ...DEFAULT_VSL_PLAYER, texts: {} });
    const player = validatePlayerConfig({ autoplayMuted: false, barColor: '#00ff00', poster: 'https://cdn.example.com/p.jpg', aspectRatio: '9:16', locale: 'es', texts: { unmute: 'Toca para oír' } });
    expect(player).toMatchObject({ autoplayMuted: false, fakeProgress: true, resume: true, barColor: '#00ff00', aspectRatio: '9:16', locale: 'es' });
    expect(player.texts.unmute).toBe('Toca para oír');
    for (const bad of [{ unknown: true }, { autoplayMuted: 'yes' }, { barColor: 'red' }, { poster: 'http://cdn.example.com/p.jpg' }, { aspectRatio: '2:1' },
      { locale: 'xx' }, { texts: { unmute: '<b>x</b>' } }, { texts: { other: 'x' } }, { texts: { unmute: 'x'.repeat(81) } }, []])
      expect(() => validatePlayerConfig(bad)).toThrow();
    expect(resolvePlayerConfig({ barColor: 'javascript:alert(1)' })).toEqual({ ...DEFAULT_VSL_PLAYER, texts: {} });
  });
  it('VSL-14: playback speed only from the allowed list (max 1.25x, anti-antecipação)', () => {
    expect(validatePlayerConfig(undefined).playbackRate).toBe(1);
    expect(validatePlayerConfig({ playbackRate: 1.15 }).playbackRate).toBe(1.15);
    for (const playbackRate of [1.3, 2, 0.5, '1.15', 1.12, null]) expect(() => validatePlayerConfig({ playbackRate })).toThrow('Invalid player playback rate');
  });
  it('VSL-14: buy buttons managed by the panel (label, default time, inheritance) and legacy rules side by side', () => {
    const managed = { id: 'buy-1', selectors: ['a.p1'], unlockAfterSeconds: 3488, action: { type: 'EXTERNAL_URL', url: 'https://pay.hotmart.com/X' }, managed: true, inheritsDefault: true, label: '1 pote' };
    const legacy = { id: 'cta-1', selectors: ['#buy'], unlockAfterSeconds: 60, action: { type: 'CHECKOUT' } };
    const config = validateCtaConfig({ defaultUnlockAfterSeconds: 3488, ctas: [managed, legacy] }, true, true);
    expect(config.defaultUnlockAfterSeconds).toBe(3488);
    expect(config.ctas[0]).toMatchObject({ managed: true, inheritsDefault: true, label: '1 pote' });
    expect(config.ctas[1]).not.toHaveProperty('managed');
    for (const bad of [{ defaultUnlockAfterSeconds: -1 }, { defaultUnlockAfterSeconds: 7201 }, { defaultUnlockAfterSeconds: 1.5 }])
      expect(() => validateCtaConfig({ ...bad, ctas: [managed] }, true, true)).toThrow('Invalid CTA default time');
    for (const rule of [{ ...managed, label: '<b>x</b>' }, { ...managed, label: 'x'.repeat(61) }, { ...managed, label: '  ' }, { ...managed, managed: 'yes' }, { ...managed, inheritsDefault: 1 }])
      expect(() => validateCtaConfig({ ctas: [rule] }, true, true)).toThrow();
  });
  it('validates video placement including the player block', () => {
    expect(validateVideoPlacementConfig({ strategy: 'SELECTOR', selector: '#video', player: { resume: false } })).toMatchObject({ strategy: 'SELECTOR' });
    expect(() => validateVideoPlacementConfig({ strategy: 'TOP' })).toThrow();
    expect(() => validateVideoPlacementConfig({ strategy: 'PLACEHOLDER', player: { hideControls: 1 } })).toThrow();
    expect(() => validateVideoPlacementConfig({ strategy: 'SELECTOR', selector: 'a{}' })).toThrow();
  });
  it('validates the dedicated player page CTA label and falls back to "Continuar" at runtime', () => {
    expect(validateVideoPlacementConfig({ ctaLabel: '¡Quiero activar mi beca!' })).toEqual({ ctaLabel: '¡Quiero activar mi beca!' });
    for (const bad of ['', '   ', '<b>x</b>', 'x'.repeat(61), 'a\nb', 42])
      expect(() => validateVideoPlacementConfig({ ctaLabel: bad })).toThrow();
    expect(resolveNativeCtaLabel('  ¡Quiero activar mi beca!  ')).toBe('¡Quiero activar mi beca!');
    for (const stored of [undefined, null, '', '<script>', 'x'.repeat(61)]) expect(resolveNativeCtaLabel(stored)).toBe(DEFAULT_NATIVE_CTA_LABEL);
  });
  it('builds the Stream iframe URL from player options without trusting arbitrary values', async () => {
    const module = await import(`data:text/javascript;base64,${Buffer.from(STREAM_PLAYER_SOURCE).toString('base64')}`) as {
      vslStreamIframeUrl: (base: URL, options: Record<string, unknown>) => URL };
    const base = new URL(`https://customer-demo.cloudflarestream.com/${'a'.repeat(32)}/iframe`);
    const url = module.vslStreamIframeUrl(base, { autoplay: true, muted: true, controls: false, primaryColor: '#E11D48', poster: 'https://cdn.example.com/p.jpg', preload: 'auto' });
    expect(Object.fromEntries(url.searchParams)).toEqual({ autoplay: 'true', muted: 'true', controls: 'false', primaryColor: '#E11D48', poster: 'https://cdn.example.com/p.jpg', preload: 'auto' });
    expect(module.vslStreamIframeUrl(base, { primaryColor: 'red;x', poster: 'javascript:alert(1)', preload: 'x' }).search).toBe('');
  });
  it('rejects an invalid player block at publish', () => {
    const step = { id: '11111111-1111-4111-8111-111111111111', project_id: 'p', position: 0, name: 'VSL', type: 'VSL', pathname: '/vsl', status: 'ready',
      render_mode: 'NATIVE_VIDEO', page_revision_id: null, video_asset_id: 'v', video_placement: { strategy: 'DEDICATED', player: { barColor: 'red' } },
      checkout_config: {}, cta_config: {}, tracking_config: {}, next_step_id: null };
    expect(() => validatePublishSteps([step])).toThrow('Invalid player color');
    expect(() => validatePublishSteps([{ ...step, video_placement: { strategy: 'DEDICATED', player: { barColor: '#112233' } } }])).not.toThrow();
  });
});
