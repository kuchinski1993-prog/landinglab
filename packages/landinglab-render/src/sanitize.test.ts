import { describe, expect, it } from 'vitest';

import { sanitizeHtml } from './sanitize.js';

// ─────────────────────────────────────────────────────────────────────────
// STATE OF THE PACKAGE (Task #45 QA note):
//
// landinglab-render actualmente contém:
//   1. sanitize.ts  — STUB v1 (Story 13.1): retorna input inalterado.
//                     Contrato final (Story 13.6) usa isomorphic-dompurify
//                     + scoping de CSS `.landing-scope { ... }`. NÃO IMPLEMENTADO.
//   2. templates/landinglab/*  — React SSR templates (Story 13.6 Wave 2).
//
// A task original mencionava "parse5 block extraction", "componentização com
// { type, html, assets[], editableFields[] }" e "edge cases de HTML vazio".
// Nada disso existe neste pacote — não há parser HTML, não há extração de
// blocos, não há noção de `editableFields`. A superfície pública real é:
//     export { sanitizeHtml } from './sanitize.js';
//
// Portanto os testes abaixo cobrem o CONTRATO DE STUB atual e servem como
// canary: quando 13.6 implementar sanitização real, estes testes vão
// quebrar propositalmente e forçar a atualização das expectativas.
// ─────────────────────────────────────────────────────────────────────────

describe('sanitizeHtml — stub contract (Story 13.1)', () => {
  it('returns input unchanged (identity function)', () => {
    const html = '<h1>Landing</h1><p>Body</p>';
    expect(sanitizeHtml(html)).toBe(html);
  });

  it('preserves empty string', () => {
    expect(sanitizeHtml('')).toBe('');
  });

  it('preserves whitespace-only input', () => {
    const ws = '   \n\t  ';
    expect(sanitizeHtml(ws)).toBe(ws);
  });

  it('preserves malicious markup (stub does NOT sanitize — 13.6 will)', () => {
    // Explicit canary: this test WILL fail when Story 13.6 lands real DOMPurify.
    // At that point, update the expectation to `not.toContain('<script>')`.
    const dangerous = '<div>hi<script>alert(1)</script></div>';
    expect(sanitizeHtml(dangerous)).toBe(dangerous);
  });

  it('preserves HTML without <head>', () => {
    const noHead = '<div><section>Only body</section></div>';
    expect(sanitizeHtml(noHead)).toBe(noHead);
  });

  it('preserves deeply nested sections', () => {
    const nested =
      '<section><section><section><article><p>deep</p></article></section></section></section>';
    expect(sanitizeHtml(nested)).toBe(nested);
  });

  it('preserves HTML entities and unicode content', () => {
    const html = '<p>Café — 100&nbsp;€ &amp; &lt;ok&gt;</p>';
    expect(sanitizeHtml(html)).toBe(html);
  });

  it('is a pure function (multiple calls with same input yield same output)', () => {
    const html = '<h1>Idempotent</h1>';
    expect(sanitizeHtml(html)).toBe(sanitizeHtml(html));
  });
});
