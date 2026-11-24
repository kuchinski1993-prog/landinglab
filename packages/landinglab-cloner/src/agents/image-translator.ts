// Image Translator — Fase 5.C do redesign LandingLab.
//
// Traduz TEXTO EMBUTIDO em imagens de uma landing clonada, preservando layout
// visual (fonte, cor, posicionamento). Pipeline por imagem:
//
//   1. Ler bytes da imagem local (public/cloned/{id}/{hash}.webp)
//   2. Rodar OCR (Tesseract) — se <3 palavras detectadas, SKIP (retorna orig)
//   3. Traduzir texto extraído pelo OCR usando Gemini text
//   4. Chamar Freepik Seedream 4.5 Edit com prompt guiado por OCR original + tradução
//   5. Baixar imagem editada, salvar no MESMO path (sobrescreve original)
//   6. Retornar stats por imagem
//
// UX: chamado pelo endpoint /api/translate-images/stream (SSE). Progress
// reporta cada imagem: skipped / translating / done / failed.
//
// Storage adapter (Fase S.2 — set/2026):
//   translateImages aceita `storage?: StorageAdapter` pra desacoplar I/O do
//   filesystem local. Sem adapter, comportamento legado (readFile/writeFile
//   em `storageRoot + urlPath`). Com adapter, o worker Railway injeta uma
//   implementação Supabase Storage que baixa a imagem do bucket, roda o
//   pipeline em memória, e sobe de volta substituindo o objeto.

import { readFile, writeFile } from 'node:fs/promises';

import { callGemini } from '../providers/gemini-text.js';
import { editImageWithSeedream } from '../providers/freepik.js';
import { editImageWithNanoBanana } from '../providers/gemini-image-edit.js';
import { runOcr, toTesseractLang } from '../providers/tesseract.js';

/**
 * Adapter de storage — abstrai leitura/escrita de assets. Filesystem local no
 * modo legado; Supabase Storage no worker. Ambos operam em Buffers em memória.
 */
export interface StorageAdapter {
  /** Lê o asset apontado por `url` (URL pública ou path filesystem-relative). */
  readAsset(url: string): Promise<Buffer>;
  /** Sobrescreve o asset apontado por `url` com o novo `buffer`. */
  writeAsset(url: string, buffer: Buffer): Promise<void>;
}

export interface ImageTranslatorInput {
  /** Landing ID — usa pra localizar assets em /public/cloned/{id}/. */
  landingId: string;
  /** Prefix público — /cloned quando servido pelo Next public folder. */
  publicPathPrefix: string;
  /** URLs de imagens (locais ou Supabase Storage) pra processar. */
  imageUrls: string[];
  /** Storage root filesystem (apps/backoffice/public/cloned normalmente). */
  storageRoot: string;
  /**
   * Adapter opcional. Se omitido, usa filesystem via
   * `readFile/writeFile(storageRoot + relPath)` — comportamento legado.
   * O worker Railway injeta um adapter Supabase pra rodar em prod.
   */
  storage?: StorageAdapter;
  sourceLanguage: string; // ex: 'ja', 'en', 'auto'
  targetLanguage: string; // ex: 'it', 'de', 'pt-BR'
  /**
   * Threshold mínimo de palavras detectadas pra considerar imagem
   * "com texto" (evita chamar Seedream em fotos de produto sem texto).
   * Default: 3.
   */
  minWordsThreshold?: number;
  /**
   * Threshold mínimo de confidence do OCR (0-100) pra considerar detecção
   * confiável. Abaixo disso a imagem é pulada. Default: 40.
   */
  minOcrConfidence?: number;
  /** Callback de progresso — invocado por imagem. */
  onProgress?: (event: ImageTranslatorProgressEvent) => void;
  /**
   * URL base pública do storage — Seedream precisa fetchar imagem por HTTP
   * (não aceita filesystem paths). Ex: 'http://localhost:3000' + '/cloned/...'.
   */
  publicBaseUrl: string;
  /**
   * Sinal opcional para abortar o processamento entre iterações do loop de
   * imagens. Útil quando o cliente SSE desconecta (aba fechada) e não faz
   * sentido continuar gastando quota de API (Gemini, Seedream) em resultado
   * que ninguém vai consumir. Default: nunca aborta.
   *
   * Semântica: checagem cooperativa ENTRE iterações — nunca cancela uma
   * chamada HTTP em andamento (não passamos o signal para providers).
   */
  signal?: AbortSignal;
  /**
   * Substituição de marca ANTES de mandar pro Seedream (Fase Q). Ex:
   *   { brandFrom: 'Cayenne Max', brandTo: 'Vigorex' }
   * Aplicado case-insensitive no texto OCR + texto traduzido, garantindo que
   * a imagem regenerada tenha "Vigorex" onde antes tinha "Cayenne Max".
   */
  brandFrom?: string | null;
  brandTo?: string | null;
  /**
   * Descrição da demografia alvo pra Seedream adaptar rostos (Fase R). Ex:
   *   "Italian adults 40-55 years, mediterranean features, warm skin tone"
   * Se preenchido, adiciona ao prompt Seedream instrução de trocar
   * rostos preservando pose, iluminação, composição. Se null/vazio, Seedream
   * mantém rostos originais (comportamento Fase Q). Recomendado ser bem
   * descritivo (idade, etnia, features) pra minimizar uncanny valley.
   */
  targetDemographic?: string | null;
}

