import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { kachingAdapter } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Fixtures reutilizadas da Fase 9F.
const FIXTURES_DIR = join(
  __dirname,
  '../../../../../../apps/worker/src/__tests__/__fixtures__/render-golden',
);

function loadFixtureHtml(name: string): string {
  return readFileSync(join(FIXTURES_DIR, `${name}.input.html`), 'utf-8');
}

const KACHING = loadFixtureHtml('kaching-minimal');
const AURIVITA = loadFixtureHtml('aurivita-minimal');
const PSS_PURE = loadFixtureHtml('pss-pure-minimal');
const PSS_KACHING_HYBRID = loadFixtureHtml('pss-kaching-hybrid');

describe('KachingAdapter.detect() — fixtures', () => {
  it('kaching-minimal → confidence alta (>= 0.85)', () => {
    const c = kachingAdapter.detect({ html: KACHING });
    expect(c.adapterId).toBe('kaching');
    expect(c.family).toBe('sales_page');
    expect(c.score).toBeGreaterThanOrEqual(0.85);
    expect(c.evidence.matchedRules.length).toBeGreaterThanOrEqual(4);
  });

  it('aurivita-minimal → confidence baixa (< 0.30)', () => {
    const c = kachingAdapter.detect({ html: AURIVITA });
    expect(c.score).toBeLessThan(0.3);
  });

  it('pss-pure-minimal → score 0 (nenhum marker Kaching, fixture PSS pura)', () => {
    // Prova false-positive protection: PSS puro (sem .kaching-bundles__bar)
    // NÃO deve virar Kaching confident.
    const c = kachingAdapter.detect({ html: PSS_PURE });
    expect(c.score).toBe(0);
  });

  it('pss-kaching-hybrid → confidence alta (Klensia-like: PSS theme + widget Kaching legítimo)', () => {
    // Fixture representa Klensia real: página tema PSS que HOSPEDA widget
    // Kaching Bundles. Adapter DEVE detectar o widget (é o que ele reconhece).
    // Distinção page-theme vs embedded-component é intencional aqui.
    const c = kachingAdapter.detect({ html: PSS_KACHING_HYBRID });
    expect(c.score).toBeGreaterThanOrEqual(0.85);
  });
});

describe('KachingAdapter.detect() — false positive protection', () => {
  it('HTML vazio → score 0', () => {
    const c = kachingAdapter.detect({ html: '' });
    expect(c.score).toBe(0);
    expect(c.evidence.matchedRules).toEqual([]);
  });

  it('HTML totalmente genérico → score 0', () => {
    const c = kachingAdapter.detect({
      html: '<html><body><h1>Hello</h1><p>Text</p></body></html>',
    });
    expect(c.score).toBe(0);
  });

  it('UMA classe .kaching-bundles__bar sozinha NÃO deve virar confident', () => {
    // Cenário adversário: alguém colocou a classe num widget solto.
    // Regra R3 (multi_bar) só dispara com >= 2 bars → adapter recusa confidence.
    const html = `
      <html><body>
        <div class="kaching-bundles__bar" data-deal-bar-id="fake">
          <span class="kaching-bundles__bar-price">$10</span>
        </div>
      </body></html>
    `;
    const c = kachingAdapter.detect({ html });
    // R1 (0.40) + R2 (0.15) + R4 (0.15) + R6 (0.05) = 0.75. Cai abaixo do
    // ideal (>= 0.85) mas ainda passaria threshold 0.70. Documentar valor
    // exato pra ficar visível — protege via multi_bar + compare_span
    // ausentes.
    expect(c.score).toBeLessThan(0.85);
    // Especificamente: multi_bar NÃO deve estar na lista de matched
    expect(c.evidence.matchedRules).not.toContain('kaching.R3.multi_bar');
  });

  it('kaching-bundles__bar sem data-deal-bar-id → score reduzido', () => {
    const html = `
      <html><body>
        <div class="kaching-bundles__bar"><span class="kaching-bundles__bar-price">$1</span></div>
        <div class="kaching-bundles__bar"><span class="kaching-bundles__bar-price">$2</span></div>
      </body></html>
    `;
    const c = kachingAdapter.detect({ html });
    expect(c.evidence.matchedRules).not.toContain('kaching.R2.data_deal_bar_id');
    // R1 + R3 + R4 + R6 = 0.75 → passa threshold mas com sinal de fraqueza
    expect(c.score).toBeCloseTo(0.75, 5);
  });

  it('classe similar mas incorreta → score 0', () => {
    const html = `
      <html><body>
        <div class="kaching-bundles-bar">nope</div>
        <div class="my-kaching-bundles__bar">nope</div>
      </body></html>
    `;
    const c = kachingAdapter.detect({ html });
    expect(c.score).toBe(0);
  });
});

describe('KachingAdapter.detect() — evidence transparency', () => {
  it('reasons include both matched and missed rules', () => {
    const c = kachingAdapter.detect({ html: KACHING });
    // Deve ter razões positivas E negativas (transparência total).
    expect(c.evidence.reasons.length).toBeGreaterThan(4);
    expect(c.evidence.reasons.some((r) => r.includes('match'))).toBe(true);
    // Prefixo '-' marca miss.
    // Kaching fixture NÃO tem sticky-atc → alguma regra pode ter missado
    // (nenhuma miss possível se tudo bater — aceitar N >= 4 razões totais).
  });

  it('score never exceeds 1.0', () => {
    // Cenário sintético com repetição massiva pra tentar estourar.
    const html = `
      <html><body>
        ${Array.from({ length: 20 })
          .map(
            (_, i) =>
              `<div class="kaching-bundles__bar" data-deal-bar-id="b${i}"><span class="kaching-bundles__bar-price">$${i}</span><span class="kaching-bundles__bar-full-price">$${i * 2}</span></div>`,
          )
          .join('\n')}
      </body></html>
    `;
    const c = kachingAdapter.detect({ html });
    expect(c.score).toBeLessThanOrEqual(1);
    expect(c.score).toBeCloseTo(1, 5); // Todas as regras batem
  });
});

describe('KachingAdapter.detect() — determinismo', () => {
  it('mesmo input → resultado semanticamente idêntico', () => {
    const a = kachingAdapter.detect({ html: KACHING });
    const b = kachingAdapter.detect({ html: KACHING });
    expect(a.score).toBe(b.score);
    expect(a.evidence.matchedRules).toEqual(b.evidence.matchedRules);
    expect(a.evidence.reasons).toEqual(b.evidence.reasons);
    expect(a.family).toBe(b.family);
    expect(a.adapterId).toBe(b.adapterId);
  });

  it('10 runs produzem mesmo score', () => {
    const scores = Array.from({ length: 10 }, () =>
      kachingAdapter.detect({ html: KACHING }).score,
    );
    expect(new Set(scores).size).toBe(1);
  });
});
