// Story 13.6 AC28 (Wave 2 partial) — BuildOutput Zod schema tests.

import { describe, expect, it } from 'vitest';

import {
  BuildOutputSchema,
  BuildMetadataSchema,
  SeoTagsSchema,
  validateBuildOutput,
  BuildOutputValidationError,
} from './build-output.js';

function makeValidTags() {
  return {
    meta_description:
      'Discover our proven formula that transforms your daily routine into a joyful ritual.',
    canonical_url: 'https://example.com/product',
    open_graph: {
      title: 'Brand — The best thing since sliced bread',
      description:
        'Discover our proven formula that transforms your daily routine into a joyful ritual.',
      image: 'https://cdn.example.com/hero.png',
      type: 'product',
      locale: 'en_EN',
    },
    twitter_card: {
      card: 'summary_large_image' as const,
      title: 'Brand — The best thing since sliced bread',
      description:
        'Discover our proven formula that transforms your daily routine into a joyful ritual.',
      image: 'https://cdn.example.com/hero.png',
    },
    hreflang: [{ lang: 'en', href: 'https://example.com/product' }],
    jsonld_product: { name: 'Product' },
  };
}

function makeValidMetadata() {
  return {
    template_used: 'long-form-advertorial' as const,
    generation_notes:
      'template=long-form-advertorial reason="high sophistication" seoScores={"meta_length":80,"jsonld_present":true,"hreflang_count":1} optimizations=preconnect,srcset htmlSize=15000',
    agents_used: ['template-selector', 'content-composer', 'html-builder'],
    seo_scores: { meta_length: 80, jsonld_present: true, hreflang_count: 1 },
  };
}

function makeValidOutput() {
  return {
    language: 'en',
    html: '<!DOCTYPE html><html>' + 'x'.repeat(500) + '</html>',
    metadata: makeValidMetadata(),
    seo_tags: makeValidTags(),
  };
}

describe('BuildOutputSchema', () => {
  it('happy path passes', () => {
    const parsed = validateBuildOutput(makeValidOutput());
    expect(parsed.language).toBe('en');
    expect(parsed.metadata.template_used).toBe('long-form-advertorial');
  });

  it('meta_description > 160 chars is rejected', () => {
    const tags = makeValidTags();
    tags.meta_description = 'x'.repeat(180);
    const result = SeoTagsSchema.safeParse(tags);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('meta_description'))).toBe(true);
    }
  });

  it('meta_description < 50 chars is rejected', () => {
    const tags = makeValidTags();
    tags.meta_description = 'Too short';
    const result = SeoTagsSchema.safeParse(tags);
    expect(result.success).toBe(false);
  });

  it('template_used not in enum is rejected', () => {
    const invalid = makeValidMetadata();
    (invalid as unknown as { template_used: string }).template_used = 'made-up-template';
    const result = BuildMetadataSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('generation_notes < 10 chars is rejected (Article IV)', () => {
    const invalid = makeValidMetadata();
    invalid.generation_notes = 'short';
    const result = BuildMetadataSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('validateBuildOutput throws BuildOutputValidationError on failure', () => {
    const bad = { ...makeValidOutput(), html: 'tiny' };
    expect(() => validateBuildOutput(bad)).toThrow(BuildOutputValidationError);
  });

  it('BuildOutputSchema accepts optional seo_tags omitted', () => {
    const output = makeValidOutput();
    delete (output as { seo_tags?: unknown }).seo_tags;
    const parsed = BuildOutputSchema.parse(output);
    expect(parsed.seo_tags).toBeUndefined();
  });
});
