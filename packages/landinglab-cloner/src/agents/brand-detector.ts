// Brand detector — Fatia 1 do Wizard V2 (set/2026)
//
// Detecta a marca origem de uma landing clonada pra pré-preencher wizard step
// "Marca". Se usuário depois escolher "Substituir por: NOVA_MARCA", os
// processors de tradução (texto e imagens) usam `brand_from` detectado
// automaticamente aqui em vez do usuário digitar.
//
// Estratégia em cascata (barata → cara):
//   1. Extrai <title>, <meta og:site_name>, JSON-LD organization.name
//      → se algum bater com um padrão de "1 nome próprio", usa direto (grátis)
//   2. Se cascata 1 falhar (títulos vagos tipo "Buy Now — Best Deal"),
//      chama Gemini Flash com contexto do HTML → resposta 1-3 palavras
//      → custo ~$0.0002 por detecção
//   3. Se Gemini falhar (rate limit / erro), retorna null (não bloqueia clone)
//
// Nunca lança exceção — brand detection é oportunista.

import * as cheerio from 'cheerio';

import { callGemini } from '../providers/gemini-text.js';

export interface BrandDetectionResult {
  /** Marca detectada. null quando cascata falha (não bloqueia). */
  brand: string | null;
  /** Como foi detectada: pra debug + confidence UI. */
  source: 'title' | 'og_site_name' | 'json_ld' | 'gemini' | 'none';
  /** 0-100 heurística. UI mostra badge de confiança. */
  confidence: number;
  /** Custo em USD (0 pra cascata 1, ~0.0002 pra Gemini). */
  costUsd: number;
  latencyMs: number;
}

/**
 * Extrai candidato de marca via metadata estático (zero custo).
 * Preferência: og:site_name > json-ld org name > title primeiro token.
 */
function detectFromMetadata(html: string): { brand: string; source: BrandDetectionResult['source']; confidence: number } | null {
  const $ = cheerio.load(html);

  // og:site_name é o mais confiável (site autor declarou marca)
  const ogSiteName = $('meta[property="og:site_name"]').attr('content')?.trim();
  if (ogSiteName && ogSiteName.length > 1 && ogSiteName.length < 60) {
    return { brand: ogSiteName, source: 'og_site_name', confidence: 90 };
  }

  // JSON-LD Organization/Brand name
  const jsonLdScripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < jsonLdScripts.length; i++) {
    const el = jsonLdScripts.eq(i);
    const raw = el.text().trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        // Organization/Brand top-level
        if (item?.['@type'] === 'Organization' || item?.['@type'] === 'Brand') {
          const name = typeof item.name === 'string' ? item.name.trim() : null;
          if (name && name.length > 1) {
            return { brand: name, source: 'json_ld', confidence: 85 };
          }
        }
        // Product embedded brand.name
        if (item?.['@type'] === 'Product' && item.brand) {
          const brand = item.brand;
          const name =
            typeof brand === 'string'
              ? brand.trim()
              : typeof brand?.name === 'string'
                ? brand.name.trim()
                : null;
          if (name && name.length > 1) {
            return { brand: name, source: 'json_ld', confidence: 80 };
          }
        }
      }
    } catch {
      // JSON malformado — ignora
    }
  }

  // Title: pega segmento antes de "—" ou "|" (padrão comum: "Nome | Descrição").
  const titleRaw = $('title').first().text().trim();
  if (titleRaw && titleRaw.length > 1 && titleRaw.length < 80) {
    // "Vigoraxi カイエンペッパー | VigorAxi" → pega "VigorAxi" (última parte após |)
    // "BePurex Softgels — Health Wealth" → pega "BePurex Softgels" (primeira parte)
    const separators = /\s+[—–|·]\s+/;
    if (separators.test(titleRaw)) {
      const parts = titleRaw.split(separators);
      // Prefere última parte quando parece nome próprio (curta, capitalizada)
      const last = parts[parts.length - 1]?.trim();
      const first = parts[0]?.trim();
      if (last && last.length >= 3 && last.length < 30 && /^[A-Z][a-zA-Z]/.test(last)) {
        return { brand: last, source: 'title', confidence: 60 };
      }
      if (first && first.length >= 3 && first.length < 40 && /^[A-Z][a-zA-Z]/.test(first)) {
        return { brand: first, source: 'title', confidence: 50 };
      }
    }
    // Título sem separador — só usa se é curto e capitalizado
    if (titleRaw.length < 30 && /^[A-Z][a-zA-Z]/.test(titleRaw)) {
      return { brand: titleRaw, source: 'title', confidence: 40 };
    }
  }

  return null;
}

/**
 * Fallback via Gemini quando metadata não deu nome confiável.
 * Prompt curto → 1 request → ~200 tokens IO → ~$0.0002.
 */
async function detectViaGemini(html: string): Promise<{ brand: string | null; costUsd: number }> {
  // Reduz HTML: só primeiro 5KB (head + primeiros elementos body).
  const truncated = html.slice(0, 5000);
  const system = `You are a brand identification assistant. Given HTML of a product landing page, you identify the BRAND NAME being sold. You reply ONLY with the brand name (1-3 words). If you cannot identify a clear brand, reply exactly "UNKNOWN". Never add explanations, punctuation, or quotes.`;
  const user = `HTML:\n${truncated}\n\nBrand name:`;

  try {
    const result = await callGemini({
      system,
      user,
      model: 'gemini-3.6-flash',
      maxTokens: 20,
      temperature: 0.1,
    });
    const raw = result.content.trim().replace(/^["']|["']$/g, '');
    if (!raw || raw.toUpperCase() === 'UNKNOWN' || raw.length > 40) {
      return { brand: null, costUsd: result.cost_usd };
    }
    return { brand: raw, costUsd: result.cost_usd };
  } catch {
    // Rate limit / erro Gemini — falha silenciosa (brand detection é oportunista)
    return { brand: null, costUsd: 0 };
  }
}

export async function detectBrand(html: string): Promise<BrandDetectionResult> {
  const started = Date.now();

  // Cascata 1: metadata estático
  const meta = detectFromMetadata(html);
  if (meta && meta.confidence >= 60) {
    return {
      brand: meta.brand,
      source: meta.source,
      confidence: meta.confidence,
      costUsd: 0,
      latencyMs: Date.now() - started,
    };
  }

  // Cascata 2: Gemini fallback
  const gemini = await detectViaGemini(html);
  if (gemini.brand) {
    return {
      brand: gemini.brand,
      source: 'gemini',
      confidence: 75,
      costUsd: gemini.costUsd,
      latencyMs: Date.now() - started,
    };
  }

  // Sem detecção — retorna metadata mesmo com confidence baixa se tiver
  if (meta) {
    return {
      brand: meta.brand,
      source: meta.source,
      confidence: meta.confidence,
      costUsd: gemini.costUsd,
      latencyMs: Date.now() - started,
    };
  }

  return {
    brand: null,
    source: 'none',
    confidence: 0,
    costUsd: gemini.costUsd,
    latencyMs: Date.now() - started,
  };
}
