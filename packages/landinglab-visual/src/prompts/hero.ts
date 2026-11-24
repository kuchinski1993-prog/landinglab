// Hero Designer system prompt — Wave 1 stub.
//
// Blocos que este agent produz (Wave 2):
//   - assets.hero.urls_by_size.desktop (1920x1080)
//   - assets.hero.urls_by_size.og (1200x630)
//   - assets.hero.urls_by_size.mobile (375x812)
//
// Referências:
//   - Story 13.5 AC13
//   - Hero é âncora emocional: usa copyDeck.hooks[0].text (hook principal EN) como cena.

/**
 * Constrói o system prompt do @hero-designer. Wave 1 stub — Wave 2 completa
 * a interpolação com PIR, CopyDeck hooks[0], palette e tom.
 */
export function buildHeroDesignerSystemPrompt(
  hookText: string,
  toneVisual: string,
): string {
  return `[WAVE-1-STUB] Hero Designer — Squad 3 (Visual & Brand Forge).

You are the HERO DESIGNER agent of the Squad 3. Wave 2 will provide the full prompt.

Anchor hook (EN): ${hookText}
Tone: ${toneVisual}

Wave 2 TODO:
  - Interpolate pir.identity, pir.voc.top_desires
  - Interpolate director palette + typography
  - Generate 3 hero variants at exact sizes:
      desktop: 1920x1080  (landing hero above-the-fold)
      og:      1200x630   (OG/social share card)
      mobile:  375x812    (mobile hero)
  - Provider: Freepik Mystic primary; Higgsfield fallback via orchestrator.
`;
}
