import { describe, expect, it } from 'vitest';

import {
  buildLandinglabBundleHtml,
  injectLandinglabBundle,
  type LandinglabBundleConfig,
} from './landinglab-bundle-injector.js';

const baseConfig: LandinglabBundleConfig = {
  currency: 'EUR',
  locale: 'it',
  bundles: [
    {
      name: '1 unità',
      description: 'Prova',
      priceCents: 3400,
      compareAtPriceCents: 6750,
      quantityUnits: 1,
      highlight: null,
    },
    {
      name: 'Compra 2 ricevi 1',
      description: 'Più popolare',
      priceCents: 6800,
      compareAtPriceCents: 20250,
      quantityUnits: 3,
      highlight: 'popular',
    },
    {
      name: 'Compra 3 ricevi 2',
      description: 'Miglior offerta',
      priceCents: 9900,
      compareAtPriceCents: 33750,
      quantityUnits: 5,
      highlight: 'best',
    },
  ],
};

describe('buildLandinglabBundleHtml', () => {
  it('renders 3 slots with correct localized labels', () => {
    const html = buildLandinglabBundleHtml(baseConfig);
    expect(html).toContain('data-landinglab-bundle="v1"');
    expect(html).toContain('Aggiungi al carrello'); // it locale
    expect(html).toContain('Più popolare');
    expect(html).toContain('Miglior offerta');
    // 3 slots
    expect(html.match(/data-slot-index=/g)).toHaveLength(3);
    // Prices formatted with € symbol
    expect(html).toContain('€34.00');
    expect(html).toContain('€68.00');
    expect(html).toContain('€99.00');
    // Compare prices
    expect(html).toContain('€67.50');
    expect(html).toContain('€202.50');
  });

  it('emits subs toggle with hidden selling_plan when enabled', () => {
    const html = buildLandinglabBundleHtml({
      ...baseConfig,
      subs: { enabled: true, sellingPlanId: '8377761885', discountPct: 20 },
    });
    expect(html).toContain('data-selling-plan-id="8377761885"');
    expect(html).toContain('name="selling_plan"');
    expect(html).toContain('Abbonati e risparmia 20%');
  });

  it('omits subs toggle when disabled', () => {
    const html = buildLandinglabBundleHtml({
      ...baseConfig,
      subs: { enabled: false, sellingPlanId: null, discountPct: 20 },
    });
    expect(html).not.toContain('data-landinglab-subs-check');
    expect(html).not.toContain('name="selling_plan"');
  });

  it('escapes HTML in slot name/description', () => {
    const html = buildLandinglabBundleHtml({
      ...baseConfig,
      bundles: [
        {
          ...baseConfig.bundles[0]!,
          name: '<script>alert(1)</script>',
          description: '"onmouseover"',
        },
      ],
    });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;onmouseover&quot;');
    expect(html).not.toContain('<script>alert(1)');
  });
});

describe('injectLandinglabBundle', () => {
  it('replaces kaching-bundles-block when present', () => {
    const html = `<html><body>
      <kaching-bundles-block data-x="1">
        <div data-deal-bar-id="a">A</div>
        <div data-deal-bar-id="b">B</div>
      </kaching-bundles-block>
    </body></html>`;
    const r = injectLandinglabBundle(html, baseConfig);
    expect(r.replaced).toBe(true);
    expect(r.strategy).toBe('replace');
    expect(r.html).not.toContain('kaching-bundles-block');
    expect(r.html).toContain('data-landinglab-bundle="v1"');
  });

  it('replaces cc-pdp-offers wrapper (aurivita custom theme)', () => {
    const html = `<html><body>
      <div class="cc-pdp-offers">
        <div class="cc-pdp-offer">Offer 1</div>
        <div class="cc-pdp-offer">Offer 2</div>
      </div>
    </body></html>`;
    const r = injectLandinglabBundle(html, baseConfig);
    expect(r.replaced).toBe(true);
    expect(r.strategy).toBe('replace');
    expect(r.html).not.toContain('cc-pdp-offers');
  });

  it('injects before cart form when no known bundle selector matches', () => {
    const html = `<html><body>
      <form action="/cart/add" method="post"><button>Buy</button></form>
    </body></html>`;
    const r = injectLandinglabBundle(html, baseConfig);
    expect(r.replaced).toBe(true);
    expect(r.strategy).toBe('inject-before-form');
    expect(r.html.indexOf('data-landinglab-bundle="v1"')).toBeLessThan(
      r.html.indexOf('<form action="/cart/add"'),
    );
  });

  it('returns replaced=false when bundles config empty', () => {
    const html = `<html><body><p>Content</p></body></html>`;
    const r = injectLandinglabBundle(html, { ...baseConfig, bundles: [] });
    expect(r.replaced).toBe(false);
    expect(r.html).toBe(html);
  });

  it('falls back to append-body when no anchors', () => {
    const html = `<html><body><p>Only text</p></body></html>`;
    const r = injectLandinglabBundle(html, baseConfig);
    expect(r.replaced).toBe(true);
    expect(r.strategy).toBe('append-body');
    expect(r.html).toContain('data-landinglab-bundle="v1"');
  });
});
