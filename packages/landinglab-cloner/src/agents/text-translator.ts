// Text Translator — Fase 5.B do redesign.
//
// Traduz TODO texto visível de um HTML clonado (Squad 0 Fase 5.A) pra outro
// idioma, preservando estrutura HTML/CSS/atributos.
//
// Pipeline:
//   1. Parseia HTML com parse5 (mantém fidelidade — parse5 é o parser oficial
//      do WHATWG spec).
//   2. Walk no DOM tree coletando:
//      - Text nodes com conteúdo não-vazio (skip whitespace-only)
//      - Atributos traduzíveis: alt, title, placeholder, aria-label,
//        content (em <meta name="description|keywords|og:*|twitter:*">)
//   3. Skip conteúdo dentro de <script>, <style>, <code>, <pre>, <noscript>.
//   4. Batch em grupos de ~30 strings por chamada Gemini (evita context limit).
//   5. Gemini responde com JSON { "0": "trad1", "1": "trad2", ... } — mapa
//      indexado pra evitar ambiguidade de ordem.
//   6. Substitui inline no AST → serializa de volta.
//
// Custo: ~$0.005 por landing de 3-5 KB de texto (Gemini Flash é barato).

import * as parse5 from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

import { callGemini } from '../providers/gemini-text.js';

// Aliases dos types do parse5 default tree adapter.
type Parse5Node = DefaultTreeAdapterMap['node'];
type Parse5Element = DefaultTreeAdapterMap['element'];
type TextNode = DefaultTreeAdapterMap['textNode'];
type Attribute = { name: string; value: string };

// Tags cujo conteúdo NÃO deve ser traduzido (código, scripts, estilos).
const SKIP_CONTENT_TAGS = new Set([
  'script',
  'style',
  'code',
  'pre',
  'noscript',
  'textarea', // preserva user input
]);

// Atributos textuais traduzíveis em qualquer elemento.
const TRANSLATABLE_ATTRS = new Set([
  'alt',
  'title',
  'placeholder',
  'aria-label',
  'aria-description',
  'aria-placeholder',
]);

// Atributos traduzíveis SOMENTE em <meta> — description, keywords, og:*, twitter:*.
const META_TRANSLATABLE_NAMES = new Set([
  'description',
  'keywords',
  'og:title',
  'og:description',
  'twitter:title',
  'twitter:description',
]);

export interface TranslateInput {
  html: string;
  sourceLanguage: string; // ex: 'ja', 'en', 'auto'
  targetLanguage: string; // ex: 'it', 'de', 'pt-BR'
  /** Batch size — quantas strings por chamada Gemini. Default 30. */
  batchSize?: number;
  /** Tone hint pra Gemini. Default 'marketing/sales copy'. */
  toneHint?: string;
  /**
   * Substituição de marca ANTES da tradução (Fase Q). Ex:
   *   { brandFrom: 'Cayenne Max', brandTo: 'Vigorex' }
   * Aplicado case-insensitive no HTML antes de extrair strings pra IA.
   * Isso garante que a IA veja "Vigorex" no lugar de "Cayenne Max" e traduza
   * naturalmente (sem tentar traduzir o nome próprio).
   */
  brandFrom?: string | null;
  brandTo?: string | null;
  /**
   * Callback opcional chamado após cada batch traduzido. Usado pelo worker
   * pra atualizar translation_progress no DB e permitir barra de progresso
   * incremental na UI (Wizard Step 3). Nunca throw — errors são silenciados
   * pra não abortar tradução.
   *
   * Semântica:
   *   - Chamado UMA vez após cada batch de Gemini completar
   *   - stringsTranslated é cumulativo (soma de todos os batches até agora)
   *   - totalStrings é o total conhecido no início (extractions.length)
   *   - batchIndex/totalBatches ajudam a mostrar "batch 3/16" opcionalmente
   */
  onBatchProgress?: (evt: {
    stringsTranslated: number;
    totalStrings: number;
    batchIndex: number;
    totalBatches: number;
  }) => void;
}

export interface TranslateResult {
  html: string;
  stats: {
    stringsExtracted: number;
    stringsTranslated: number;
    batches: number;
    totalTokensIn: number;
    totalTokensOut: number;
    totalCostUsd: number;
    totalLatencyMs: number;
  };
  errors: string[];
}

/**
 * Extraction pointer — guarda referência ao nó/atributo original pra
 * substituição precisa após tradução.
 */
