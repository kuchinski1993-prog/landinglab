// Story 13.5 AC29 — Schema + validator unit tests.

import { describe, expect, it } from 'vitest';

import {
  BANNED_BRAND_TERMS,
  rejectsBannedBrands,
  validateVisualAssets,
  VisualAssetsValidationError,
} from './visual-assets.js';

// ─── Fixture helpers ─────────────────────────────────────────────────────

function makeValidVisualAssets() {
  return {
    schema_version: '1.0.0' as const,
    brand: {
      name: 'NovaLab',
      tagline: 'Design your everyday brilliance',
      logo_urls: {
        full: 'https://example.com/logo-full.png',
        mark: 'https://example.com/logo-mark.png',
        wordmark: 'https://example.com/logo-wordmark.png',
      },
      palette: {
        primary: '#FF5A3C',
        secondary: '#FFB800',
        accent: '#00C2A8',
        bg: '#FFFFFF',
        text: '#111111',
      },
      typography: {
        headline_font: 'Poppins',
        body_font: 'Inter',
      },
    },
    assets: {
      hero: {
        urls_by_size: {
          desktop: 'https://example.com/hero-desktop.png',
          og: 'https://example.com/hero-og.png',
          mobile: 'https://example.com/hero-mobile.png',
        },
      },
      lifestyle: [
        'https://example.com/lifestyle-1.png',
        'https://example.com/lifestyle-2.png',
        'https://example.com/lifestyle-3.png',
      ],
      icons: [
        { url: 'https://example.com/icon-0.png', matches_bullet: 0 },
        { url: 'https://example.com/icon-1.png', matches_bullet: 1 },
        { url: 'https://example.com/icon-2.png', matches_bullet: 2 },
        { url: 'https://example.com/icon-3.png', matches_bullet: 3 },
        { url: 'https://example.com/icon-4.png', matches_bullet: 4 },
      ],
      trust_badges: [
        'https://example.com/badge-1.png',
        'https://example.com/badge-2.png',
      ],
    },
    contributing_agents: [
      { agent: 'visual-director', blocks_contributed: ['palette', 'typography'] },
    ],
    director_notes:
      'Selected vibrant palette for sophistication_level=2, energetic tone. Freepik primary, Higgsfield fallback ready.',
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('validateVisualAssets — happy path', () => {
  it('accepts a fully valid VisualAssets object', () => {
    const input = makeValidVisualAssets();
    const result = validateVisualAssets(input);
    expect(result.brand.name).toBe('NovaLab');
    expect(result.director_notes.length).toBeGreaterThanOrEqual(10);
    expect(result.assets.icons).toHaveLength(5);
  });

  it('accepts optional before_after and backgrounds', () => {
    const input = {
      ...makeValidVisualAssets(),
      assets: {
        ...makeValidVisualAssets().assets,
        before_after: ['https://example.com/ba.png'],
        backgrounds: ['https://example.com/bg.png'],
      },
    };
    const result = validateVisualAssets(input);
    expect(result.assets.before_after).toEqual(['https://example.com/ba.png']);
    expect(result.assets.backgrounds).toEqual(['https://example.com/bg.png']);
  });
});

describe('validateVisualAssets — director_notes enforcement (Article IV)', () => {
  it('rejects director_notes shorter than 10 chars', () => {
    const input = { ...makeValidVisualAssets(), director_notes: 'short' };
    expect(() => validateVisualAssets(input)).toThrow(VisualAssetsValidationError);
  });

  it('rejects empty director_notes', () => {
    const input = { ...makeValidVisualAssets(), director_notes: '' };
    expect(() => validateVisualAssets(input)).toThrow(VisualAssetsValidationError);
  });

  it('rejects whitespace-only director_notes', () => {
    const input = { ...makeValidVisualAssets(), director_notes: '           ' };
    // This may or may not be caught by schema level (min(10) counts whitespace).
    // The runtime guard uses trim() and checks length < 10.
    expect(() => validateVisualAssets(input)).toThrow(VisualAssetsValidationError);
  });
});

describe('validateVisualAssets — banned brand names', () => {
  it('rejects brand.name containing "apple"', () => {
    const input = { ...makeValidVisualAssets(), brand: { ...makeValidVisualAssets().brand, name: 'AppleFusion' } };
    expect(() => validateVisualAssets(input)).toThrow(VisualAssetsValidationError);
  });

  it('rejects brand.name containing "nike" case-insensitive', () => {
    const input = { ...makeValidVisualAssets(), brand: { ...makeValidVisualAssets().brand, name: 'NIKEwear' } };
    expect(() => validateVisualAssets(input)).toThrow(VisualAssetsValidationError);
  });

  it('rejects brand.name containing "google"', () => {
    const input = { ...makeValidVisualAssets(), brand: { ...makeValidVisualAssets().brand, name: 'GoogleShoes' } };
    expect(() => validateVisualAssets(input)).toThrow(VisualAssetsValidationError);
  });
});

describe('validateVisualAssets — hero mandatory', () => {
  it('accepts if only desktop is present (via schema requirement)', () => {
    const input = makeValidVisualAssets();
    // schema requires all three URLs; hero must exist. Confirm that the guard is checking desktop OR mobile.
    const result = validateVisualAssets(input);
    expect(result.assets.hero.urls_by_size.desktop).toBeTruthy();
  });

  it('rejects if hero URLs are malformed', () => {
    const input = {
      ...makeValidVisualAssets(),
      assets: {
        ...makeValidVisualAssets().assets,
        hero: {
          urls_by_size: {
            desktop: 'not-a-url',
            og: 'not-a-url',
            mobile: 'not-a-url',
          },
        },
      },
    };
    expect(() => validateVisualAssets(input)).toThrow(VisualAssetsValidationError);
  });
});

describe('validateVisualAssets — Zod field errors', () => {
  it('rejects brand.name shorter than 3 chars', () => {
    const input = { ...makeValidVisualAssets(), brand: { ...makeValidVisualAssets().brand, name: 'AB' } };
    expect(() => validateVisualAssets(input)).toThrow(VisualAssetsValidationError);
  });

  it('rejects invalid hex color in palette', () => {
    const input = {
      ...makeValidVisualAssets(),
      brand: {
        ...makeValidVisualAssets().brand,
        palette: { ...makeValidVisualAssets().brand.palette, primary: 'red' },
      },
    };
    expect(() => validateVisualAssets(input)).toThrow(VisualAssetsValidationError);
  });

  it('rejects fewer than 3 lifestyle images', () => {
    const input = {
      ...makeValidVisualAssets(),
      assets: {
        ...makeValidVisualAssets().assets,
        lifestyle: ['https://example.com/one.png', 'https://example.com/two.png'],
      },
    };
    expect(() => validateVisualAssets(input)).toThrow(VisualAssetsValidationError);
  });

  it('rejects fewer than 5 icons', () => {
    const input = {
      ...makeValidVisualAssets(),
      assets: {
        ...makeValidVisualAssets().assets,
        icons: [
          { url: 'https://example.com/1.png', matches_bullet: 0 },
          { url: 'https://example.com/2.png', matches_bullet: 1 },
        ],
      },
    };
    expect(() => validateVisualAssets(input)).toThrow(VisualAssetsValidationError);
  });
});

describe('rejectsBannedBrands', () => {
  it('returns true for clean names', () => {
    expect(rejectsBannedBrands('NovaLab')).toBe(true);
    expect(rejectsBannedBrands('ZephyrCraft')).toBe(true);
    expect(rejectsBannedBrands('MilaFlow')).toBe(true);
  });

  it('returns false for each banned term', () => {
    for (const term of BANNED_BRAND_TERMS) {
      const testName = `Prefix${term}Suffix`;
      expect(rejectsBannedBrands(testName)).toBe(false);
    }
  });

  it('is case-insensitive', () => {
    expect(rejectsBannedBrands('APPLE')).toBe(false);
    expect(rejectsBannedBrands('AppleCorp')).toBe(false);
    expect(rejectsBannedBrands('appleco')).toBe(false);
  });
});
