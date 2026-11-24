import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { kachingAdapter } from '../index.js';
import { resolve, createAdapterRegistry } from '../../../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
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
const GENERIC = '<html><body><h1>Hello</h1><p>Nada aqui.</p></body></html>';
const PARTIAL_KACHING = `
  <html><body>
    <div class="kaching-bundles__bar" data-deal-bar-id="partial"></div>
  </body></html>
`;

// Documenta a matriz de confidence — número exato importa pra calibração
// e pra evidência que fica exposta em Relatório 10.3 CLOSURE.
describe('Kaching confidence matrix', () => {
  const cases: Array<[string, string, (n: number) => void]> = [
    // Kaching widget canonical (isolado)
    ['kaching-minimal', KACHING, (n) => expect(n).toBeGreaterThanOrEqual(0.85)],
    // Nenhum marker Kaching
    ['aurivita-minimal', AURIVITA, (n) => expect(n).toBeLessThan(0.3)],
    ['generic-html', GENERIC, (n) => expect(n).toBe(0)],
    // FALSE POSITIVE PROTECTION: PSS puro (sem widget Kaching) NÃO deve virar Kaching.
    ['pss-pure-minimal', PSS_PURE, (n) => expect(n).toBe(0)],
    // LEGITIMATE HYBRID: Klensia-like (PSS theme + Kaching widget) É Kaching valid.
    ['pss-kaching-hybrid', PSS_KACHING_HYBRID, (n) => expect(n).toBeGreaterThanOrEqual(0.85)],
    // Fragmento com marker mas sem estrutura → below threshold
    ['partial-kaching', PARTIAL_KACHING, (n) => expect(n).toBeLessThan(0.6)],
  ];

  for (const [name, html, check] of cases) {
    it(`confidence: ${name}`, () => {
      const c = kachingAdapter.detect({ html });
      check(c.score);
      // Log estruturado (log-to-test-name — visível em vitest reporter)
      // eslint-disable-next-line no-console
      console.log(`[matrix] ${name}: score=${c.score.toFixed(3)}`);
    });
  }
});

describe('Kaching + resolver integration', () => {
  const registry = createAdapterRegistry();
  registry.register(kachingAdapter);
  registry.freeze();

  it('kaching fixture → resolver confident chosen=kaching', () => {
    const r = resolve({ html: KACHING }, registry.list());
    expect(r.resolution).toBe('confident');
    expect(r.chosen?.adapterId).toBe('kaching');
  });

  it('aurivita fixture → resolver no_match (só Kaching registrado, aurivita pontua < threshold)', () => {
    const r = resolve({ html: AURIVITA }, registry.list());
    expect(r.resolution).toBe('no_match');
    expect(r.chosen).toBeNull();
  });

  it('generic HTML → resolver no_match', () => {
    const r = resolve({ html: GENERIC }, registry.list());
    expect(r.resolution).toBe('no_match');
  });

  it('partial kaching → resolver no_match (score < 0.70)', () => {
    const r = resolve({ html: PARTIAL_KACHING }, registry.list());
    expect(r.resolution).toBe('no_match');
    // Candidato ainda aparece na lista pra observabilidade (A4)
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].adapterId).toBe('kaching');
  });

  it('pss-pure-minimal → resolver no_match (false-positive protection)', () => {
    const r = resolve({ html: PSS_PURE }, registry.list());
    expect(r.resolution).toBe('no_match');
    expect(r.chosen).toBeNull();
  });

  it('pss-kaching-hybrid → resolver confident chosen=kaching (widget legítimo)', () => {
    const r = resolve({ html: PSS_KACHING_HYBRID }, registry.list());
    expect(r.resolution).toBe('confident');
    expect(r.chosen?.adapterId).toBe('kaching');
  });
});
