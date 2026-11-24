// Brand Forge system prompt — Wave 1 stub.
//
// Blocos que este agent produz (Wave 2):
//   - brand.name (nome de marca fictício, min 3, max 30, passa em rejectsBannedBrands)
//   - brand.tagline (min 5, max 80)
//   - brand.logo_urls {full, mark, wordmark} (via ImageProvider)
//
// Inputs esperados (Wave 2 populam interpolação real):
//   - pir.identity.name, pir.avatar (demografia + contexto), pir.market.sophistication_level
//   - director decisions: palette (5 hex), typography (2 fonts), tom visual
//
// Referências:
//   - Story 13.5 AC12
//   - PIR shape: packages/landinglab-research/src/schema/pir.ts
//   - CopyDeck shape: packages/landinglab-copy/src/schema/copy-deck.ts
//   - Article IV filter: BANNED_BRAND_TERMS em src/schema/visual-assets.ts

/**
 * Constrói o system prompt do @brand-forge. Wave 1 stub — Wave 2 completa
 * a interpolação com PIR, decisões do Director e retry-error injection para o
 * caso de brand name violar o filter (AC26).
 *
 * @param productName do PIR (identity.name) — placeholder até Wave 2 receber Pir completo.
 * @param toneVisual decisão do Director (ex.: "energético e aspiracional").
 * @param retryError opcional — mensagem do último erro (brand name filter) para retry.
 */
export function buildBrandForgeSystemPrompt(
  productName: string,
  toneVisual: string,
  retryError?: string | null,
): string {
  const retrySection = retryError
    ? `\n\n═══════════════════════════════════════════════════════════\nPREVIOUS ATTEMPT FAILED — FIX THIS\n═══════════════════════════════════════════════════════════\n${retryError}\n\nReturn a NEW brand name that does not violate the filter.`
    : '';

  // Wave 2 popula o prompt completo com PIR + palette + typography.
  return `[WAVE-1-STUB] Brand Forge — Squad 3 (Visual & Brand Forge).

You are the BRAND FORGE agent of the Squad 3. Wave 2 will provide the full prompt.

Product: ${productName}
Tone: ${toneVisual}${retrySection}

Wave 2 TODO:
  - Interpolate pir.identity.name, pir.avatar, pir.market.sophistication_level
  - Interpolate director decisions: palette (5 hex), typography (2 fonts), tone
  - Emit fictional brand name (3-30 chars) that PASSES BANNED_BRAND_TERMS filter
  - Emit tagline (5-80 chars) that echoes pir.value_equation.dream_outcome
  - Emit 3 logo URLs (full, mark, wordmark) via deps.imageProvider.generateImage()
`;
}
