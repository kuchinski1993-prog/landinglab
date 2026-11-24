import { describe, expect, it } from 'vitest';

import {
  adjustPaletteForWcagAA,
  contrastRatio,
  type Palette,
} from './contrast-adjuster.js';

const WCAG_AA = 4.5;

describe('contrastRatio', () => {
  it('preto sobre branco = 21', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('branco sobre branco = 1', () => {
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 3);
  });

  it('simétrico em relação à ordem dos args', () => {
    expect(contrastRatio('#123456', '#abcdef')).toBeCloseTo(
      contrastRatio('#abcdef', '#123456'),
      5,
    );
  });

  it('aceita hex de 3 dígitos (shorthand)', () => {
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 1);
  });

  it('lança em hex inválido', () => {
    expect(() => contrastRatio('#zzz', '#ffffff')).toThrow(/Invalid hex/);
  });
});

describe('adjustPaletteForWcagAA — AC7/AC9: paleta já correta', () => {
  it('paleta com todos os pares >= 4.5:1 não sofre modificação (AC7/AC9)', () => {
    // Ratios validados manualmente pra passar em todos os 4 pares críticos:
    //   primary_vs_bg   (#757575 vs #ffffff) = 4.55
    //   primary_vs_text (#757575 vs #000000) = 4.62
    //   text_vs_bg      (#000000 vs #ffffff) = 21
    //   accent_vs_bg    (#757575 vs #ffffff) = 4.55
    // #757575 é o mid-gray "milagroso" que contrasta >= 4.5 vs branco E preto.
    const palette: Palette = {
      primary: '#757575',
      secondary: '#cccccc',
      accent: '#757575',
      bg: '#ffffff',
      text: '#000000',
    };
    const result = adjustPaletteForWcagAA({ palette });
    expect(result.adjustments).toEqual([]);
    expect(result.palette).toEqual(palette);
  });
});

describe('adjustPaletteForWcagAA — AC8: paleta de contraste ruim', () => {
  it('branco sobre amarelo → ajusta pra atingir 4.5:1', () => {
    // Amarelo puro (#ffff00) sobre branco tem ratio ~1.07 (péssimo).
    const palette: Palette = {
      primary: '#ffff00', // amarelo — precisa escurecer contra bg branco
      secondary: '#cccccc',
      accent: '#00ff00', // verde brilhante — contraste ruim vs bg
      bg: '#ffffff',
      text: '#ffff00', // amarelo — péssimo contra bg branco
    };
    const result = adjustPaletteForWcagAA({ palette });

    // Todos os pares críticos devem estar >= 4.5 (ou impossible)
    expect(contrastRatio(result.palette.primary, result.palette.bg)).toBeGreaterThanOrEqual(WCAG_AA);
    expect(contrastRatio(result.palette.text, result.palette.bg)).toBeGreaterThanOrEqual(WCAG_AA);
    expect(contrastRatio(result.palette.accent, result.palette.bg)).toBeGreaterThanOrEqual(WCAG_AA);

    // Deve ter logs pra pelo menos primary, text, accent
    const pairs = new Set(result.adjustments.map((a) => a.pair));
    expect(pairs.has('primary_vs_bg')).toBe(true);
    expect(pairs.has('text_vs_bg')).toBe(true);
    expect(pairs.has('accent_vs_bg')).toBe(true);
  });

  it('AC5: escurece quando luminance alto (amarelo → escuro)', () => {
    const palette: Palette = {
      primary: '#ffff00',
      secondary: '#ffffff',
      accent: '#000000',
      bg: '#ffffff',
      text: '#000000',
    };
    const result = adjustPaletteForWcagAA({ palette });
    const primaryLog = result.adjustments.find((a) => a.pair === 'primary_vs_bg');
    expect(primaryLog).toBeDefined();
    expect(primaryLog!.method).toBe('darken_hsl');
  });

  it('AC5: clareia quando luminance baixo (azul escuro → cinza claro, sobre fundo preto)', () => {
    // primary #000080 (dark blue) sobre bg preto = ratio ~1.3 — precisa clarear
    const palette: Palette = {
      primary: '#000080',
      secondary: '#333333',
      accent: '#ffffff',
      bg: '#000000',
      text: '#ffffff',
    };
    const result = adjustPaletteForWcagAA({ palette });
    const primaryLog = result.adjustments.find((a) => a.pair === 'primary_vs_bg');
    expect(primaryLog).toBeDefined();
    expect(primaryLog!.method).toBe('lighten_hsl');
  });
});