type Extraction =
  | { type: 'text'; node: TextNode; original: string }
  | {
      type: 'attr';
      element: Parse5Element;
      attrName: string;
      original: string;
    };

function isElement(node: Parse5Node): node is Parse5Element {
  return 'tagName' in node && Array.isArray((node as Parse5Element).attrs);
}

function isTextNode(node: Parse5Node): node is TextNode {
  return node.nodeName === '#text';
}

/**
 * Walk recursivo coletando extractions. Skip subtrees inteiras de tags
 * bloqueadas (script/style/etc).
 */
function collectExtractions(root: Parse5Node, out: Extraction[]): void {
  if (isElement(root) && SKIP_CONTENT_TAGS.has(root.tagName.toLowerCase())) {
    return;
  }

  if (isElement(root)) {
    const tagName = root.tagName.toLowerCase();

    for (const attr of root.attrs) {
      const attrName = attr.name.toLowerCase();
      const value = attr.value;
      if (!value || !value.trim()) continue;

      if (TRANSLATABLE_ATTRS.has(attrName)) {
        out.push({ type: 'attr', element: root, attrName: attr.name, original: value });
        continue;
      }

      // <meta name="description|og:*|..." content="..."> — traduz content.
      if (tagName === 'meta' && attrName === 'content') {
        const nameAttr = root.attrs.find(
          (a: Attribute) => a.name.toLowerCase() === 'name' || a.name.toLowerCase() === 'property',
        );
        if (nameAttr && META_TRANSLATABLE_NAMES.has(nameAttr.value.toLowerCase())) {
          out.push({ type: 'attr', element: root, attrName: attr.name, original: value });
        }
      }
    }
  }

  if (isTextNode(root)) {
    const trimmed = root.value.trim();
    // Skip whitespace-only e strings muito curtas sem letras (números/símbolos).
    if (trimmed.length > 0 && /[\p{L}]/u.test(trimmed)) {
      out.push({ type: 'text', node: root, original: root.value });
    }
    return;
  }

  const children = (root as Parse5Element).childNodes;
  if (Array.isArray(children)) {
    for (const child of children) collectExtractions(child, out);
  }
}

/**
 * Traduz um batch de strings via Gemini. Prompt estruturado com JSON output.
 * Retorna array de traduções na mesma ordem. Se algo falhar, retorna string
 * original naquela posição.
 */
