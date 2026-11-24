// Visual Assets — Zod schema (Squad 3 — Story 13.5, AC3, AC25, AC26).
//
// Este é o artefato core do Squad 3. Toda validação de output do @visual-director
// (orquestrador) passa por aqui. Downstream Squad 4 (Builder HTML) consome
// Visual Assets com esta exata shape.
//
// Agentes contribuintes (por bloco):
//   - Visual Director: paleta, tipografia, tom, contributing_agents, director_notes
//   - Brand Forge:     brand.name, brand.tagline, brand.logo_urls
//   - Hero Designer:   assets.hero.urls_by_size
//   - Lifestyle:       assets.lifestyle[]
//   - Icon Generator:  assets.icons[]
//   - Social Proof:    assets.trust_badges[], assets.before_after[], assets.backgrounds[]
//
// Article IV (No Invention) enforcement — TRIPLA proteção:
//   1. Schema-level: director_notes DEVE ter length >= 10 (.min(10))
//   2. Runtime guard: validateVisualAssets() dobra-checa após parse
//   3. Brand name filter: rejeita marcas reais (rejectsBannedBrands)
//
// Referência de padrão: packages/landinglab-copy/src/schema/copy-deck.ts (Squad 2).

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────
// Regex helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Hex color (#RGB, #RRGGBB, #RRGGBBAA). Case-insensitive.
 * Aceita apenas hex — Wave 2 pode expandir para oklch/hsl se necessário.
 */
const HEX_COLOR_REGEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const hexColor = () =>
  z.string().regex(HEX_COLOR_REGEX, 'Color must be a hex code (e.g., #FF0000)');

// ─────────────────────────────────────────────────────────────────────────
// Article IV: Brand name filter — lista de marcas reais banidas
// ─────────────────────────────────────────────────────────────────────────

/**
 * Substrings (case-insensitive) que disparam rejeição de brand.name.
 * v1: match de substring (não fonético). Wave 2 pode expandir.
 * Dev pode extender esta lista se necessário — mudanças aqui devem ser
 * refletidas na Story 13.5 AC12/AC26 para manter rastreabilidade.
 */
export const BANNED_BRAND_TERMS = [
  'apple',
  'nike',
  'amazon',
  'adidas',
  'coca',
  'pepsi',
  'google',
  'microsoft',
  'samsung',
  'sony',
  'louis vuitton',
  'gucci',
  'chanel',
] as const;

/**
 * Retorna true se `name` NÃO viola o filter (i.e., é aceito).
 * Retorna false se contém qualquer termo banido (case-insensitive, substring match).
 * Usado por brand-forge para retry loop (AC26).
 *
 * Nota semântica: nome "rejects" = a função "rejeita marcas reais",
 * retornando `true` quando o nome é limpo e `false` quando viola.
 */
