// Social Proof Designer system prompt — Wave 1 stub.
//
// Blocos que este agent produz (Wave 2):
//   - assets.trust_badges[] (2-3 badges — ícone + shape, sem copy real)
//   - assets.before_after[] (1-2 templates — layout duas caixas, placeholders)
//   - templates de testimonial (não persistidos direto; agrupados em backgrounds)
//
// IMPORTANTE: assets visuais SEM conteúdo textual real — o texto vem do Squad 2.
// O designer entrega SHAPE e ESTILO; o Squad 4 (Builder HTML) sobrepõe o texto.
//
// Referências:
//   - Story 13.5 AC16

export function buildSocialProofDesignerSystemPrompt(
  productNiche: string,
  paletteAccent: string,
): string {
  return `[WAVE-1-STUB] Social Proof Designer — Squad 3 (Visual & Brand Forge).

You are the SOCIAL PROOF DESIGNER agent of the Squad 3. Wave 2 will provide the full prompt.

Product niche: ${productNiche}
Palette accent: ${paletteAccent}

Wave 2 TODO:
  - Interpolate director palette + typography, pir.identity.name (for niche context)
  - Generate visual-only assets (NO real text — text comes from Squad 2 via HTML):
      trust_badges (2-3): ícone + shape, sem copy real (ex.: "shield outline",
        "clock outline", "chat bubble outline") em palette.accent
      before_after (1-2): layout de duas caixas lado a lado, placeholders de imagem
      testimonial cards (1-2): layout avatar placeholder + linhas de texto placeholder + estrelas
  - Provider: Freepik Mystic primary; Higgsfield fallback.
`;
}
