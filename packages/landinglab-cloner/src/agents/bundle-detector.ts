// Bundle detector — Wizard V2 Step 4 (Preços).
//
// Extrai bundles/faixas de preço de uma landing origem usando Gemini Flash.
// Pra Shopify Dawn/Kaching/etc, os bundles são markup específico do tema —
// regex/parse5 é muito frágil. IA é 10x mais robusta e custa $0.001.
//
// Estratégia:
//   1. Reduz HTML pra <body> + apenas trechos relevantes (preços, botões)
//   2. Prompt estruturado exigindo JSON com bundles array
//   3. Retorna array vazio se IA não achou (falha graciosa)
//
// Diferença do product-extractor:
//   - product-extractor: pega variantes Shopify tradicionais (single product,
//     multi-variant como "60 caps", "180 caps") via regex.
//   - bundle-detector: pega BUNDLES (1 unidade, 3 unidades c/ desconto, etc)
//     que geralmente vivem em blocos custom do tema — IA-first.

import { callGemini } from '../providers/gemini-text.js';

export interface DetectedBundle {
  /** Nome curto pra badge/título ("1 frasco", "3 frascos") */
  name: string;
  /** Descrição expandida pra copy do bundle ("Ideal pra iniciar", "Mais vendido"). */
  description: string;
  /** Quantidade de unidades no bundle (1, 3, 5 frascos). Null se não deu pra inferir. */
  quantityUnits: number | null;
  /** Preço promocional detectado (o que o usuário paga). Sempre em unidades inteiras (cents). */
  priceCents: number;
  /** Preço "de" riscado — economia mostrada. Null se não tem. */
  compareAtPriceCents: number | null;
  /** Moeda ISO-4217 detectada. */
  currency: string;
  /** Confidence 0-100 heurística da IA. Below 50 = mostra warning na UI. */
  confidence: number;
}

export interface BundleDetectionResult {
  bundles: DetectedBundle[];
  costUsd: number;
  latencyMs: number;
  source: 'gemini' | 'fallback' | 'none';
  /** Warnings pra UI (ex: "confidence baixa, revise preços"). */
  warnings: string[];
}

/**
 * Reduz HTML pra ~30-50KB focado em blocos de preço/bundle.
 *
 * Estratégia:
 *   1. Remove scripts/styles/comments (reduz 40-70% do tamanho)
 *   2. Se ainda > 40KB, busca "janelas" de 8KB em volta de cada match de:
 *      - Padrões de preço ($NN.NN, €NN, ¥NN, R$NN)
 *      - Palavras-chave de bundle ("Buy X Get Y", "pack", "bundle", "save", "off")
 *   3. Concatena top-5 janelas com marker separador
 *
 * Muitas landings (Shopify Dawn, Kaching) têm bundles em blocks JS-hydrated
 * que aparecem no meio ou no fim do HTML — cortar 15KB do início perde tudo.
 */