export type ImageTranslatorProgressEvent =
  | { phase: 'start'; total: number }
  | { phase: 'image:start'; index: number; total: number; localPath: string }
  | {
      phase: 'image:ocr:done';
      index: number;
      wordCount: number;
      text: string;
      confidence: number;
    }
  | { phase: 'image:skipped'; index: number; reason: string }
  | { phase: 'image:translating' | 'image:generating' | 'image:downloading'; index: number }
  | {
      phase: 'image:retrying';
      index: number;
      attempt: number;
      reason: string;
    }
  | {
      phase: 'image:done';
      index: number;
      costUsd: number;
      latencyMs: number;
    }
  | { phase: 'image:failed'; index: number; error: string }
  | { phase: 'aborted'; reason: 'client_disconnected' | 'external_abort'; processedCount: number }
  | {
      phase: 'complete';
      translated: number;
      skipped: number;
      failed: number;
      totalCostUsd: number;
      totalLatencyMs: number;
    };

export interface ImageTranslatorResult {
  translated: number;
  skipped: number;
  failed: number;
  totalCostUsd: number;
  totalLatencyMs: number;
  /** True quando o loop foi interrompido via `input.signal.aborted`. Imagens
   * não processadas NÃO aparecem em `perImage`. Callers que veem `aborted:true`
   * devem tratar o resultado como PARCIAL — não persistir estado final. */
  aborted?: boolean;
  perImage: Array<{
    url: string;
    status: 'translated' | 'skipped' | 'failed';
    wordCount?: number;
    error?: string;
    costUsd?: number;
  }>;
}

function safeEmit(
  cb: ImageTranslatorInput['onProgress'],
  event: ImageTranslatorProgressEvent,
): void {
  if (!cb) return;
  try {
    cb(event);
  } catch {
    // silencia — SSE pode ter desconectado
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Retry helper — exponential backoff + jitter para chamadas HTTP transientes.
// Só re-tenta em 429/5xx/network glitches. NÃO re-tenta em 4xx client errors
// (auth, bad request, not found) que são deterministicos.
// ─────────────────────────────────────────────────────────────────────────

// Classifica se um erro veio de um problema transitório (rate-limit, servidor
// caindo, TCP flap) e vale a pena re-tentar. Match por substring pq fetch
// nativo/undici cospe formatos variados.
function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code ?? '';
  const cause = (err as { cause?: { code?: string } } | null)?.cause?.code ?? '';

  // Network / TCP errors
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return true;
  }
  if (
    cause === 'ECONNRESET' ||
    cause === 'ETIMEDOUT' ||
    cause === 'ECONNREFUSED' ||
    cause === 'UND_ERR_SOCKET'
  ) {
    return true;
  }

  // fetch nativo em Node às vezes só joga "fetch failed" com cause aninhado.
  if (/fetch failed/i.test(msg)) return true;
  if (/network|socket hang up|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg)) return true;

  // HTTP transient
  if (/HTTP 429\b|\b429\b|rate.?limit/i.test(msg)) return true;
  if (/HTTP 5\d\d\b/i.test(msg)) return true; // 500-599
  if (/HTTP 503\b|overloaded|unavailable/i.test(msg)) return true;

  // AbortError vindo de timeout local também é retriable (nova tentativa pode
  // pegar rede melhor).
  if (err instanceof Error && err.name === 'AbortError') return true;
  if (/timeout|timed out/i.test(msg)) return true;

  return false;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    baseDelayMs?: number;
    onAttempt?: (attempt: number, err: unknown) => void;
  } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Última tentativa ou erro não-transiente → propaga.
      if (attempt === maxAttempts || !isTransientError(err)) {
        throw err;
      }
      // Backoff exp com jitter: base * 2^(attempt-1) + rand(0-500ms)
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
      opts.onAttempt?.(attempt, err);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Inalcançável (loop sempre retorna ou throw), mas TS precisa.
  throw lastErr ?? new Error('withRetry exhausted');
}

