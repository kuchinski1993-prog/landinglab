// Tesseract.js OCR provider.
//
// Roda localmente (Node) sem chamada externa. Cada instância carrega modelos
// de linguagem lazy — primeiro OCR demora ~2-3s (setup), subsequentes ~500ms.
//
// Uso pelo image-translator (Fase 5.C) pra filtrar: só imagens com texto
// suficiente (>3 palavras) são enviadas pro Seedream — economiza $0.04/img
// nas imagens sem texto (~50-70% das imgs numa landing típica).

import sharp from 'sharp';
import { createWorker, type Worker } from 'tesseract.js';

export interface OcrResult {
  /** Texto detectado (pode ser vazio). */
  text: string;
  /** Confidence 0-100. Below 40 geralmente é ruído (false positive). */
  confidence: number;
  /** Quantas palavras "reais" (>1 letter, contém alfanumérico). */
  wordCount: number;
  /** Detected language (best guess) OR o fornecido. */
  detectedLang: string;
  latencyMs: number;
  error?: string;
}

/**
 * Retorna instância singleton do worker Tesseract pra evitar re-init.
 * Cada worker suporta 1 idioma por vez — pra multi-lang, chame reInitialize.
 *
 * Idioma default: 'eng+jpn' — cobre ~80% dos casos de landings dropship
 * (inglês + japonês são os mais comuns). Pra outros idiomas, use OCR
 * multi-lang carregado sob demanda.
 */
interface WorkerCache {
  [langKey: string]: Worker;
}

const g = globalThis as unknown as { __tesseractWorkers?: WorkerCache };

async function getWorker(lang: string): Promise<Worker> {
  if (!g.__tesseractWorkers) g.__tesseractWorkers = {};
  if (g.__tesseractWorkers[lang]) return g.__tesseractWorkers[lang];
  const worker = await createWorker(lang);
  g.__tesseractWorkers[lang] = worker;
  return worker;
}

/**
 * Roda OCR numa imagem local (Buffer ou path) e retorna texto + confidence.
 *
 * @param imageBuffer  Buffer da imagem (webp/png/jpg/jpeg).
 * @param sourceLang   Idioma do texto ('eng', 'jpn', 'por', 'spa', etc).
 *                     ISO-639-2 (3 letras). Default: 'eng'.
 */
export async function runOcr(
  imageBuffer: Buffer,
  sourceLang = 'eng',
): Promise<OcrResult> {
  const started = Date.now();
  try {
    // Tesseract.js 5.x + Docker Linux binaries têm bug de decode em vários
    // formatos ("Error in pixReadMemWebP", "Error in pixReadStream: Unknown
    // format: no pix returned"), disparados num Worker thread que ESCAPA do
    // try/catch aqui. Fix: pré-processar TUDO com sharp → PNG. Isso normaliza
    // formato e stripa metadados que podem confundir Leptonica.
    //
    // Perda de qualidade é mínima (sharp usa lossless recompression), mas em
    // troca eliminamos o bug e ganhamos consistência.
    let ocrInput: Buffer;
    try {
      ocrInput = await sharp(imageBuffer, { failOn: 'none' })
        .flatten({ background: { r: 255, g: 255, b: 255 } }) // remove alpha (contraste text)
        .png({ compressionLevel: 3, quality: 100 })
        .toBuffer();
    } catch (sharpErr) {
      // Imagem realmente corrompida — retorna vazio graciosamente
      return {
        text: '',
        confidence: 0,
        wordCount: 0,
        detectedLang: sourceLang,
        latencyMs: Date.now() - started,
        error:
          sharpErr instanceof Error
            ? `sharp decode failed: ${sharpErr.message}`
            : 'sharp decode failed',
      };
    }
    const worker = await getWorker(sourceLang);
    const result = await worker.recognize(ocrInput);
    const text = result.data.text.trim();
    const words = text
      .split(/\s+/)
      .filter((w) => w.length >= 2 && /[\p{L}\p{N}]/u.test(w));
    return {
      text,
      confidence: result.data.confidence,
      wordCount: words.length,
      detectedLang: sourceLang,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      text: '',
      confidence: 0,
      wordCount: 0,
      detectedLang: sourceLang,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Encerra todos os workers Tesseract cachados. Chame no shutdown do processo
 * pra liberar memória (~50MB por idioma).
 */
export async function terminateOcrWorkers(): Promise<void> {
  if (!g.__tesseractWorkers) return;
  await Promise.all(
    Object.values(g.__tesseractWorkers).map((w) => w.terminate()),
  );
  g.__tesseractWorkers = {};
}

/**
 * Mapeia códigos ISO-639-1 (2 letras) pra ISO-639-2 do Tesseract (3 letras).
 * Suporta os idiomas mais comuns em landings dropship.
 */
const LANG_MAP: Record<string, string> = {
  en: 'eng',
  it: 'ita',
  de: 'deu',
  fr: 'fra',
  es: 'spa',
  pt: 'por',
  'pt-br': 'por',
  ja: 'jpn',
  zh: 'chi_sim',
  ru: 'rus',
  ar: 'ara',
  ko: 'kor',
};

export function toTesseractLang(iso: string): string {
  // 'auto' = detecção multi-idioma (mais lento no primeiro carregamento, mas
  // essencial pra landings dropship que costumam misturar EN+JA+ZH). Tesseract
  // roda todos os modelos e reporta o texto com melhor match.
  if (iso.toLowerCase() === 'auto') return 'eng+jpn+chi_sim';
  return LANG_MAP[iso.toLowerCase()] ?? 'eng';
}
