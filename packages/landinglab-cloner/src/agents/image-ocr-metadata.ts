// Image OCR metadata — Fatia 2 do Wizard V2 (set/2026)
//
// Roda OCR em todas as imagens da landing DURANTE o clone (não translate),
// pra popular metadata usada pela etapa "Seleção de imagens" do Wizard V2.
//
// Uso: operador vê grid de imagens + filtros ("todas com texto", "só com marca origem",
// "só hero"). Sem OCR pré-computado, cada abertura do wizard rodaria OCR de 300 imagens.
//
// Custo: zero (tesseract.js roda local, sem API). Tempo: ~500ms/imagem
// = 60s pra 100 imagens em paralelo (throttled a 4 concorrentes pra não estourar CPU).
//
// Sempre non-blocking: se falhar em uma imagem, continua. Retorna metadata com
// hasText=false pra imagens que falharam.

import sharp from 'sharp';

import { runOcr, toTesseractLang } from '../providers/tesseract.js';

export interface ImageOcrMetadata {
  url: string;
  hasText: boolean;
  hasBrandOrigin: boolean;
  wordCount: number;
  /** Trecho do texto detectado (max 200 chars) — pra UI mostrar hint. */
  ocrTextPreview: string;
  ocrConfidence: number;
  /** Bytes da imagem — UI usa pra ordenar (grandes vem primeiro tipicamente). */
  bytes: number;
  /** null se OCR falhou (mantém no metadata pra UI mostrar warning). */
  error?: string;
}

export interface ExtractImageMetadataInput {
  /** URLs absolutas das imagens (Supabase Storage tipicamente). */
  imageUrls: string[];
  /** Marca origem detectada (via brand-detector). null = skip check hasBrandOrigin. */
  brandOrigin: string | null;
  /** Idioma detectado da landing pra OCR (ex: 'ja', 'en'). Default 'en'. */
  sourceLanguage?: string;
  /** Threshold pra hasText (default 3 palavras). */
  minWords?: number;
  /** Threshold pra confidence (default 20 — permissivo pra jpn/ara scripts). */
  minConfidence?: number;
  /** Concorrência (default 4 — CPU-bound). */
  concurrency?: number;
  /** Progress callback opcional. */
  onProgress?: (done: number, total: number) => void;
}

async function fetchImageBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; LandingLabCloner/1.0)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Roda OCR em uma imagem individual e retorna metadata rica.
 * Nunca lança — retorna hasText=false + error em caso de falha.
 */
async function extractOne(
  url: string,
  brandOrigin: string | null,
  tesseractLang: string,
  minWords: number,
  minConfidence: number,
): Promise<ImageOcrMetadata> {
  let buffer: Buffer;
  try {
    buffer = await fetchImageBuffer(url);
  } catch (err) {
    return {
      url,
      hasText: false,
      hasBrandOrigin: false,
      wordCount: 0,
      ocrTextPreview: '',
      ocrConfidence: 0,
      bytes: 0,
      error: err instanceof Error ? `fetch: ${err.message}` : 'fetch failed',
    };
  }

  const bytes = buffer.length;

  // Sharp pré-processa (fix bug tesseract WebP + normaliza formatos)
  let ocrInput: Buffer = buffer;
  try {
    const isWebp =
      buffer.length >= 12 &&
      buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
      buffer.slice(8, 12).toString('ascii') === 'WEBP';
    if (isWebp) {
      ocrInput = await sharp(buffer, { failOn: 'none' }).png({ compressionLevel: 3 }).toBuffer();
    }
  } catch (err) {
    return {
      url,
      hasText: false,
      hasBrandOrigin: false,
      wordCount: 0,
      ocrTextPreview: '',
      ocrConfidence: 0,
      bytes,
      error: err instanceof Error ? `sharp: ${err.message}` : 'sharp failed',
    };
  }

  const ocr = await runOcr(ocrInput, tesseractLang);
  const hasText = ocr.wordCount >= minWords && ocr.confidence >= minConfidence;
  const hasBrandOrigin =
    hasText && brandOrigin
      ? new RegExp(brandOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(ocr.text)
      : false;

  return {
    url,
    hasText,
    hasBrandOrigin,
    wordCount: ocr.wordCount,
    ocrTextPreview: ocr.text.slice(0, 200).replace(/\s+/g, ' ').trim(),
    ocrConfidence: Math.round(ocr.confidence),
    bytes,
    error: ocr.error,
  };
}

/**
 * Roda OCR em batch com concorrência controlada. Retorna metadata pra
 * TODAS imagens (mesmo as que falharam — com error field populated).
 */
export async function extractImageOcrMetadata(
  input: ExtractImageMetadataInput,
): Promise<ImageOcrMetadata[]> {
  const {
    imageUrls,
    brandOrigin,
    sourceLanguage = 'en',
    minWords = 3,
    minConfidence = 20,
    concurrency = 4,
    onProgress,
  } = input;

  const tesseractLang = toTesseractLang(sourceLanguage);
  const results: (ImageOcrMetadata | null)[] = new Array(imageUrls.length).fill(null);
  let done = 0;

  // Worker pool: pega próxima imagem, processa, escreve resultado no índice.
  const queue = imageUrls.map((url, i) => ({ url, i }));
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) return;
      results[item.i] = await extractOne(
        item.url,
        brandOrigin,
        tesseractLang,
        minWords,
        minConfidence,
      );
      done++;
      onProgress?.(done, imageUrls.length);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return results.filter((r): r is ImageOcrMetadata => r !== null);
}