/**
 * Traduz texto extraído por OCR usando Gemini Flash (mesmo padrão da Fase 5.B).
 * Batch de 1 string por chamada — simples e evita colisões de tradução.
 */
async function translateText(
  text: string,
  sourceLang: string,
  targetLang: string,
  protectedTerms: string[] = [],
): Promise<{ translated: string; costUsd: number }> {
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
    auto: 'auto-detect source',
  };
  const sourceName = langNames[sourceLang] ?? sourceLang;
  const targetName = langNames[targetLang] ?? targetLang;

  const protectedInstruction =
    protectedTerms.length > 0
      ? ` The following are proper nouns (brand names, product names) and MUST appear UNCHANGED in the output — do not translate, transliterate or adapt them: ${protectedTerms.map((t) => `"${t}"`).join(', ')}.`
      : '';

  const res = await callGemini({
    system:
      `You are a professional marketing translator. Translate the following text from ${sourceName} to ${targetName}. ` +
      'Preserve tone, brand voice, and character count when possible.' +
      protectedInstruction +
      ' Return ONLY the translated text — no quotes, no explanations, no prefixes.',
    user: text,
    jsonMode: false,
    temperature: 0.3,
    maxTokens: 512,
  });
  return { translated: res.content.trim(), costUsd: res.cost_usd };
}

/**
 * Converte URL local do storage pra path filesystem absoluto.
 * Ex: '/cloned/abc-123/xyz.webp' + '/public/cloned' →
 *     '/apps/backoffice/public/cloned/abc-123/xyz.webp'
 */
/**
 * Extrai termos que NÃO devem ser traduzidos (proper nouns) do contexto:
 * - Nome da marca origem (brandFrom, ex: "BePurex")
 * - Nome da marca nova (brandTo, se houver — pra brand-swap manter novo termo)
 * - Palavras all-caps de >= 4 chars encontradas no OCR (ex: "CAYENNE", "MAX",
 *   "PEPPER", "SOFTGELS" — identificadores de produto que Shopify usa em maiúscula)
 *
 * Deduplica case-insensitive. Retorna array vazio se não achou nada.
 *
 * Sem essa proteção o Seedream traduz nomes de produto ("CAYENNE MAX" →
 * "CAYENNA M" em italiano) porque interpreta como palavras comuns.
 */