function extractPricingRegions(html: string): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch?.[1] ?? html;

  const cleaned = body
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const MAX_TOTAL = 40000;
  if (cleaned.length <= MAX_TOTAL) return cleaned;

  // Busca posições de padrões relevantes
  const patterns: RegExp[] = [
    /\$\s?\d{1,4}(?:[.,]\d{2})?/g,           // $99.99
    /€\s?\d{1,4}(?:[.,]\d{2})?/g,             // €99,99
    /£\s?\d{1,4}(?:[.,]\d{2})?/g,             // £99
    /¥\s?\d{1,4}(?:[.,]\d{2})?/g,             // ¥99
    /R\$\s?\d{1,4}(?:[.,]\d{2})?/g,           // R$ 97,00
    /\b(?:buy|compre|comprare?)\s+\d+\s+(?:get|leve|and)\s+\d+/gi,
    /\bmost\s+popular\b/gi,
    /\bbest\s+value\b/gi,
    /\bbundle\b/gi,
    /\bpack\b/gi,
    /save\s+\d+%/gi,
    /\d+%\s+off/gi,
    /add\s+to\s+cart/gi,
  ];

  const positions = new Set<number>();
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) {
      positions.add(m.index);
      if (positions.size > 200) break;
    }
    if (positions.size > 200) break;
  }

  if (positions.size === 0) {
    // Sem matches — cai pro comportamento antigo
    return cleaned.slice(0, MAX_TOTAL);
  }

  // Agrupa posições próximas (dentro de 4KB uma da outra) em janelas.
  // Cada janela tem +-4KB do centro do cluster.
  const sorted = Array.from(positions).sort((a, b) => a - b);
  const WINDOW_HALF = 4000;
  const windows: Array<{ start: number; end: number }> = [];
  let currentStart = Math.max(0, sorted[0]! - WINDOW_HALF);
  let currentEnd = Math.min(cleaned.length, sorted[0]! + WINDOW_HALF);
  for (let i = 1; i < sorted.length; i++) {
    const pos = sorted[i]!;
    if (pos <= currentEnd + WINDOW_HALF) {
      // extende janela atual
      currentEnd = Math.min(cleaned.length, pos + WINDOW_HALF);
    } else {
      windows.push({ start: currentStart, end: currentEnd });
      currentStart = Math.max(0, pos - WINDOW_HALF);
      currentEnd = Math.min(cleaned.length, pos + WINDOW_HALF);
    }
  }
  windows.push({ start: currentStart, end: currentEnd });

  // Score janelas pela densidade de matches; pega top 5
  const scored = windows.map((w) => {
    let count = 0;
    for (const p of sorted) if (p >= w.start && p <= w.end) count++;
    return { ...w, score: count };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 5).sort((a, b) => a.start - b.start);

  const chunks = top.map((w) => cleaned.slice(w.start, w.end));
  const joined = chunks.join('\n\n[...]\n\n');

  // Cap absoluto pra não estourar tokens (Gemini free tier tem 1M context mas
  // pra economizar cost mantemos <=40KB).
  return joined.length > MAX_TOTAL ? joined.slice(0, MAX_TOTAL) : joined;
}

