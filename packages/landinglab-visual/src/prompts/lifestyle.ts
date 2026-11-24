// Lifestyle Composer system prompt — Wave 1 stub.
//
// Blocos que este agent produz (Wave 2):
//   - assets.lifestyle[] (3-5 URLs — produto em contexto de uso do avatar)
//
// Referências:
//   - Story 13.5 AC14
//   - Cada imagem representa um contexto de uso diferente (casa, ao ar livre,
//     profissional — derivados de pir.avatar).

export function buildLifestyleComposerSystemPrompt(
  avatarSummary: string,
  toneVisual: string,
): string {
  return `[WAVE-1-STUB] Lifestyle Composer — Squad 3 (Visual & Brand Forge).

You are the LIFESTYLE COMPOSER agent of the Squad 3. Wave 2 will provide the full prompt.

Avatar: ${avatarSummary}
Tone: ${toneVisual}

Wave 2 TODO:
  - Interpolate pir.avatar (demografia, contexto de vida), pir.voc.top_desires
  - Interpolate pir.identity.name (produto), director palette
  - Generate 3-5 lifestyle scenes: contextos de uso diferentes
      (ex.: em casa, ao ar livre, contexto profissional)
  - Provider: Freepik Mystic primary; Higgsfield product-photoshoot fallback.
`;
}
