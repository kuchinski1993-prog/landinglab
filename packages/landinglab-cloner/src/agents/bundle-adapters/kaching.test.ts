import { describe, expect, it } from 'vitest';

import { kachingAdapter } from './kaching.js';

const DEAL_BARS_JSON = JSON.stringify([
  { id: 'A1', title: '1個購入', subtitle: '30日分' },
  { id: 'A2', title: '2個購入', subtitle: '60日分', isPreSelected: true },
]);

function makeHtml(extra = '') {
  return `<html><body>
<kaching-bundles-block></kaching-bundles-block>
<script id="kaching-bundles-config">var x=1;</script>
<script class="kaching-bundles-deal-block-settings" type="application/json">
  {"dealBars":${DEAL_BARS_JSON}}
</script>
<div class="kaching-bundles">
  <div class="kaching-bundles__bars">
    <div class="kaching-bundles__bar" data-deal-bar-id="A1">bar1</div>
    <div class="kaching-bundles__bar kaching-bundles__bar--selected" data-deal-bar-id="A2">bar2</div>
  </div>
  <div class="kaching-bundles__subscriptions">
    <span>PURCHASE OPTIONS</span>
    <span>One-time purchase</span>
    <span>Subscribe &amp; save</span>
  </div>
</div>
${extra}
</body></html>`;
}

describe('kachingAdapter', () => {
  it('detecta Kaching quando kaching-bundles-config está presente', () => {
    expect(kachingAdapter.detect(makeHtml())).toBe(true);
  });

  it('remove .kaching-bundles__subscriptions do HTML — bloco visual duplicado', () => {
    const result = kachingAdapter.apply(makeHtml());
    expect(result.html).not.toContain('kaching-bundles__subscriptions');
    expect(result.html).not.toContain('PURCHASE OPTIONS');
    expect(result.html).not.toContain('One-time purchase');
  });

  it('preserva os cards .kaching-bundles__bar com data-ll-offer', () => {
    const result = kachingAdapter.apply(makeHtml());
    expect(result.html).toContain('data-ll-offer="0"');
    expect(result.html).toContain('data-ll-offer="1"');
  });

  it('preserva data-landinglab-subs-widget quando presente', () => {
    const withSubs = makeHtml(
      '<div data-landinglab-subs-widget data-plan-id="9281962077" class="ll-subs">subs widget</div>',
    );
    const result = kachingAdapter.apply(withSubs);
    expect(result.html).toContain('data-landinglab-subs-widget');
    expect(result.html).toContain('9281962077');
  });

  it('remove scripts JS do Kaching', () => {
    const result = kachingAdapter.apply(makeHtml());
    expect(result.html).not.toContain('kaching-bundles-config');
    expect(result.html).not.toContain('kaching-bundles-deal-block-settings');
  });

  // Story 25.1 — raiz, título, badge e bullets (AC 2).
  it('marca a raiz do bloco, título, badge e bullets do card e extrai os bullets', () => {
    const html = makeHtml().replace(
      '<div class="kaching-bundles__bar" data-deal-bar-id="A1">bar1</div>',
      '<div class="kaching-bundles__bar" data-deal-bar-id="A1"><span class="kaching-bundles__bar-title">1個</span>' +
        '<span class="kaching-bundles__bar-badge">人気</span><ul><li> 送料無料 </li><li>30日保証</li></ul></div>',
    );
    const result = kachingAdapter.apply(html);
    expect(result.html).toMatch(/<div class="kaching-bundles" data-ll-bundle-root="">/);
    expect(result.html).toContain('<span class="kaching-bundles__bar-title" data-ll-title="">1個</span>');
    expect(result.html).toContain('data-ll-badge=""');
    expect(result.html).toContain('<ul data-ll-bullets="">');
    expect(result.offers[0]!.bullets).toEqual(['送料無料', '30日保証']);
    expect(result.offers[1]!.bullets).toEqual([]);
    // A raiz é única e não engole o widget de assinatura que fica fora do bloco.
    expect(result.html.match(/data-ll-bundle-root/g)).toHaveLength(1);
  });

  it('sem cards estáticos: a raiz é o <kaching-bundles-block>', () => {
    const html = makeHtml().replace(/<div class="kaching-bundles">[\s\S]*?<\/div>\n<\/div>/, '');
    const result = kachingAdapter.apply(html.replace('<div class="kaching-bundles__bar"', '<i'));
    expect(result.html).toContain('<kaching-bundles-block data-ll-bundle-root="">');
  });
});
