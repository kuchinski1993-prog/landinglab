// Schema tests — validateCopyDeck happy path + Article IV enforcement + bounds.

import { describe, expect, it } from 'vitest';

import { makeValidCopyDeck } from '../__fixtures__/copy-deck.js';
import { CopyDeckValidationError, CopyDeckSchema, validateCopyDeck } from './copy-deck.js';

describe('validateCopyDeck — happy path', () => {
  it('accepts a fully valid CopyDeck fixture', () => {
    const deck = makeValidCopyDeck();
    const validated = validateCopyDeck(deck);
    expect(validated.language).toBe('en');
    expect(validated.hooks).toHaveLength(3);
    expect(validated.ctas).toHaveLength(3);
    expect(validated.faq.length).toBeGreaterThanOrEqual(5);
    expect(validated.voc_verbatim_used.length).toBeGreaterThanOrEqual(3);
  });

  it('applies default schema_version when omitted', () => {
    const deck = makeValidCopyDeck();
    // Strip schema_version to test default.
    const noVersion = { ...deck } as Record<string, unknown>;
    delete noVersion['schema_version'];
    const parsed = CopyDeckSchema.parse(noVersion);
    expect(parsed.schema_version).toBe('1.0.0');
  });
});

describe('validateCopyDeck — Article IV (No Invention)', () => {
  it('rejects when voc_verbatim_used has fewer than 3 entries', () => {
    const deck = makeValidCopyDeck({
      voc_verbatim_used: ['only one verbatim'],
    });
    expect(() => validateCopyDeck(deck)).toThrow(CopyDeckValidationError);
  });

  it('rejects when voc_verbatim_used is empty', () => {
    const deck = makeValidCopyDeck({ voc_verbatim_used: [] });
    expect(() => validateCopyDeck(deck)).toThrow(CopyDeckValidationError);
  });

  it('rejects when any verbatim entry is shorter than 3 chars', () => {
    const deck = makeValidCopyDeck({
      voc_verbatim_used: ['ab', 'ok verbatim one', 'ok verbatim two'],
    });
    expect(() => validateCopyDeck(deck)).toThrow(CopyDeckValidationError);
  });

  it('provides Zod issues on the thrown error', () => {
    const deck = makeValidCopyDeck({ voc_verbatim_used: [] });
    try {
      validateCopyDeck(deck);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CopyDeckValidationError);
      const zErr = err as CopyDeckValidationError;
      expect(zErr.issues.length).toBeGreaterThan(0);
    }
  });
});

describe('validateCopyDeck — array bounds', () => {
  it('rejects less than 3 hooks', () => {
    const deck = makeValidCopyDeck();
    const bad = { ...deck, hooks: deck.hooks.slice(0, 2) };
    expect(() => validateCopyDeck(bad)).toThrow(CopyDeckValidationError);
  });

  it('rejects more than 3 hooks', () => {
    const deck = makeValidCopyDeck();
    const bad = { ...deck, hooks: [...deck.hooks, deck.hooks[0]!] };
    expect(() => validateCopyDeck(bad)).toThrow(CopyDeckValidationError);
  });

  it('rejects fewer than 5 benefit_bullets', () => {
    const deck = makeValidCopyDeck();
    const bad = { ...deck, benefit_bullets: deck.benefit_bullets.slice(0, 4) };
    expect(() => validateCopyDeck(bad)).toThrow(CopyDeckValidationError);
  });

  it('rejects fewer than 5 faq items', () => {
    const deck = makeValidCopyDeck();
    const bad = { ...deck, faq: deck.faq.slice(0, 4) };
    expect(() => validateCopyDeck(bad)).toThrow(CopyDeckValidationError);
  });

  it('rejects fewer than 3 ctas', () => {
    const deck = makeValidCopyDeck();
    const bad = { ...deck, ctas: deck.ctas.slice(0, 2) };
    expect(() => validateCopyDeck(bad)).toThrow(CopyDeckValidationError);
  });

  it('rejects fewer than 2 social_proof_blocks', () => {
    const deck = makeValidCopyDeck();
    const bad = { ...deck, social_proof_blocks: deck.social_proof_blocks.slice(0, 1) };
    expect(() => validateCopyDeck(bad)).toThrow(CopyDeckValidationError);
  });

  it('rejects hook text shorter than 20 chars', () => {
    const deck = makeValidCopyDeck();
    const bad = {
      ...deck,
      hooks: [
        { text: 'too short', awareness_stage: 'problem_aware', framework_source: 'schwartz' },
        deck.hooks[1]!,
        deck.hooks[2]!,
      ],
    };
    expect(() => validateCopyDeck(bad)).toThrow(CopyDeckValidationError);
  });

  it('rejects guarantee shorter than 50 chars', () => {
    const deck = makeValidCopyDeck({ guarantee: 'short' });
    expect(() => validateCopyDeck(deck)).toThrow(CopyDeckValidationError);
  });

  it('rejects urgency_copy shorter than 30 chars', () => {
    const deck = makeValidCopyDeck({ urgency_copy: 'short urgency' });
    expect(() => validateCopyDeck(deck)).toThrow(CopyDeckValidationError);
  });
});

describe('validateCopyDeck — language enum', () => {
  it('accepts all 5 supported languages', () => {
    for (const lang of ['en', 'de', 'it', 'fr', 'es'] as const) {
      const deck = makeValidCopyDeck({ language: lang });
      expect(() => validateCopyDeck(deck)).not.toThrow();
    }
  });

  it('rejects unsupported language', () => {
    const deck = { ...makeValidCopyDeck(), language: 'pt' as unknown as 'en' };
    expect(() => validateCopyDeck(deck)).toThrow(CopyDeckValidationError);
  });
});

describe('validateCopyDeck — error message legibility', () => {
  it('formats zod issues in a readable multi-line message', () => {
    const deck = makeValidCopyDeck({ voc_verbatim_used: [] });
    try {
      validateCopyDeck(deck);
      expect.fail('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('CopyDeck schema validation failed');
      expect(msg).toContain('voc_verbatim_used');
    }
  });
});