function extractProtectedTerms(
  brandFrom: string | null | undefined,
  brandTo: string | null | undefined,
  ocrText: string,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const add = (t: string): void => {
    const trimmed = t.trim();
    if (trimmed.length < 3) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(trimmed);
  };
  if (brandFrom) add(brandFrom);
  if (brandTo) add(brandTo);
  // Detecta all-caps identifiers >= 4 chars no OCR (nomes de produto Shopify)
  // Aceita letras, números, hífen, apóstrofo. Ignora palavras comuns em
  // caps que não são identificadores (ex: NEW, THE, AND, GET, BUY, FREE).
  const COMMON_CAPS = new Set([
    'NEW', 'THE', 'AND', 'FOR', 'BUY', 'GET', 'FREE', 'OFF', 'ONLY',
    'SHOP', 'SALE', 'YES', 'NO', 'WITH', 'FROM', 'YOUR', 'OUR', 'HOW',
    'WHY', 'WHAT', 'WHEN', 'WHERE', 'ADD', 'SAVE', 'JOIN', 'HELP',
    'NEXT', 'BACK', 'MORE', 'ALL', 'BEST',
  ]);
  const capsRe = /\b[A-Z][A-Z0-9\-']{3,}\b/g;
  let m: RegExpExecArray | null;
  while ((m = capsRe.exec(ocrText)) !== null) {
    if (!COMMON_CAPS.has(m[0])) add(m[0]);
  }
  return result;
}

function urlToFsPath(url: string, publicPathPrefix: string, storageRoot: string): string {
  // Remove prefix (/cloned) da URL → sobra /{landingId}/{hash}.ext
  const prefix = publicPathPrefix.replace(/\/$/, '');
  const rel = url.startsWith(prefix) ? url.slice(prefix.length) : url;
  return storageRoot.replace(/\/$/, '') + rel;
}

/**
 * Storage adapter default — filesystem local via readFile/writeFile.
 * Mantém compat com o SSE endpoint antigo (public/cloned em dev).
 */
function filesystemStorage(storageRoot: string, publicPathPrefix: string): StorageAdapter {
  return {
    readAsset: async (url) => {
      const path = urlToFsPath(url, publicPathPrefix, storageRoot);
      return readFile(path);
    },
    writeAsset: async (url, buffer) => {
      const path = urlToFsPath(url, publicPathPrefix, storageRoot);
      await writeFile(path, buffer);
    },
  };
}

export async function translateImages(
  input: ImageTranslatorInput,
): Promise<ImageTranslatorResult> {
  const {
    imageUrls,
    storageRoot,
    publicPathPrefix,
    publicBaseUrl,
    sourceLanguage,
    targetLanguage,
    minWordsThreshold = 3,
    minOcrConfidence = 40,
    onProgress,
    signal,
  } = input;
  const storage = input.storage ?? filesystemStorage(storageRoot, publicPathPrefix);

  const started = Date.now();
  safeEmit(onProgress, { phase: 'start', total: imageUrls.length });

  const perImage: ImageTranslatorResult['perImage'] = [];
  let totalCost = 0;
  let translatedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let aborted = false;

  const tesseractLang = toTesseractLang(sourceLanguage);

  for (let i = 0; i < imageUrls.length; i++) {
    // Checagem cooperativa de aborto ANTES de iniciar nova imagem.
    // Não interrompe operação em andamento — apenas evita gastar API na próxima.
    if (signal?.aborted) {
      aborted = true;
      safeEmit(onProgress, {
        phase: 'aborted',
        reason: 'client_disconnected',
        processedCount: i,
      });
      break;
    }
    const url = imageUrls[i]!;
    safeEmit(onProgress, { phase: 'image:start', index: i, total: imageUrls.length, localPath: url });

    let buffer: Buffer;
    try {
      buffer = await storage.readAsset(url);
    } catch (err) {
      failedCount++;
      const msg = err instanceof Error ? err.message : String(err);
      perImage.push({ url, status: 'failed', error: `read failed: ${msg}` });
      safeEmit(onProgress, { phase: 'image:failed', index: i, error: msg });
      continue;
    }

    // OCR — só considera imagem se tem texto suficiente.
    const ocr = await runOcr(buffer, tesseractLang);
    safeEmit(onProgress, {
      phase: 'image:ocr:done',
      index: i,
      wordCount: ocr.wordCount,
      text: ocr.text.slice(0, 200),
      confidence: ocr.confidence,
    });
    if (ocr.wordCount < minWordsThreshold || ocr.confidence < minOcrConfidence) {
      skippedCount++;
      perImage.push({
        url,
        status: 'skipped',
        wordCount: ocr.wordCount,
      });
      safeEmit(onProgress, {
        phase: 'image:skipped',
        index: i,
        reason: `wordCount=${ocr.wordCount} confidence=${ocr.confidence}`,
      });
      continue;
    }

    // Fase S.2.1 — extrai termos protegidos (marca + nome de produto)
    // ANTES da tradução pra passar como whitelist pro Gemini. Assim o texto
    // que sai da tradução já vem com "CAYENNE MAX" preservado.
    const protectedTermsForTranslation = extractProtectedTerms(
      input.brandFrom,
      input.brandTo,
      ocr.text,
    );

    // Traduz texto extraído pelo OCR.
    let translatedText: string;
    let translateCost = 0;
    try {
      safeEmit(onProgress, { phase: 'image:translating', index: i });
      const t = await withRetry(
        () => translateText(ocr.text, sourceLanguage, targetLanguage, protectedTermsForTranslation),
        {
          maxAttempts: 2,
          baseDelayMs: 1000,
          onAttempt: (attempt, err) => {
            const reason = err instanceof Error ? err.message : String(err);
            safeEmit(onProgress, {
              phase: 'image:retrying',
              index: i,
              attempt,
              reason: `translate: ${reason.slice(0, 200)}`,
            });
          },
        },
      );
      translatedText = t.translated;
      translateCost = t.costUsd;
    } catch (err) {
      failedCount++;
      const msg = err instanceof Error ? err.message : String(err);
      const errType = err instanceof Error ? err.name : 'UnknownError';
      perImage.push({ url, status: 'failed', error: `translate failed [${errType}]: ${msg}` });
      safeEmit(onProgress, {
        phase: 'image:failed',
        index: i,
        error: `translate [${errType}]: ${msg}`,
      });
      continue;
    }

    // Fase Q — brand swap: aplica no texto TRADUZIDO antes de mandar pro Seedream.
    // Assim imagem regenerada vem com "Vigorex" onde antes tinha "Cayenne Max".
    let finalText = translatedText;
    if (input.brandFrom && input.brandTo && input.brandFrom.trim() && input.brandTo.trim()) {
      const from = input.brandFrom.trim();
      const to = input.brandTo.trim();
      const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escaped, 'gi');
      finalText = translatedText.replace(pattern, to);
    }

    // Reutiliza os termos protegidos já extraídos pra tradução do Gemini,
    // agora pra passar no prompt do Seedream (defense in depth).
    const protectedTerms = protectedTermsForTranslation;

    // Chama Seedream com prompt guiado por OCR original + tradução (com brand swap).
    safeEmit(onProgress, { phase: 'image:generating', index: i });
    // Se url já é absoluta (worker Railway passa URL Supabase completa), usa direto.
    // Caso contrário (modo legado dev com filesystem local), prepende publicBaseUrl.
    const publicImageUrl = /^https?:\/\//i.test(url)
      ? url
      : `${publicBaseUrl.replace(/\/$/, '')}${url}`;
    const brandInstruction =
      input.brandFrom && input.brandTo && input.brandFrom.trim() && input.brandTo.trim()
        ? `\n\nIMPORTANT — BRAND SUBSTITUTION: any occurrence of "${input.brandFrom}" (case-insensitive) MUST be replaced by "${input.brandTo}" in the rendered image. This is a rebranding operation.`
        : '';

    // Fase S.2.1 — proteção de termos que NUNCA devem ser traduzidos:
    // nome da marca (BePurex), nome do produto (CAYENNE MAX), all-caps
    // identifiers de mais de 3 chars (CAYENNE, PEPPER, MAX). Sem essa
    // instrução, Seedream traduz "CAYENNE MAX" → "CAYENNA M" (italiano).
    //
    // Reforço extremo: soletra cada termo caractere por caractere e repete 2x.
    // Modelos de imagem escorregam em texto grande e colorido; a redundância
    // ajuda o modelo a lembrar de manter o token literal.
    const protectedInstruction =
      protectedTerms.length > 0
        ? `\n\n═══════════════════════════════════════════════════════
🚨 ABSOLUTE RULE — PRODUCT & BRAND NAMES (READ THIS FIRST):
═══════════════════════════════════════════════════════
The following words are PRODUCT/BRAND NAMES (proper nouns). They are NOT ${targetLanguage} words, they are NOT ${sourceLanguage} words — they are TRADEMARKED IDENTIFIERS that must appear PIXEL-PERFECT identical in the output image:

${protectedTerms.map((t) => `  • "${t}"  (letters: ${t.split('').join('-')})`).join('\n')}

RULES for these terms — NO EXCEPTIONS:
1. DO NOT translate them.
2. DO NOT transliterate them (no changing spelling to sound Italian/Spanish/etc).
3. DO NOT adapt/localize them.
4. DO NOT truncate or shorten them.
5. DO NOT change even a single letter.
6. If a term is in ALL CAPS in the original, keep it in ALL CAPS.
7. If the term is prominently displayed (large font, bold, colored), the risk of accidental translation is HIGHER — pay EXTRA attention to preserve exact spelling.

Example of what NOT to do: "CAYENNE MAX" → "CAYENNA MASSIMA" ❌ (this would be wrong — CAYENNE is a product name, not a translatable word).
Example of correct behavior: "CAYENNE MAX" → "CAYENNE MAX" ✅ (unchanged, character-perfect).
═══════════════════════════════════════════════════════`
        : '';

    // Fase R — adaptação demografia. Prompt engineering caprichado pra
    // minimizar uncanny valley: enfatizar preservação de pose/composição/luz.
    const demographicInstruction =
      input.targetDemographic && input.targetDemographic.trim()
        ? `\n\nIMPORTANT — DEMOGRAPHIC ADAPTATION:
If this image contains one or more human faces or bodies, replace them with people matching this description: "${input.targetDemographic.trim()}".
STRICT PRESERVATION REQUIREMENTS (do not deviate):
- Keep the EXACT same pose, body position, gesture, and gaze direction.
- Keep the EXACT same facial expression (smile, look, emotion intensity).
- Keep the EXACT same clothing style, colors, and outfit.
- Keep the EXACT same lighting, shadow direction, and time of day.
- Keep the EXACT same background, framing, camera angle, and composition.
- Keep the EXACT same photo style (professional/casual/lifestyle) and quality.
- Match skin tone naturally to the demographic without unrealistic saturation.
- Ensure realistic anatomy: two eyes symmetric, correct proportions, natural hands.
If NO people are visible in the image, IGNORE this instruction entirely and just perform the text replacement above.`
        : '';

    // Ordem CRÍTICA do prompt:
    // 1. Protected names PRIMEIRO (modelo dá mais peso ao topo)
    // 2. Task description
    // 3. Original + translated text
    // 4. Brand swap + demographic (opcionais)
    const prompt =
      `${protectedInstruction}\n\n` +
      `Edit this marketing image: replace ALL visible text (currently in ${sourceLanguage}) ` +
      `with the ${targetLanguage} translation below. Preserve exact font style, colors, ` +
      `positioning, background, and layout. Do not change any visual element besides text` +
      (demographicInstruction ? ` (except human faces/bodies per demographic instruction below)` : '') +
      `.\n\nOriginal text:\n"${ocr.text.slice(0, 500)}"\n\n` +
      `Translated text to render:\n"${finalText.slice(0, 500)}"${brandInstruction}${demographicInstruction}`;

    // Fase S.2.3 (set/2026) — REVERTIDO: Freepik Seedream é o default.
    // Motivo: usuário paga Freepik separado; usar Gemini Nano Banana (que
    // também não teve qualidade melhor pra proper nouns) só duplicava o custo.
    // Gemini deve ser usado APENAS pra tradução de texto (Gemini Flash), NÃO
    // pra edição de imagem (Seedream).
    //
    // Opt-in Nano Banana via env USE_NANO_BANANA=1 (deprecated path, mantido
    // pra experiments).
    const useNanoBanana = process.env['USE_NANO_BANANA'] === '1';
    const useSeedreamFallback = !useNanoBanana; // default: Seedream (Freepik)

    let editResult: {
      buffer: Buffer | null;
      costUsd: number;
      latencyMs: number;
      status: 'COMPLETED' | 'FAILED';
      error?: string;
    };

    try {
      if (useSeedreamFallback) {
        // Legacy path — mantido pra debug
        const r = await withRetry(
          async () => {
            const s = await editImageWithSeedream({ imageUrl: publicImageUrl, prompt });
            if (s.status !== 'COMPLETED' && isTransientError(new Error(s.error ?? s.status))) {
              throw new Error(s.error ?? `seedream ${s.status}`);
            }
            return s;
          },
          { maxAttempts: 2, baseDelayMs: 1000 },
        );
        if (r.status !== 'COMPLETED') {
          editResult = { buffer: null, costUsd: r.costUsd, latencyMs: r.latencyMs, status: 'FAILED', error: r.error };
        } else {
          // Baixa imagem gerada (Seedream retorna URL, não buffer)
          const genRes = await fetch(r.imageUrl);
          if (!genRes.ok) throw new Error(`seedream download HTTP ${genRes.status}`);
          const buf = Buffer.from(await genRes.arrayBuffer());
          editResult = { buffer: buf, costUsd: r.costUsd, latencyMs: r.latencyMs, status: 'COMPLETED' };
        }
      } else {
        // Path novo — Nano Banana retorna buffer inline (sem polling, sync)
        const r = await withRetry(
          async () => {
            const nb = await editImageWithNanoBanana({ imageUrl: publicImageUrl, prompt });
            if (nb.status !== 'COMPLETED' && isTransientError(new Error(nb.error ?? nb.status))) {
              throw new Error(nb.error ?? `nano-banana ${nb.status}`);
            }
            return nb;
          },
          {
            maxAttempts: 2,
            baseDelayMs: 1000,
            onAttempt: (attempt, err) => {
              const reason = err instanceof Error ? err.message : String(err);
              safeEmit(onProgress, {
                phase: 'image:retrying',
                index: i,
                attempt,
                reason: `nano-banana: ${reason.slice(0, 200)}`,
              });
            },
          },
        );
        editResult = {
          buffer: r.imageBuffer,
          costUsd: r.costUsd,
          latencyMs: r.latencyMs,
          status: r.status,
          error: r.error,
        };
      }
    } catch (err) {
      const errType = err instanceof Error ? err.name : 'UnknownError';
      const errMsg = err instanceof Error ? err.message : String(err);
      const perImageCost = translateCost;
      failedCount++;
      perImage.push({
        url,
        status: 'failed',
        error: `image-edit failed [${errType}]: ${errMsg}`,
        costUsd: perImageCost,
        wordCount: ocr.wordCount,
      });
      totalCost += perImageCost;
      safeEmit(onProgress, {
        phase: 'image:failed',
        index: i,
        error: `image-edit [${errType}]: ${errMsg}`,
      });
      continue;
    }

    const perImageCost = translateCost + editResult.costUsd;

    if (editResult.status !== 'COMPLETED' || !editResult.buffer) {
      failedCount++;
      perImage.push({
        url,
        status: 'failed',
        error: editResult.error ?? 'image-edit failed',
        costUsd: perImageCost,
        wordCount: ocr.wordCount,
      });
      totalCost += perImageCost;
      safeEmit(onProgress, {
        phase: 'image:failed',
        index: i,
        error: editResult.error ?? 'image-edit failed',
      });
      continue;
    }

    // Salva imagem gerada
    safeEmit(onProgress, { phase: 'image:downloading', index: i });
    try {
      await storage.writeAsset(url, editResult.buffer);
    } catch (err) {
      failedCount++;
      const msg = err instanceof Error ? err.message : String(err);
      const errType = err instanceof Error ? err.name : 'UnknownError';
      perImage.push({
        url,
        status: 'failed',
        error: `write failed [${errType}]: ${msg}`,
        costUsd: perImageCost,
      });
      totalCost += perImageCost;
      safeEmit(onProgress, {
        phase: 'image:failed',
        index: i,
        error: `write [${errType}]: ${msg}`,
      });
      continue;
    }

    translatedCount++;
    totalCost += perImageCost;
    perImage.push({
      url,
      status: 'translated',
      wordCount: ocr.wordCount,
      costUsd: perImageCost,
    });
    safeEmit(onProgress, {
      phase: 'image:done',
      index: i,
      costUsd: perImageCost,
      latencyMs: editResult.latencyMs,
    });
  }

  const totalLatency = Date.now() - started;
  // Só emite 'complete' se o loop terminou naturalmente. Quando abortado, o
  // evento 'aborted' já foi emitido dentro do loop — não sobrescrever com
  // números "completos" que na verdade são parciais.
  if (!aborted) {
    safeEmit(onProgress, {
      phase: 'complete',
      translated: translatedCount,
      skipped: skippedCount,
      failed: failedCount,
      totalCostUsd: totalCost,
      totalLatencyMs: totalLatency,
    });
  }

  return {
    translated: translatedCount,
    skipped: skippedCount,
    failed: failedCount,
    totalCostUsd: totalCost,
    totalLatencyMs: totalLatency,
    perImage,
    ...(aborted ? { aborted: true } : {}),
  };
}
