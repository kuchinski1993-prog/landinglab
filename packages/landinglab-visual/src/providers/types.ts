// ImageProvider interface — abstração comum entre Freepik (primário) e Higgsfield (fallback).
//
// AC20 (Story 13.5): agentes recebem `ImageProvider` via DI — NUNCA importam
// `freepik.ts` ou `higgsfield.ts` diretamente. Isso permite:
//   1. Trocar provider (Freepik → Higgsfield) sem tocar agentes.
//   2. Testar com mock provider trivialmente.
//   3. Orchestrator implementa fallback automático (Wave 2 AC23):
//      try freepik.generateImage() → on FreepikProviderError retryable=true → higgsfield.generateImage().
//
// Wave 1: interface + stubs. Wave 2: implementações reais.

/**
 * Tamanhos suportados (v1 fixos — cobrem hero 3-way + lifestyle + ícones + badges).
 * Wave 2 pode expandir (ex.: adicionar 1080x1920 vertical se necessário).
 * Convenção: "WxH" ou string livre para providers que aceitam any-size (Freepik Mystic).
 */
export type ImageSize =
  | '1920x1080' // desktop hero
  | '1200x630' // OG/social hero
  | '375x812' // mobile hero
  | '1024x1024' // lifestyle/badges square
  | '512x512' // icons
  | '256x256' // small icons
  | (string & { readonly _custom?: never }); // permite custom para Wave 2 sem quebrar tipagem

/**
 * Input do generateImage. `style` e `seed` são opcionais e best-effort:
 * providers que não suportam ignoram.
 */
export interface GenerateImageInput {
  /** Prompt textual — cada agente monta seu próprio prompt com PIR + CopyDeck context. */
  prompt: string;
  /** Tamanho da imagem (v1 valores fixos, Wave 2 pode aceitar custom "WxH"). */
  size: ImageSize;
  /** Estilo opcional (ex.: "photorealistic", "flat-icon", "cinematic"). */
  style?: string;
  /** Seed opcional para reprodutibilidade (Freepik Mystic aceita). */
  seed?: number;
  /** Negative prompt opcional (o que evitar). */
  negative_prompt?: string;
}

/**
 * Output do generateImage. `url` é a URL retornada diretamente pelo provider —
 * v1 não faz upload para CDN próprio (Squad 4 pode fazer rehost se necessário).
 * `provider_meta` é opaque JSON para debugging/audit.
 */
export interface GenerateImageOutput {
  /** URL da imagem gerada (retornada pelo provider). */
  url: string;
  /** Custo estimado desta chamada (USD). */
  cost_usd: number;
  /** Tokens/credits input (best-effort — nem todo provider reporta). */
  tokens_in?: number;
  /** Tokens/credits output (best-effort). */
  tokens_out?: number;
  /** Latência total desta chamada (ms). */
  latency_ms: number;
  /** Metadata opaca do provider (seed usada, model version, etc). Para audit trail. */
  provider_meta?: Record<string, unknown>;
}

/**
 * Interface comum entre providers. Wave 2 real impl:
 *   - freepik.ts: usa fetch + POST /v1/images/mystic
 *   - higgsfield.ts: wraps skills higgsfield-generate / higgsfield-product-photoshoot
 *     (decisão skill-vs-HTTP-direto documentada em director_notes na Wave 2).
 */
export interface ImageProvider {
  /** Nome do provider — usado em contributing_agents e director_notes. */
  readonly name: 'freepik' | 'higgsfield';
  /** Gera uma imagem. Wave 1 stubs throw NotImplementedError. */
  generateImage(input: GenerateImageInput): Promise<GenerateImageOutput>;
}
