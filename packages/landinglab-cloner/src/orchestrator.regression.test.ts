// Regression matrix — cobertura por FIXTURE TYPE de bugs históricos.
//
// Cada linha (bug de clone real que já aconteceu em produção) vira uma
// combinação de fixture sintético + assertion. Cobre 5 tipos de landing
// que o LandingLab suporta e valida que:
//   - CSS preservado
//   - artifacts de captura strippados
//   - trackers bloqueados
//   - scripts críticos recuperados (theme scripts perdidos em htmlOverride)
//   - dedupe funciona (não recuperar 2x o mesmo script)
//   - fidelity verdict é esperado
//
// Zero rede, zero DB, zero URLs reais. Todo fixture é sintético/inline.
//
// Referência histórica (bugs cobertos):
//   - Denim/Klensia: htmlOverride path perde <script src defer> do tema
//     (fix: static-script-enricher — PR #142)
//   - Bepurex/Aurivita: seções cc-timeline/cc-doctors-see quebram por
//     falta do swiper+tabs runtime (fix: landinglab-fixes-injector)
//   - PSS-like: FAQ accordion vira colapsado permanente (mesmo grupo do fix)
//   - Simple static HTML: caminho não-htmlOverride precisa continuar limpo
//   - Genérico htmlOverride: perda de scripts genérica não pode virar BLOCKED
//     por falso positivo de CSS/duplicate.

import { describe, expect, it } from 'vitest';

import {
  assessCloneFidelity,
  extractMissingStaticScripts,
  sanitizeHtml,
} from './orchestrator.js';

// ────────────────────────────────────────────────────────────────────────────
// Fixtures — sintéticos, inline, zero rede
// ────────────────────────────────────────────────────────────────────────────

const BASE = 'https://origin.example/pages/landing';

/**
 * Fixture 1 — Denim/Klensia-like.
 * DOM capturado (htmlOverride) perdeu <script src defer> do tema. Estático
 * ainda tem. O enricher deve recuperar SOMENTE os scripts do tema (bloqueando
 * GTM/Meta), sem duplicar.
 */
const DENIM_DOM_HTML = `<!DOCTYPE html>
<html><head>
  <link rel="stylesheet" href="https://cdn.shopify.com/klensia/theme.css">
  <style>.hero{background:#000}</style>
</head><body>
  <main><h1>Klensia Denim</h1></main>
  <script src="https://cdn.shopify.com/klensia/inline.js"></script>
</body></html>`;

const DENIM_STATIC_HTML = `<!DOCTYPE html>
<html><head>
  <script src="https://cdn.shopify.com/klensia/theme.js" defer></script>
  <script src="https://cdn.shopify.com/klensia/vendor.js" defer></script>
  <script src="https://cdn.shopify.com/klensia/inline.js"></script>
  <script src="https://www.googletagmanager.com/gtm.js?id=GTM-XXX"></script>
  <script src="https://connect.facebook.net/en_US/fbevents.js"></script>
</head><body></body></html>`;

/**
 * Fixture 2 — Bepurex/Aurivita-like.
 * Non-Denim theme, tem cc-timeline (Swiper + tabs) inline no HTML. Simula
 * cenário onde o script inline JÁ está no DOM capturado — enricher não deve
 * adicionar nada duplicado.
 */
const BEPUREX_DOM_HTML = `<!DOCTYPE html>
<html><head>
  <link rel="stylesheet" href="https://cdn.shopify.com/bepurex/main.css">
</head><body>
  <section class="cc-timeline">
    <div class="swiper"><div class="swiper-slide">Fase 1</div></div>
  </section>
  <script src="https://cdn.shopify.com/bepurex/theme.js"></script>
</body></html>`;

const BEPUREX_STATIC_HTML = `<!DOCTYPE html>
<html><head></head><body>
  <script src="https://cdn.shopify.com/bepurex/theme.js"></script>
</body></html>`;

/**
 * Fixture 3 — PSS-like.
 * FAQ accordion. Se o script de accordion não roda, todas as respostas ficam
 * colapsadas. Enricher deve recuperar o pss.js.
 */
const PSS_DOM_HTML = `<!DOCTYPE html>
<html><head>
  <style>.faq-item{padding:1rem}</style>
</head><body>
  <div class="faq"><details><summary>Q1</summary><p>A1</p></details></div>
</body></html>`;

const PSS_STATIC_HTML = `<!DOCTYPE html>
<html><head>
  <script src="https://cdn.pss.example/accordion.js" defer></script>
</head><body></body></html>`;

/**
 * Fixture 4 — Simple static HTML (no htmlOverride).
 * Landing minimal SEM htmlOverride — pipeline usa renderer normal. Só validamos
 * que fidelity de HTML já pronto está HEALTHY.
 */