async function translateBatch(
  strings: string[],
  sourceLanguage: string,
  targetLanguage: string,
  toneHint: string,
): Promise<{ translations: string[]; tokensIn: number; tokensOut: number; costUsd: number }> {
  const langNames: Record<string, string> = {
    en: 'English',
    it: 'Italian',
    de: 'German',
    fr: 'French',
    es: 'Spanish',
    ja: 'Japanese',
    zh: 'Chinese',
    'pt-BR': 'Brazilian Portuguese',
    pt: 'Portuguese',
    auto: 'auto-detected source',
  };
  const sourceName = langNames[sourceLanguage] ?? sourceLanguage;
  const targetName = langNames[targetLanguage] ?? targetLanguage;

  const inputJson = JSON.stringify(
    strings.reduce<Record<string, string>>((acc, s, i) => {
      acc[String(i)] = s;
      return acc;
    }, {}),
  );

  const system =
    `You are a professional translator specialized in ${toneHint}. ` +
    `Translate from ${sourceName} to ${targetName}. ` +
    'Rules:\n' +
    '1. Preserve tone, brand voice, emotional intensity — not word-for-word.\n' +
    '2. Preserve HTML entities as-is (never touch &amp; &nbsp; &#39; etc).\n' +
    '3. Preserve numbers, currency symbols, product names, brand names.\n' +
    '4. Preserve emojis and unicode symbols.\n' +
    '5. Keep length roughly similar (avoid making translations 2x longer).\n' +
    '6. Do NOT translate URLs, email addresses, code snippets, phone numbers.\n' +
    '7. Output ONLY the JSON object mapping input keys to translations. Same keys, translated values.';

  const user =
    `Input JSON (each key is an index, each value is a string to translate):\n\n${inputJson}\n\n` +
    `Return the same JSON with values translated to ${targetName}.`;

  const res = await callGemini({
    system,
    user,
    jsonMode: true,
    temperature: 0.3, // baixo pra tradução (não é criativo)
    maxTokens: 8192,
  });

  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(res.content) as Record<string, string>;
  } catch {
    // Se falhar, tenta extrair via regex — Gemini às vezes ignora jsonMode.
    const match = res.content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Gemini returned non-JSON: ${res.content.slice(0, 200)}`);
    parsed = JSON.parse(match[0]) as Record<string, string>;
  }

  const translations = strings.map((orig, i) => {
    const t = parsed[String(i)];
    return typeof t === 'string' && t.trim() ? t : orig;
  });

  return {
    translations,
    tokensIn: res.tokens_in,
    tokensOut: res.tokens_out,
    costUsd: res.cost_usd,
  };
}

export async function translateHtml(input: TranslateInput): Promise<TranslateResult> {
  const started = Date.now();
  const batchSize = input.batchSize ?? 30;
  const toneHint = input.toneHint ?? 'marketing and sales copy (conversion-focused)';
  const errors: string[] = [];

  // Fase Q — brand swap ANTES de parsear/traduzir. Assim a IA vê brandTo
  // desde o começo e traduz naturalmente sem tentar preservar/traduzir o
  // nome próprio da marca original.
  let htmlIn = input.html;
  if (input.brandFrom && input.brandTo && input.brandFrom.trim() && input.brandTo.trim()) {
    const from = input.brandFrom.trim();
    const to = input.brandTo.trim();
    // Escape regex chars pra tratar marca literalmente (ex: nomes com pontos, hífens)
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'gi');
    htmlIn = htmlIn.replace(pattern, to);
  }

  // Parse — usa parseFragment se não temos <html> wrapper, senão parse.
  const isFullDoc = /<html/i.test(htmlIn);
  const document = isFullDoc
    ? parse5.parse(htmlIn)
    : parse5.parseFragment(htmlIn);

  // Coleta todas as extractions.
  const extractions: Extraction[] = [];
  collectExtractions(document, extractions);

  if (extractions.length === 0) {
    return {
      html: input.html,
      stats: {
        stringsExtracted: 0,
        stringsTranslated: 0,
        batches: 0,
        totalTokensIn: 0,
        totalTokensOut: 0,
        totalCostUsd: 0,
        totalLatencyMs: Date.now() - started,
      },
      errors: ['no translatable strings found'],
    };
  }

  // Batches de N.
  const batches: Extraction[][] = [];
  for (let i = 0; i < extractions.length; i += batchSize) {
    batches.push(extractions.slice(i, i + batchSize));
  }

  let totalIn = 0;
  let totalOut = 0;
  let totalCost = 0;
  let translatedCount = 0;

  // Sequential (evita rate-limit + mantém ordem previsível). Se precisar
  // paralelizar depois, ajusta pra Promise.allSettled com concurrency=3.
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi]!;
    const strings = batch.map((e) => e.original);
    try {
      const { translations, tokensIn, tokensOut, costUsd } = await translateBatch(
        strings,
        input.sourceLanguage,
        input.targetLanguage,
        toneHint,
      );
      totalIn += tokensIn;
      totalOut += tokensOut;
      totalCost += costUsd;

      // Aplica traduções nos AST nodes.
      for (let i = 0; i < batch.length; i++) {
        const extraction = batch[i]!;
        const translated = translations[i] ?? extraction.original;
        if (translated === extraction.original) continue;

        if (extraction.type === 'text') {
          extraction.node.value = translated;
        } else {
          const attr = extraction.element.attrs.find((a: Attribute) => a.name === extraction.attrName);
          if (attr) attr.value = translated;
        }
        translatedCount++;
      }
    } catch (err) {
      errors.push(`batch ${bi + 1}/${batches.length}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Emit progress após cada batch (sucesso OU falha — barra continua avançando).
    // stringsTranslated conta traduções BEM-SUCEDIDAS, mas usamos progresso baseado
    // em batches processados pra que barra suba mesmo se algum batch falhar.
    if (input.onBatchProgress) {
      try {
        const processedStrings = Math.min((bi + 1) * batchSize, extractions.length);
        input.onBatchProgress({
          stringsTranslated: processedStrings,
          totalStrings: extractions.length,
          batchIndex: bi + 1,
          totalBatches: batches.length,
        });
      } catch {
        // silêncio — callback nunca aborta tradução
      }
    }
  }

  const serialized = isFullDoc
    ? parse5.serialize(document)
    : parse5.serialize(document);

  return {
    html: serialized,
    stats: {
      stringsExtracted: extractions.length,
      stringsTranslated: translatedCount,
      batches: batches.length,
      totalTokensIn: totalIn,
      totalTokensOut: totalOut,
      totalCostUsd: totalCost,
      totalLatencyMs: Date.now() - started,
    },
    errors,
  };
}
