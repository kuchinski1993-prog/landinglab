// AC5 — computeSubdomainHostname unit tests.

import { describe, expect, it } from 'vitest';

import {
  computeSubdomainHostname,
  sanitizeSlug,
  RESERVED_SUBDOMAINS,
  ROOT_DOMAIN,
  verificationUrlFor,
} from './shared.js';

describe('sanitizeSlug', () => {
  it('lowercases and normalizes ASCII', () => {
    expect(sanitizeSlug('Whitening-STRIPS')).toBe('whitening-strips');
  });

  it('collapses consecutive dashes and trims edges', () => {
    expect(sanitizeSlug('--foo___bar!!baz--')).toBe('foo-bar-baz');
  });

  it('strips diacritics (é → e)', () => {
    expect(sanitizeSlug('café-latté')).toBe('cafe-latte');
  });
});

describe('computeSubdomainHostname', () => {
  it('returns {slug}.landinglab.app for a happy input', () => {
    expect(computeSubdomainHostname('whitening-strips', 'en')).toBe(
      `whitening-strips.${ROOT_DOMAIN}`,
    );
  });

  it('preserves the -{lang} suffix Squad 4 puts on variants', () => {
    expect(computeSubdomainHostname('whitening-strips-de', 'de')).toBe(
      `whitening-strips-de.${ROOT_DOMAIN}`,
    );
  });

  it('sanitizes non-ASCII input', () => {
    expect(computeSubdomainHostname('Café Frappé!', 'en')).toBe(
      `cafe-frappe.${ROOT_DOMAIN}`,
    );
  });

  it('appends -lp for reserved subdomains', () => {
    for (const reserved of RESERVED_SUBDOMAINS) {
      expect(computeSubdomainHostname(reserved, 'en')).toBe(
        `${reserved}-lp.${ROOT_DOMAIN}`,
      );
    }
  });

  it('truncates + hashes when label exceeds 63 chars', () => {
    const longSlug = 'a'.repeat(80);
    const hostname = computeSubdomainHostname(longSlug, 'en');
    const label = hostname.split('.')[0];
    expect(label.length).toBeLessThanOrEqual(63);
    expect(hostname.endsWith(`.${ROOT_DOMAIN}`)).toBe(true);
    // Same input twice → same hostname (deterministic hash).
    expect(computeSubdomainHostname(longSlug, 'en')).toBe(hostname);
    // Different content produces a different hash suffix.
    const otherLong = 'b'.repeat(80);
    expect(computeSubdomainHostname(otherLong, 'en')).not.toBe(hostname);
  });

  it('handles mixed-case + special chars combined', () => {
    expect(computeSubdomainHostname('  Foo___Bar!! ', 'en')).toBe(
      `foo-bar.${ROOT_DOMAIN}`,
    );
  });

  it('throws when sanitization yields an empty label', () => {
    expect(() => computeSubdomainHostname('!!!___---!!!', 'en')).toThrow(
      /empty label/i,
    );
  });

  it('contentLanguage is not encoded in hostname (Squad 4 handles variants)', () => {
    // Same slug, different content_language values → same hostname.
    expect(computeSubdomainHostname('slug', 'en')).toBe(
      computeSubdomainHostname('slug', 'de'),
    );
  });
});

describe('verificationUrlFor', () => {
  it('prefixes https:// to hostname', () => {
    expect(verificationUrlFor('foo.landinglab.app')).toBe(
      'https://foo.landinglab.app',
    );
  });
});