const SIMPLE_STATIC_HTML = `<!DOCTYPE html>
<html><head>
  <style>body{font-family:sans-serif}</style>
</head><body>
  <h1>Simple Landing</h1>
  <script src="https://storage.supabase.co/cloned/xyz/theme.js"></script>
</body></html>`;

/**
 * Fixture 5 — htmlOverride genérico.
 * Site random-brand: DOM tem inline scripts + link stylesheet, static tem
 * scripts extras. Verifica enricher genérico sem contexto de tema.
 */
const GENERIC_DOM_HTML = `<!DOCTYPE html>
<html><head>
  <link rel="stylesheet" href="/style.css">
</head><body>
  <script>console.log('inline')</script>
</body></html>`;

const GENERIC_STATIC_HTML = `<!DOCTYPE html>
<html><head>
  <script src="https://cdn.generic.example/vendor.js"></script>
  <script src="https://cdn.generic.example/app.js"></script>
</head><body></body></html>`;

/**
 * Fixture 6 — Chrome extension artifact.
 * Simula clone onde a captura Playwright vazou <script src="chrome-extension://">.
 * Sanitize deve remover; assessCloneFidelity valida que não sobrou.
 */
const CAPTURE_ARTIFACT_HTML = `<!DOCTYPE html>
<html><head><style>a{}</style></head><body>
  <script src="chrome-extension://eppioc/inject.js"></script>
  <script src="moz-extension://abc/other.js"></script>
  <main>Landing</main>
</body></html>`;

// ────────────────────────────────────────────────────────────────────────────
// Matrix — cada bloco = 1 fixture rodando as 6 assertions
// ────────────────────────────────────────────────────────────────────────────

interface FixtureCase {
  name: string;
  domHtml: string;
  staticHtml: string;
  domScriptUrls: string[]; // scripts JÁ presentes no DOM (simula rendered.scriptUrls)
  expectedRecoveredCount: number;
  mustRecoverAny: string[]; // URLs esperadas no output do enricher
  mustBlockRecovery: string[]; // URLs que o enricher NUNCA pode recuperar
  expectedVerdictOnDom: 'HEALTHY' | 'DEGRADED' | 'BLOCKED';
}

const MATRIX: FixtureCase[] = [
  {
    name: 'Denim/Klensia (htmlOverride, missing theme scripts)',
    domHtml: DENIM_DOM_HTML,
    staticHtml: DENIM_STATIC_HTML,
    domScriptUrls: ['https://cdn.shopify.com/klensia/inline.js'],
    expectedRecoveredCount: 2, // theme.js + vendor.js (gtm+fb bloqueados, inline.js dup)
    mustRecoverAny: [
      'https://cdn.shopify.com/klensia/theme.js',
      'https://cdn.shopify.com/klensia/vendor.js',
    ],
    mustBlockRecovery: [
      'https://www.googletagmanager.com/gtm.js?id=GTM-XXX',
      'https://connect.facebook.net/en_US/fbevents.js',
    ],
    expectedVerdictOnDom: 'HEALTHY',
  },
  {
    name: 'Bepurex/Aurivita (non-Denim theme, script já no DOM)',
    domHtml: BEPUREX_DOM_HTML,
    staticHtml: BEPUREX_STATIC_HTML,
    domScriptUrls: ['https://cdn.shopify.com/bepurex/theme.js'],
    expectedRecoveredCount: 0, // já tem o único script — enricher NADA
    mustRecoverAny: [],
    mustBlockRecovery: [],
    expectedVerdictOnDom: 'HEALTHY',
  },
  {
    name: 'PSS-like (accordion FAQ)',
    domHtml: PSS_DOM_HTML,
    staticHtml: PSS_STATIC_HTML,
    domScriptUrls: [],
    expectedRecoveredCount: 1,
    mustRecoverAny: ['https://cdn.pss.example/accordion.js'],
    mustBlockRecovery: [],
    // DOM tem <style> mas nenhum script → HEALTHY (não há artifact nem non-frozen)
    expectedVerdictOnDom: 'HEALTHY',
  },
  {
    name: 'Simple static HTML (no htmlOverride path)',
    domHtml: SIMPLE_STATIC_HTML,
    staticHtml: '', // não passa por enricher — o path pula
    domScriptUrls: [],
    expectedRecoveredCount: 0,
    mustRecoverAny: [],
    mustBlockRecovery: [],
    expectedVerdictOnDom: 'HEALTHY',
  },
  {
    name: 'htmlOverride generic (random brand)',
    domHtml: GENERIC_DOM_HTML,
    staticHtml: GENERIC_STATIC_HTML,
    domScriptUrls: [],
    expectedRecoveredCount: 2,
    mustRecoverAny: [
      'https://cdn.generic.example/vendor.js',
      'https://cdn.generic.example/app.js',
    ],
    mustBlockRecovery: [],
    // DOM genérico tem link stylesheet + inline script → HEALTHY
    expectedVerdictOnDom: 'HEALTHY',
  },
];

