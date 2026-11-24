import { describe, it, expect } from 'vitest';
import { resolve } from '../resolver/resolver.js';
import { INITIAL_THRESHOLDS } from '../resolver/thresholds.js';
import type { ThemeAdapter, AdapterInput } from '../theme-adapter.js';
import type { AdapterCandidate } from '../types/detection.js';
import type { ExtractionResult } from '../types/extraction.js';
import type { PageFamily } from '../types/page-family.js';

function makeAdapter(
  id: string,
  score: number,
  family: PageFamily = 'sales_page',
): ThemeAdapter {
  return {
    id,
    families: [family],
    detect(_input: AdapterInput): AdapterCandidate {
      return {
        adapterId: id,
        family,
        score,
        evidence: { reasons: [`mock-${id}`], matchedRules: [] },
      };
    },
    extract(_input: AdapterInput): ExtractionResult {
      throw new Error('resolver tests never call extract');
    },
  };
}

const dummyInput: AdapterInput = { html: '<html></html>' };

describe('resolver', () => {
  it('no candidates → no_match', () => {
    const zero = makeAdapter('zero', 0);
    const r = resolve(dummyInput, [zero]);
    expect(r.resolution).toBe('no_match');
    expect(r.chosen).toBeNull();
    expect(r.candidates).toHaveLength(0);
  });

  it('empty adapter list → no_match', () => {
    const r = resolve(dummyInput, []);
    expect(r.resolution).toBe('no_match');
    expect(r.chosen).toBeNull();
  });

  it('single high-score candidate → confident', () => {
    const kaching = makeAdapter('kaching', 0.92);
    const r = resolve(dummyInput, [kaching]);
    expect(r.resolution).toBe('confident');
    expect(r.chosen?.adapterId).toBe('kaching');
    expect(r.candidates).toHaveLength(1);
  });

  it('single below-threshold → no_match', () => {
    const weak = makeAdapter('weak', 0.4);
    const r = resolve(dummyInput, [weak]);
    expect(r.resolution).toBe('no_match');
    expect(r.chosen).toBeNull();
    expect(r.candidates).toHaveLength(1); // candidate ainda listado
  });

  it('two candidates with wide margin → confident on top', () => {
    const kaching = makeAdapter('kaching', 0.92);
    const aurivita = makeAdapter('aurivita', 0.15);
    const r = resolve(dummyInput, [kaching, aurivita]);
    expect(r.resolution).toBe('confident');
    expect(r.chosen?.adapterId).toBe('kaching');
    expect(r.candidates[0].adapterId).toBe('kaching'); // sort desc
    expect(r.candidates[1].adapterId).toBe('aurivita');
  });

  it('two candidates with narrow margin → ambiguous (A3)', () => {
    // margin = 0.10, threshold = 0.15 → ambiguous
    const a = makeAdapter('kaching', 0.80);
    const b = makeAdapter('aurivita', 0.70);
    const r = resolve(dummyInput, [a, b]);
    expect(r.resolution).toBe('ambiguous');
    expect(r.chosen).toBeNull();
    // Mas candidates permanecem listados pra fallback observável (A4).
    expect(r.candidates.map((c) => c.adapterId)).toEqual(['kaching', 'aurivita']);
    // Reason inclui margin.
    expect(r.reasons.some((r) => r.includes('margin'))).toBe(true);
  });

  it('ambiguous NEVER throws (A3)', () => {
    const a = makeAdapter('a', 0.75);
    const b = makeAdapter('b', 0.72);
    expect(() => resolve(dummyInput, [a, b])).not.toThrow();
  });

  it('hint bias promotes matching adapter (D5)', () => {
    // Sem hint: aurivita venceria (0.75 vs 0.68). Margin 0.07 → ambiguous.
    // Com hint em kaching: score sobe pra 0.78. Margin 0.03 → ainda ambiguous,
    // mas top vira kaching.
    const kaching = makeAdapter('kaching', 0.68);
    const aurivita = makeAdapter('aurivita', 0.75);
    const withoutHint = resolve(dummyInput, [kaching, aurivita]);
    expect(withoutHint.candidates[0].adapterId).toBe('aurivita');

    const withHint = resolve(
      { ...dummyInput, hintedAdapterId: 'kaching' },
      [kaching, aurivita],
    );
    expect(withHint.candidates[0].adapterId).toBe('kaching');
    expect(withHint.candidates[0].score).toBeCloseTo(0.78, 5);
    expect(withHint.reasons.some((r) => r.includes('hint bias'))).toBe(true);
  });

  it('hint bias capped at 1.0', () => {
    const kaching = makeAdapter('kaching', 0.95);
    const r = resolve({ ...dummyInput, hintedAdapterId: 'kaching' }, [kaching]);
    expect(r.candidates[0].score).toBe(1);
  });

  it('adapter that throws in detect is skipped + reason logged', () => {
    const broken: ThemeAdapter = {
      id: 'broken',
      families: ['sales_page'],
      detect() {
        throw new Error('boom');
      },
      extract() {
        throw new Error('unused');
      },
    };
    const ok = makeAdapter('ok', 0.85);
    const r = resolve(dummyInput, [broken, ok]);
    expect(r.resolution).toBe('confident');
    expect(r.chosen?.adapterId).toBe('ok');
    expect(r.reasons.some((s) => s.includes('broken') && s.includes('boom'))).toBe(true);
  });

  it('ties resolve deterministically by adapterId asc', () => {
    const zebra = makeAdapter('zebra', 0.80);
    const alpha = makeAdapter('alpha', 0.80);
    const r = resolve(dummyInput, [zebra, alpha]);
    // Empate → alpha vem primeiro (lex asc), mas margin = 0 → ambiguous
    expect(r.candidates.map((c) => c.adapterId)).toEqual(['alpha', 'zebra']);
    expect(r.resolution).toBe('ambiguous');
  });

  it('custom thresholds override initial calibration', () => {
    // Com thresholds mais permissivos, o mesmo par confident em vez de ambíguo.
    const a = makeAdapter('kaching', 0.80);
    const b = makeAdapter('aurivita', 0.70);
    const r = resolve(dummyInput, [a, b], {
      thresholds: {
        ...INITIAL_THRESHOLDS,
        MARGIN_THRESHOLD: 0.05,
      },
    });
    expect(r.resolution).toBe('confident');
    expect(r.chosen?.adapterId).toBe('kaching');
  });

  it('initial thresholds are frozen (immutable)', () => {
    expect(Object.isFrozen(INITIAL_THRESHOLDS)).toBe(true);
  });
});