export async function detectBundles(html: string): Promise<BundleDetectionResult> {
  const started = Date.now();
  const trimmedHtml = extractPricingRegions(html);

  const system = `You are a product landing page analyzer specialized in identifying BUNDLES/PACKAGES sold on the page.

A BUNDLE is a purchase option like:
- "1 bottle" for $25
- "3 bottles + FREE gift" for $65 (crossed out $75)
- "6 bottles (Best Value) - Save 40%" for $99

You will receive HTML from a landing page. Extract ALL distinct bundles. For each, return:
- name: short name (max 30 chars) — e.g. "1 bottle", "3-pack", "Family pack"
- description: fuller description shown to buyer (max 100 chars) — e.g. "Perfect for trying", "Best value — save 40%"
- quantityUnits: number of physical units in bundle (1, 3, 6, etc). NULL if not inferable.
- priceCents: promotional price (what customer pays) as INTEGER CENTS (e.g. $25.00 = 2500, ¥99 = 9900)
- compareAtPriceCents: original crossed-out price in CENTS. NULL if none.
- currency: ISO-4217 (USD, EUR, JPY, BRL, GBP)
- confidence: 0-100 how sure you are (100 = both prices clearly stated, 50 = inferred)

Return ONLY valid JSON in format:
{"bundles":[{"name":"...","description":"...","quantityUnits":null,"priceCents":0,"compareAtPriceCents":null,"currency":"USD","confidence":0}]}

If you find NO bundles, return {"bundles":[]}.
DO NOT include markdown fences, explanations, or any text outside the JSON.`;

  const user = `HTML:
${trimmedHtml}

JSON output:`;

  try {
    const result = await callGemini({
      system,
      user,
      model: 'gemini-3.6-flash',
      maxTokens: 4000,
      temperature: 0.1,
      jsonMode: true,
    });

    let raw = result.content.trim();
    // Remove markdown fences se envolvem tudo (Gemini às vezes envolve)
    const fenceStrip = raw.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/);
    if (fenceStrip?.[1]) {
      raw = fenceStrip[1].trim();
    }
    let parsed: { bundles?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Estratégia 1: extrair JSON de markdown fence ```json ... ```
      const fenceMatch = raw.match(/```(?:json)?\s*(\{[\s\S]+?\})\s*```/);
      if (fenceMatch?.[1]) {
        try {
          parsed = JSON.parse(fenceMatch[1]);
        } catch {
          // continua abaixo
          parsed = { bundles: undefined };
        }
      } else {
        parsed = { bundles: undefined };
      }
      // Estratégia 2: extrair primeiro objeto JSON balanceado do texto
      if (!parsed.bundles) {
        const objMatch = raw.match(/\{[\s\S]*"bundles"[\s\S]*\}/);
        if (objMatch?.[0]) {
          try {
            parsed = JSON.parse(objMatch[0]);
          } catch {
            // Última tentativa: pegar SÓ o array bundles com regex tolerante
            const arrMatch = raw.match(/"bundles"\s*:\s*(\[[\s\S]*?\])/);
            if (arrMatch?.[1]) {
              try {
                parsed = { bundles: JSON.parse(arrMatch[1]) };
              } catch {
                return {
                  bundles: [],
                  costUsd: result.cost_usd,
                  latencyMs: Date.now() - started,
                  source: 'gemini',
                  warnings: [
                    `IA retornou JSON inválido: ${raw.slice(0, 200).replace(/\n/g, ' ')}`,
                  ],
                };
              }
            }
          }
        } else {
          return {
            bundles: [],
            costUsd: result.cost_usd,
            latencyMs: Date.now() - started,
            source: 'gemini',
            warnings: [
              `IA retornou sem JSON: ${raw.slice(0, 200).replace(/\n/g, ' ')}`,
            ],
          };
        }
      }
    }

    // Aceita variações: bundles, products, packages, offers, plans, variants
    const bundlesRaw =
      (parsed as Record<string, unknown>)['bundles'] ??
      (parsed as Record<string, unknown>)['products'] ??
      (parsed as Record<string, unknown>)['packages'] ??
      (parsed as Record<string, unknown>)['offers'] ??
      (parsed as Record<string, unknown>)['plans'] ??
      (parsed as Record<string, unknown>)['variants'];

    if (!Array.isArray(bundlesRaw)) {
      return {
        bundles: [],
        costUsd: result.cost_usd,
        latencyMs: Date.now() - started,
        source: 'gemini',
        warnings: [
          `IA retornou objeto sem 'bundles'/'products' array. Chaves: ${Object.keys(parsed).slice(0, 10).join(', ')}. Preview: ${raw.slice(0, 200).replace(/\n/g, ' ')}`,
        ],
      };
    }

    // Sobrescreve parsed.bundles pra loop abaixo trabalhar
    (parsed as Record<string, unknown>).bundles = bundlesRaw;

    // Valida + normaliza cada bundle
    const bundles: DetectedBundle[] = [];
    const warnings: string[] = [];
    for (const raw of parsed.bundles as unknown[]) {
      if (!raw || typeof raw !== 'object') continue;
      const b = raw as Record<string, unknown>;
      const priceCents = Number(b['priceCents']);
      if (!Number.isFinite(priceCents) || priceCents <= 0) continue;
      const compareAtRaw = b['compareAtPriceCents'];
      const compareAt =
        compareAtRaw != null && Number.isFinite(Number(compareAtRaw)) && Number(compareAtRaw) > 0
          ? Math.round(Number(compareAtRaw))
          : null;
      const qtyRaw = b['quantityUnits'];
      const qty =
        qtyRaw != null && Number.isFinite(Number(qtyRaw)) && Number(qtyRaw) > 0
          ? Math.round(Number(qtyRaw))
          : null;
      const conf = Number(b['confidence']);
      const bundle: DetectedBundle = {
        name: String(b['name'] ?? 'Bundle').slice(0, 60),
        description: String(b['description'] ?? '').slice(0, 200),
        quantityUnits: qty,
        priceCents: Math.round(priceCents),
        compareAtPriceCents: compareAt,
        currency: String(b['currency'] ?? 'USD').toUpperCase().slice(0, 3),
        confidence: Number.isFinite(conf) ? Math.min(100, Math.max(0, Math.round(conf))) : 50,
      };
      if (bundle.confidence < 40) {
        warnings.push(`Bundle "${bundle.name}": confidence baixa — revise valores`);
      }
      bundles.push(bundle);
    }

    // Ordena por preço ascendente pra UI mostrar sempre "1 unidade → mais unidades"
    bundles.sort((a, b) => a.priceCents - b.priceCents);

    return {
      bundles,
      costUsd: result.cost_usd,
      latencyMs: Date.now() - started,
      source: bundles.length > 0 ? 'gemini' : 'none',
      warnings,
    };
  } catch (err) {
    // Rate limit / Gemini down — falha graciosa
    return {
      bundles: [],
      costUsd: 0,
      latencyMs: Date.now() - started,
      source: 'fallback',
      warnings: [
        `IA indisponível: ${err instanceof Error ? err.message.slice(0, 100) : 'erro'}. Adicione bundles manualmente.`,
      ],
    };
  }
}