// ────────────────────────────────────────────────────────────────────────────
// Matrix runner — 6 assertions × 5 fixtures = 30 assertions declaradas
// ────────────────────────────────────────────────────────────────────────────

describe('cloner regression matrix', () => {
  for (const fx of MATRIX) {
    describe(fx.name, () => {
      it('CSS preservado (não BLOCKED por critical-css-missing)', () => {
        const { verdict, findings } = assessCloneFidelity(fx.domHtml);
        expect(findings.some((f) => f.includes('critical-css-missing'))).toBe(false);
        // Verdict pode ser HEALTHY ou DEGRADED, mas nunca BLOCKED por CSS.
        if (verdict === 'BLOCKED') {
          expect(findings.every((f) => !f.includes('critical-css-missing'))).toBe(true);
        }
      });

      it('artifacts de captura strippados (sanitize remove chrome-extension)', () => {
        const sanitized = sanitizeHtml(fx.domHtml);
        expect(sanitized).not.toMatch(/src=["'](?:chrome|moz)-extension:\/\//i);
      });

      it('trackers/analytics bloqueados pelo enricher', () => {
        if (!fx.staticHtml) {
          // Fixture sem static — skip trivialmente.
          expect(true).toBe(true);
          return;
        }
        const recovered = extractMissingStaticScripts(
          fx.domScriptUrls,
          fx.staticHtml,
          BASE,
        );
        for (const blocked of fx.mustBlockRecovery) {
          expect(recovered).not.toContain(blocked);
        }
      });

      it('scripts críticos recuperados quando presentes no static', () => {
        if (!fx.staticHtml) {
          expect(true).toBe(true);
          return;
        }
        const recovered = extractMissingStaticScripts(
          fx.domScriptUrls,
          fx.staticHtml,
          BASE,
        );
        for (const expected of fx.mustRecoverAny) {
          expect(recovered).toContain(expected);
        }
        expect(recovered.length).toBe(fx.expectedRecoveredCount);
      });

      it('recovered set não tem duplicatas (dedupe funciona)', () => {
        if (!fx.staticHtml) {
          expect(true).toBe(true);
          return;
        }
        const recovered = extractMissingStaticScripts(
          fx.domScriptUrls,
          fx.staticHtml,
          BASE,
        );
        const unique = new Set(recovered);
        expect(unique.size).toBe(recovered.length);
      });

      it(`fidelity verdict do DOM é ${fx.expectedVerdictOnDom}`, () => {
        const { verdict } = assessCloneFidelity(fx.domHtml);
        expect(verdict).toBe(fx.expectedVerdictOnDom);
      });
    });
  }

  // Fixture 6 — capture artifact (não segue o mesmo shape, valida caso específico)
  describe('Chrome/moz-extension artifact fixture', () => {
    it('DOM cru é BLOCKED (browser-extension-artifact)', () => {
      const { verdict, findings } = assessCloneFidelity(CAPTURE_ARTIFACT_HTML);
      expect(verdict).toBe('BLOCKED');
      expect(findings.some((f) => f.includes('browser-extension-artifact'))).toBe(true);
    });

    it('sanitize resolve — passa a HEALTHY depois de sanitizeHtml', () => {
      const sanitized = sanitizeHtml(CAPTURE_ARTIFACT_HTML);
      const { verdict } = assessCloneFidelity(sanitized);
      expect(verdict).toBe('HEALTHY');
    });

    it('conteúdo preservado após sanitize (não bota fora <main>)', () => {
      const sanitized = sanitizeHtml(CAPTURE_ARTIFACT_HTML);
      expect(sanitized).toContain('<main>Landing</main>');
    });
  });

  // Regressão: enricher NÃO recupera duplicatas entre chamadas idempotentes
  describe('idempotência do enricher', () => {
    it('chamar duas vezes com mesmo input retorna set idêntico', () => {
      const first = extractMissingStaticScripts(
        ['https://cdn.shopify.com/klensia/inline.js'],
        DENIM_STATIC_HTML,
        BASE,
      );
      const second = extractMissingStaticScripts(
        ['https://cdn.shopify.com/klensia/inline.js'],
        DENIM_STATIC_HTML,
        BASE,
      );
      expect(second).toEqual(first);
    });

    it('mesclando recovered no domScriptUrls e re-rodando, dedupe NÃO adiciona novos', () => {
      const domUrls = ['https://cdn.shopify.com/klensia/inline.js'];
      const first = extractMissingStaticScripts(domUrls, DENIM_STATIC_HTML, BASE);
      const merged = [...domUrls, ...first];
      const second = extractMissingStaticScripts(merged, DENIM_STATIC_HTML, BASE);
      expect(second).toHaveLength(0);
    });
  });
});
