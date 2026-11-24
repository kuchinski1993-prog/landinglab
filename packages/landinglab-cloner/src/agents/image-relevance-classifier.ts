// Image relevance classifier — filtra imagens elegíveis pra rebrand/tradução.
//
// Contexto: uma landing dropship típica tem 200-300 imagens. Só 5-15% são
// realmente elegíveis pra passar por Seedream (rebrand + tradução). O resto
// é:
//   - Bandeiras de cartão de crédito (Visa/Mastercard/PayPal)
//   - Selos de qualidade genéricos (SSL, Money-back, Free Shipping)
//   - Ícones de UI (setas, checkmarks, stars, emoji)
//   - Backgrounds abstratos
//   - Fotos de rostos sem texto (adaptar demografia é outro fluxo)
//   - Logos de terceiros (Trustpilot, USPS, etc)
//
// Sem filtragem, o Wizard mostra grid confuso com 300 imgs, usuário perde
// tempo desmarcando 285 e ainda erra alguma → Seedream custa dinheiro à toa.
//
// Solução: IA Vision (Gemini Flash com input imagem) classifica cada imagem.
// Custo ~$0.001 por imagem (bem menor que Seedream $0.04). Landing 300 imgs
// = $0.30 pra saber quais são as 15 relevantes. Compensa MUITO.
//
// Estratégia:
//   1. Reduz cada imagem pra 384px (mantém aspect ratio) via sharp
//   2. Envia batch de 5 imagens por request Gemini (paraleliza classificação)
//   3. Gemini retorna JSON com { relevant, category, confidence, reason }
//   4. Fallback: se Gemini falhar, marca como relevant=true (não filtra)
//      pra não bloquear fluxo.

import sharp from 'sharp';

import { callGeminiVision } from '../providers/gemini-vision.js';

export interface ImageRelevanceItem {
  url: string;
  relevant: boolean;
  category:
    | 'product'
    | 'hero'
    | 'copy'
    | 'testimonial'
    | 'lifestyle'
    | 'icon'
    | 'flag'
    | 'badge'
    | 'background'
    | 'unknown';
  confidence: number;
  reason: string;
}

export interface ClassifyImagesInput {
  imageUrls: string[];
  /** Concorrência (default 3 — Gemini rate limit tolerante). */
  concurrency?: number;
  /** Progress callback opcional. */
  onProgress?: (done: number, total: number) => void;
}

export interface ClassifyImagesResult {
  items: ImageRelevanceItem[];
  costUsd: number;
  latencyMs: number;
  errors: number;
}

async function fetchAndReduce(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; LandingLabCloner/1.0)' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  const original = Buffer.from(ab);

  // Reduz pra 384px + reencoda pra JPEG (menor que WebP em input Gemini)
  const reduced = await sharp(original, { failOn: 'none' })
    .resize(384, 384, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer();

  return { buffer: reduced, mimeType: 'image/jpeg' };
}

async function classifyOne(url: string): Promise<ImageRelevanceItem> {
  try {
    const { buffer, mimeType } = await fetchAndReduce(url);
    const base64 = buffer.toString('base64');

    const system = `You are an image classifier for e-commerce landing pages. Given a single image, decide if it is RELEVANT for brand substitution or text translation.

RELEVANT categories (return relevant=true):
- product: product photo, packaging, bottles, labels
- hero: main hero banner with product + tagline
- copy: image containing marketing text/copy (headlines, promises, offers)
- testimonial: customer photo with review text
- lifestyle: person USING the product (may need face adaptation)

NOT RELEVANT categories (return relevant=false):
- icon: UI icons (arrows, checkmarks, stars, small graphics <64px)
- flag: payment method flags (Visa, Mastercard, PayPal, Amex)
- badge: generic trust badges (SSL, money-back guarantee, free shipping WITHOUT product context)
- background: abstract backgrounds, gradients, textures without content
- unknown: cannot determine

Return ONLY valid JSON in format:
{"relevant":true,"category":"product","confidence":90,"reason":"Bottle with brand name visible"}

DO NOT include markdown fences, explanations, or any text outside the JSON.`;

    const user = 'Classify this image:';

    const result = await callGeminiVision({
      system,
      user,
      imageBase64: base64,
      imageMimeType: mimeType,
      model: 'gemini-3.6-flash',
      maxTokens: 200,
      temperature: 0.1,
    });

    let raw = result.content.trim();
    const fenceStrip = raw.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/);
    if (fenceStrip?.[1]) raw = fenceStrip[1].trim();

    const parsed = JSON.parse(raw) as {
      relevant: boolean;
      category: ImageRelevanceItem['category'];
      confidence: number;
      reason: string;
    };

    return {
      url,
      relevant: Boolean(parsed.relevant),
      category: parsed.category ?? 'unknown',
      confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : 50,
      reason: String(parsed.reason ?? '').slice(0, 200),
    };
  } catch (err) {
    // Falha graciosa: marca como relevante (não filtra) + reason indica erro
    return {
      url,
      relevant: true,
      category: 'unknown',
      confidence: 0,
      reason: `Classification failed: ${err instanceof Error ? err.message : 'error'}`,
    };
  }
}

export async function classifyImages(
  input: ClassifyImagesInput,
): Promise<ClassifyImagesResult> {
  const started = Date.now();
  const { imageUrls, concurrency = 3, onProgress } = input;

  // Fase S.2.3 — Gemini Vision desativado por default pra economizar créditos.
  // Rodava em CADA imagem da landing (200-300) → $0.28 por reclone. Usuário
  // decidiu que Gemini deve ser usado APENAS pra tradução de texto.
  //
  // Comportamento fallback: marca TODAS como relevant=true (sem filtro IA).
  // O grid do modal/wizard já tem outras heurísticas (isInHtml, hasText,
  // categoria por classes CSS) que filtram bem sem IA.
  //
  // Opt-in via env USE_GEMINI_VISION_CLASSIFIER=1 pra reativar (se dev quiser
  // gastar em experimento).
  const useGeminiVision = process.env['USE_GEMINI_VISION_CLASSIFIER'] === '1';

  if (!useGeminiVision) {
    // Fallback barato: marca tudo como relevant, categoria unknown.
    // Filtragem real acontece no cliente (Wizard/Modal) via hasText + isInHtml.
    return {
      items: imageUrls.map((url) => ({
        url,
        relevant: true,
        category: 'unknown' as const,
        confidence: 0,
        reason: 'Gemini Vision classifier desativado (USE_GEMINI_VISION_CLASSIFIER=0)',
      })),
      costUsd: 0,
      latencyMs: Date.now() - started,
      errors: 0,
    };
  }

  const results: (ImageRelevanceItem | null)[] = new Array(imageUrls.length).fill(null);
  let done = 0;
  let errors = 0;

  const queue = imageUrls.map((url, i) => ({ url, i }));

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) return;
      const classified = await classifyOne(item.url);
      results[item.i] = classified;
      if (classified.confidence === 0) errors++;
      done++;
      onProgress?.(done, imageUrls.length);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const costUsd = imageUrls.length * 0.001;

  return {
    items: results.filter((r): r is ImageRelevanceItem => r !== null),
    costUsd,
    latencyMs: Date.now() - started,
    errors,
  };
}
