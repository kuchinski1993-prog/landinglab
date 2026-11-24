import { describe, expect, it } from 'vitest';

import { validateVideoPlacement } from '../video-placement.js';

describe('VSL video placement', () => {
  const html = '<html><body><div id="hero"></div><section data-blackshop-video></section></body></html>';
  it('accepts one placeholder or configured selector', () => {
    expect(() => validateVideoPlacement(html, { strategy: 'PLACEHOLDER' })).not.toThrow();
    expect(() => validateVideoPlacement(html, { strategy: 'SELECTOR', selector: '#hero' })).not.toThrow();
  });
  it('rejects missing and ambiguous targets', () => {
    expect(() => validateVideoPlacement(html, { strategy: 'SELECTOR', selector: '.missing' })).toThrow();
    expect(() => validateVideoPlacement(html, { strategy: 'SELECTOR', selector: 'div,section' })).toThrow();
  });
});
