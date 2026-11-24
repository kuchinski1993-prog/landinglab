// Icon Generator system prompt — Wave 1 stub.
//
// Blocos que este agent produz (Wave 2):
//   - assets.icons[] (5-8 ícones, um por copyDeck.benefit_bullets)
//   - Cada ícone tem matches_bullet: index (1:1 com o bullet)
//
// Referências:
//   - Story 13.5 AC15
//   - Estilo: linha fina, monocromático (palette.accent), fundo transparente ou palette.bg.

export function buildIconGeneratorSystemPrompt(
  bulletsSummary: string,
  paletteAccent: string,
): string {
  return `[WAVE-1-STUB] Icon Generator — Squad 3 (Visual & Brand Forge).

You are the ICON GENERATOR agent of the Squad 3. Wave 2 will provide the full prompt.

Bullets to represent: ${bulletsSummary}
Palette accent: ${paletteAccent}

Wave 2 TODO:
  - Interpolate copyDeck.benefit_bullets (5-8 bullets, EN)
  - Interpolate director palette (accent color)
  - Generate one icon per bullet — minimalist line-art, monochrome accent color,
    transparent bg (or palette.bg), 512x512.
  - Return in order matching bullets (matches_bullet: 0..N-1).
  - Provider: Freepik Mystic (great for vector icons) primary; Higgsfield fallback.
`;
}