export function rejectsBannedBrands(name: string): boolean {
  const lower = name.toLowerCase();
  for (const term of BANNED_BRAND_TERMS) {
    if (lower.includes(term)) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// Sub-schemas (brand)
// ─────────────────────────────────────────────────────────────────────────

/** URLs dos 3 formatos do logo. Full = versão completa, mark = símbolo/ícone, wordmark = tipografia. */
export const LogoUrlsSchema = z.object({
  full: z.string().url(),
  mark: z.string().url(),
  wordmark: z.string().url(),
});
export type LogoUrls = z.infer<typeof LogoUrlsSchema>;

/** Paleta de 5 cores fixas (Article IV: nomes semânticos são obrigatórios). */
export const BrandPaletteSchema = z.object({
  primary: hexColor(),
  secondary: hexColor(),
  accent: hexColor(),
  bg: hexColor(),
  text: hexColor(),
});
export type BrandPalette = z.infer<typeof BrandPaletteSchema>;

/** Tipografia: 2 fontes (headline + body — nomes Google Fonts). */
export const BrandTypographySchema = z.object({
  headline_font: z.string().min(1),
  body_font: z.string().min(1),
});
export type BrandTypography = z.infer<typeof BrandTypographySchema>;

/** Identidade de marca completa. */
export const BrandSchema = z.object({
  name: z.string().min(3, 'Brand name must be at least 3 chars').max(30, 'Brand name too long (> 30 chars)'),
  tagline: z.string().min(5, 'Tagline must be at least 5 chars').max(80, 'Tagline too long (> 80 chars)'),
  logo_urls: LogoUrlsSchema,
  palette: BrandPaletteSchema,
  typography: BrandTypographySchema,
});
export type Brand = z.infer<typeof BrandSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Sub-schemas (assets)
// ─────────────────────────────────────────────────────────────────────────

/** Hero cinematográfico em 3 tamanhos: desktop (1920x1080), OG/social (1200x630), mobile (375x812). */
export const HeroUrlsBySizeSchema = z.object({
  desktop: z.string().url(),
  og: z.string().url(),
  mobile: z.string().url(),
});
export type HeroUrlsBySize = z.infer<typeof HeroUrlsBySizeSchema>;

export const HeroSchema = z.object({
  urls_by_size: HeroUrlsBySizeSchema,
});
export type Hero = z.infer<typeof HeroSchema>;

/**
 * Ícone minimalista. Cada ícone corresponde 1:1 a um bullet do copyDeck.benefit_bullets.
 * matches_bullet é o index do bullet no array — permite ao Squad 4 renderizar ícone+bullet.
 */
export const IconSchema = z.object({
  url: z.string().url(),
  matches_bullet: z.number().int().nonnegative(),
});
export type Icon = z.infer<typeof IconSchema>;

/** Assets completos gerados pelo Squad. */
export const AssetsSchema = z.object({
  hero: HeroSchema,
  lifestyle: z.array(z.string().url()).min(3, 'At least 3 lifestyle images').max(5, 'At most 5 lifestyle images'),
  icons: z.array(IconSchema).min(5, 'At least 5 icons').max(8, 'At most 8 icons'),
  trust_badges: z.array(z.string().url()).min(2, 'At least 2 trust badges').max(3, 'At most 3 trust badges'),
  before_after: z.array(z.string().url()).min(1).max(2).optional(),
  backgrounds: z.array(z.string().url()).min(1).max(2).optional(),
});
export type Assets = z.infer<typeof AssetsSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Contributing agents (audit trail)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Contribuição de agente por bloco — populated pelo Visual Director.
 * Director-facing audit trail: "quem contribuiu qual bloco".
 */
export const ContributingAgentSchema = z.object({
  agent: z.string().min(1),
  blocks_contributed: z.array(z.string().min(1)).min(1),
});
export type ContributingAgent = z.infer<typeof ContributingAgentSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Top-level VisualAssets schema
// ─────────────────────────────────────────────────────────────────────────

export const VisualAssetsSchema = z.object({
  /** Schema version — bump quando shape muda (breaking). */
  schema_version: z.literal('1.0.0').default('1.0.0'),

  // ─── Brand identity (Visual Director + Brand Forge) ────────────────────
  brand: BrandSchema,

  // ─── Visual assets (5 agentes downstream) ──────────────────────────────
  assets: AssetsSchema,

  // ─── Audit trail (Visual Director popula ao montar pacote) ─────────────
  contributing_agents: z.array(ContributingAgentSchema).default([]),

  // ─── ARTICLE IV ENFORCEMENT (No Invention) ─────────────────────────────
  /**
   * Racional do Director: paleta escolhida, tom visual, fallbacks de provider
   * usados (Freepik → Higgsfield), assets omitidos por falha.
   * Mínimo 10 chars — validateVisualAssets() dobra a verificação em runtime.
   */
  director_notes: z
    .string()
    .min(10, 'director_notes must be at least 10 chars (Article IV — No Invention)'),
});

export type VisualAssets = z.infer<typeof VisualAssetsSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Runtime validator com mensagens contextualizadas
// ─────────────────────────────────────────────────────────────────────────

/**
 * Valida input contra VisualAssetsSchema. Se falhar, lança VisualAssetsValidationError
 * com mensagem legível (usada pelo Visual Director no fluxo de retry Zod-aware).
 *
 * Guards runtime adicionais:
 *   1. director_notes.length >= 10 (Article IV) — schema já força, guard duplo.
 *   2. brand.name passa em rejectsBannedBrands() — evita marcas reais persistidas.
 *   3. assets.hero.urls_by_size tem pelo menos desktop OU mobile (hero obrigatório).
 */
export function validateVisualAssets(input: unknown): VisualAssets {
  const result = VisualAssetsSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new VisualAssetsValidationError(
      `VisualAssets schema validation failed:\n${issues}`,
      result.error.issues,
    );
  }

  const data = result.data;

  // Guard 1 — Article IV: director_notes não vazio (schema já força, paranoia > confiança).
  if (data.director_notes.trim().length < 10) {
    throw new VisualAssetsValidationError(
      'director_notes must have at least 10 non-whitespace chars (Constitution Article IV — No Invention). ' +
        'The Visual Director must document palette choice, provider fallbacks, and any omitted assets.',
      [],
    );
  }

  // Guard 2 — Article IV: brand name filter.
  if (!rejectsBannedBrands(data.brand.name)) {
    throw new VisualAssetsValidationError(
      `Brand name "${data.brand.name}" contains a banned real-brand term. ` +
        `Brand Forge must generate a fictional brand name — see BANNED_BRAND_TERMS.`,
      [],
    );
  }

  // Guard 3 — hero obrigatório: pelo menos desktop OU mobile presentes.
  const { desktop, mobile } = data.assets.hero.urls_by_size;
  if (!desktop && !mobile) {
    throw new VisualAssetsValidationError(
      'assets.hero.urls_by_size must include at least desktop or mobile URL. ' +
        'Squad 4 (Builder) cannot render landing without hero image.',
      [],
    );
  }

  return data;
}

/** Erro custom para diferenciar validação de VisualAssets de outros erros. */
export class VisualAssetsValidationError extends Error {
  public readonly issues: z.ZodIssue[];
  constructor(message: string, issues: z.ZodIssue[]) {
    super(message);
    this.name = 'VisualAssetsValidationError';
    this.issues = issues;
  }
}