describe('adjustPaletteForWcagAA — AC6: garantia de terminação', () => {
  it('caso impossível (cinza sobre cinza próximo) → contrast_impossible=true', () => {
    // #808080 vs #7f7f7f — praticamente idênticos, contraste ~1
    const palette: Palette = {
      primary: '#808080',
      secondary: '#808080',
      accent: '#808080',
      bg: '#7f7f7f',
      text: '#808080',
    };
    const result = adjustPaletteForWcagAA({ palette });
    // Ao menos um par deve resolver (algoritmo consegue mover pra preto/branco)
    // ou marcar como impossible. O que NÃO pode: loop infinito.
    expect(result.adjustments.length).toBeGreaterThan(0);
    // Todos os adjustments devem ter tentado convergir; se falhou, tem flag
    for (const adj of result.adjustments) {
      if (adj.adjusted_ratio < WCAG_AA) {
        expect(adj.contrast_impossible).toBe(true);
      }
    }
  });

  it('nunca loopa infinito (retorna em tempo finito para qualquer input)', () => {
    // Cenário extremo — várias iterações
    const palette: Palette = {
      primary: '#7f7f7f',
      secondary: '#7f7f7f',
      accent: '#7f7f7f',
      bg: '#808080',
      text: '#7f7f7f',
    };
    const started = Date.now();
    const result = adjustPaletteForWcagAA({ palette });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1000); // 4 pares × 20 iters é <1s trivialmente
    expect(result).toBeDefined();
  });
});

describe('adjustPaletteForWcagAA — AC3: shape do resultado', () => {
  it('adjustments contém todos os campos exigidos', () => {
    const palette: Palette = {
      primary: '#ffff00',
      secondary: '#cccccc',
      accent: '#000000',
      bg: '#ffffff',
      text: '#000000',
    };
    const result = adjustPaletteForWcagAA({ palette });
    expect(result.adjustments.length).toBeGreaterThan(0);
    for (const adj of result.adjustments) {
      expect(adj).toHaveProperty('pair');
      expect(adj).toHaveProperty('original_ratio');
      expect(adj).toHaveProperty('adjusted_ratio');
      expect(adj).toHaveProperty('original_color');
      expect(adj).toHaveProperty('new_color');
      expect(adj).toHaveProperty('method');
      expect(['darken_hsl', 'lighten_hsl', 'none']).toContain(adj.method);
    }
  });

  it('AC4: avalia exatamente os 4 pares críticos', () => {
    // Paleta onde todos os 4 pares críticos falham
    const palette: Palette = {
      primary: '#f0f000', // amarelo — falha vs bg branco e vs text branco
      secondary: '#cccccc',
      accent: '#f0f000', // amarelo — falha vs bg branco
      bg: '#ffffff',
      text: '#f0f000', // amarelo — falha vs bg branco
    };
    const result = adjustPaletteForWcagAA({ palette });
    const pairs = result.adjustments.map((a) => a.pair);
    // Os 4 pares devem aparecer (todos falharam originalmente)
    expect(pairs).toContain('primary_vs_bg');
    expect(pairs).toContain('primary_vs_text');
    expect(pairs).toContain('text_vs_bg');
    expect(pairs).toContain('accent_vs_bg');
    expect(pairs.length).toBe(4);
  });
});

describe('adjustPaletteForWcagAA — AC10: pureza', () => {
  it('não muta o input', () => {
    const original: Palette = {
      primary: '#ffff00',
      secondary: '#cccccc',
      accent: '#00ff00',
      bg: '#ffffff',
      text: '#ffff00',
    };
    const snapshot = { ...original };
    adjustPaletteForWcagAA({ palette: original });
    expect(original).toEqual(snapshot);
  });

  it('determinístico — 2 chamadas idênticas retornam resultados iguais', () => {
    const palette: Palette = {
      primary: '#ffff00',
      secondary: '#cccccc',
      accent: '#00ff00',
      bg: '#ffffff',
      text: '#ffff00',
    };
    const r1 = adjustPaletteForWcagAA({ palette });
    const r2 = adjustPaletteForWcagAA({ palette });
    expect(r1).toEqual(r2);
  });
});
