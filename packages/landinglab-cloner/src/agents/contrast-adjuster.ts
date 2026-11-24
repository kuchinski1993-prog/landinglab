// contrast-adjuster — SM-2.3
//
// Ajusta paleta de cores pra atender WCAG AA (contraste >= 4.5:1) em pares
// críticos (primary×bg, primary×text, text×bg, accent×bg). Puro,
// determinístico, síncrono, zero rede.
//
// Algoritmo:
//   1. Pra cada par crítico, calcula ratio via luminância relativa (WCAG 2.1).
//   2. Se ratio < 4.5: converte a cor "menos crítica" (primary/accent/text —
//      nunca bg) pra HSL, ajusta L em passos de 5% (escurece se L>0.5, senão
//      clareia) até bater 4.5:1 ou 20 iterações (garantia de terminação).
//   3. Retorna paleta ajustada + log de mudanças por par.
//
// Nota sobre `wcag-contrast` npm: story menciona como opção. Optamos por
// implementar inline (10 LOC) pra evitar dependência extra e manter
// zero-rede trivialmente auditável.

export type Hex = string;

export interface Palette {
  primary: Hex;
  secondary: Hex;
  accent: Hex;
  bg: Hex;
  text: Hex;
}

export type CriticalPair = 'primary_vs_bg' | 'primary_vs_text' | 'text_vs_bg' | 'accent_vs_bg';

export interface AdjustmentLog {
  pair: CriticalPair;
  original_ratio: number;
  adjusted_ratio: number;
  original_color: Hex;
  new_color: Hex;
  method: 'darken_hsl' | 'lighten_hsl' | 'none';
  contrast_impossible?: boolean;
}

export interface ContrastAdjustInput {
  palette: Palette;
}

export interface ContrastAdjustResult {
  palette: Palette;
  adjustments: AdjustmentLog[];
}

const WCAG_AA_THRESHOLD = 4.5;
const MAX_ITERATIONS = 20;
const STEP_PERCENT = 5;

// ─── Color math (WCAG 2.1) ──────────────────────────────────────────────────

function hexToRgb(hex: Hex): { r: number; g: number; b: number } {
  const clean = hex.replace(/^#/, '');
  const full = clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean;
  if (full.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): Hex {
  const to = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

// WCAG relative luminance: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
function relativeLuminance(hex: Hex): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Hex, b: Hex): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// ─── HSL conversion ─────────────────────────────────────────────────────────

interface HSL { h: number; s: number; l: number }

function rgbToHsl(r: number, g: number, b: number): HSL {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
      case gn: h = (bn - rn) / d + 2; break;
      case bn: h = (rn - gn) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s, l };
}

function hslToRgb({ h, s, l }: HSL): { r: number; g: number; b: number } {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = ((h % 360) + 360) % 360 / 360;
  const hue2rgb = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: Math.round(hue2rgb(hk + 1 / 3) * 255),
    g: Math.round(hue2rgb(hk) * 255),
    b: Math.round(hue2rgb(hk - 1 / 3) * 255),
  };
}

function hexToHsl(hex: Hex): HSL {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHsl(r, g, b);
}

function hslToHex(hsl: HSL): Hex {
  const { r, g, b } = hslToRgb(hsl);
  return rgbToHex(r, g, b);
}

// ─── Adjustment loop ────────────────────────────────────────────────────────

interface PairSpec {
  pair: CriticalPair;
  // key of the color that gets adjusted (never bg)
  adjustKey: Exclude<keyof Palette, 'secondary'>;
  // key of the color held fixed for contrast comparison
  fixedKey: keyof Palette;
}

const CRITICAL_PAIRS: PairSpec[] = [
  { pair: 'primary_vs_bg', adjustKey: 'primary', fixedKey: 'bg' },
  { pair: 'primary_vs_text', adjustKey: 'primary', fixedKey: 'text' },
  { pair: 'text_vs_bg', adjustKey: 'text', fixedKey: 'bg' },
  { pair: 'accent_vs_bg', adjustKey: 'accent', fixedKey: 'bg' },
];

function adjustColor(
  colorHex: Hex,
  fixedHex: Hex,
): { newHex: Hex; ratio: number; method: 'darken_hsl' | 'lighten_hsl'; impossible: boolean } {
  const hsl = hexToHsl(colorHex);
  // Direction: usa WCAG relative luminance (não HSL L) — cores com hue puro
  // como amarelo têm HSL L=0.5 mas luminance ~0.93; devem escurecer, não
  // clarear. AC5 fala "luminance", que em contexto WCAG é o valor relativo.
  const luminance = relativeLuminance(colorHex);
  const darken = luminance > 0.5;
  const method: 'darken_hsl' | 'lighten_hsl' = darken ? 'darken_hsl' : 'lighten_hsl';
  const stepDelta = STEP_PERCENT / 100;

  let currentHsl: HSL = { ...hsl };
  let currentHex: Hex = colorHex;
  let bestRatio = contrastRatio(colorHex, fixedHex);
  let bestHex = colorHex;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const nextL = darken ? currentHsl.l - stepDelta : currentHsl.l + stepDelta;
    // Clamp to [0, 1]; if we hit a bound, stop iterating.
    const clampedL = Math.max(0, Math.min(1, nextL));
    if (clampedL === currentHsl.l) break;
    currentHsl = { ...currentHsl, l: clampedL };
    currentHex = hslToHex(currentHsl);
    const r = contrastRatio(currentHex, fixedHex);
    if (r > bestRatio) {
      bestRatio = r;
      bestHex = currentHex;
    }
    if (r >= WCAG_AA_THRESHOLD) {
      return { newHex: currentHex, ratio: r, method, impossible: false };
    }
  }

  return { newHex: bestHex, ratio: bestRatio, method, impossible: bestRatio < WCAG_AA_THRESHOLD };
}

export function adjustPaletteForWcagAA(input: ContrastAdjustInput): ContrastAdjustResult {
  const working: Palette = { ...input.palette };
  const adjustments: AdjustmentLog[] = [];

  for (const spec of CRITICAL_PAIRS) {
    const originalColor = working[spec.adjustKey];
    const fixedColor = working[spec.fixedKey];
    const originalRatio = contrastRatio(originalColor, fixedColor);

    if (originalRatio >= WCAG_AA_THRESHOLD) continue;

    const { newHex, ratio, method, impossible } = adjustColor(originalColor, fixedColor);

    // Persist adjusted color into working palette so subsequent pairs see it.
    working[spec.adjustKey] = newHex;

    const log: AdjustmentLog = {
      pair: spec.pair,
      original_ratio: originalRatio,
      adjusted_ratio: ratio,
      original_color: originalColor,
      new_color: newHex,
      method,
    };
    if (impossible) log.contrast_impossible = true;
    adjustments.push(log);
  }

  return { palette: working, adjustments };
}
