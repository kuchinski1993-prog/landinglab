// Testes de `translateImages` (Fase 5.C).
//
// Estratégia: mock dos providers pesados (tesseract, gemini, freepik) via
// `vi.mock`. Também mocka `node:fs/promises` pra readFile/writeFile in-memory.
// Cobre:
//   - Skip por wordCount < minWordsThreshold
//   - Skip por confidence < 40
//   - Happy path completo (OCR → Gemini → Seedream → fetch → writeFile)
//   - Falha de OCR sem crashar (retorna wordCount=0 via runOcr catch)
//   - Falha em translateText propaga pra `failed[]` sem abortar batch

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────
// `vi.mock` é hoisted — pode aparecer antes dos imports.

vi.mock('../providers/tesseract.js', () => ({
  runOcr: vi.fn(),
  toTesseractLang: vi.fn((iso: string) => (iso === 'en' ? 'eng' : 'eng')),
  terminateOcrWorkers: vi.fn(),
}));

vi.mock('../providers/gemini-text.js', () => ({
  callGemini: vi.fn(),
}));

vi.mock('../providers/freepik.js', () => ({
  editImageWithSeedream: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

// Imports pós-mock — o `.js` sufixo bate com o alias que o package usa.
import { readFile, writeFile } from 'node:fs/promises';

import { runOcr } from '../providers/tesseract.js';
import { callGemini } from '../providers/gemini-text.js';
import { editImageWithSeedream } from '../providers/freepik.js';

import { translateImages } from './image-translator.js';

// Aliases tipados p/ Vitest — evita cast em cada it()
const mockedRunOcr = vi.mocked(runOcr);
const mockedGemini = vi.mocked(callGemini);
const mockedSeedream = vi.mocked(editImageWithSeedream);
const mockedReadFile = vi.mocked(readFile);
const mockedWriteFile = vi.mocked(writeFile);

const IMG_BYTES = Buffer.from('fakeimg');

const baseInput = {
  landingId: 'lp-1',
  publicPathPrefix: '/cloned',
  imageUrls: ['/cloned/lp-1/abc.webp'],
  storageRoot: '/tmp/public/cloned',
  sourceLanguage: 'en',
  targetLanguage: 'pt-BR',
  publicBaseUrl: 'http://localhost:3000',
};

describe('translateImages', () => {
  beforeEach(() => {
    mockedReadFile.mockResolvedValue(IMG_BYTES);
    mockedWriteFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('SKIP quando wordCount < minWordsThreshold', async () => {
    mockedRunOcr.mockResolvedValue({
      text: 'hi',
      confidence: 95,
      wordCount: 1, // < threshold default 3
      detectedLang: 'eng',
      latencyMs: 100,
    });

    const result = await translateImages({ ...baseInput, minWordsThreshold: 3 });

    expect(result.skipped).toBe(1);
    expect(result.translated).toBe(0);
    expect(result.failed).toBe(0);
    expect(mockedGemini).not.toHaveBeenCalled();
    expect(mockedSeedream).not.toHaveBeenCalled();
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('SKIP quando confidence < 40', async () => {
    mockedRunOcr.mockResolvedValue({
      text: 'lorem ipsum dolor sit amet',
      confidence: 25, // < 40
      wordCount: 5,
      detectedLang: 'eng',
      latencyMs: 100,
    });

    const result = await translateImages(baseInput);

    expect(result.skipped).toBe(1);
    expect(result.translated).toBe(0);
    expect(mockedGemini).not.toHaveBeenCalled();
  });

  it('happy path — OCR + Gemini + Seedream + fetch + writeFile', async () => {
    mockedRunOcr.mockResolvedValue({
      text: 'Get yours today!',
      confidence: 88,
      wordCount: 3,
      detectedLang: 'eng',
      latencyMs: 400,
    });
    mockedGemini.mockResolvedValue({
      content: 'Pegue o seu hoje!',
      tokens_in: 20,
      tokens_out: 8,
      cost_usd: 0.00001,
      latency_ms: 200,
      model: 'gemini-3.6-flash',
    });
    mockedSeedream.mockResolvedValue({
      taskId: 'task-xyz',
      imageUrl: 'https://freepik.com/generated/xyz.png',
      status: 'COMPLETED',
      latencyMs: 15000,
      costUsd: 0.04,
    });

    const generatedBytes = Buffer.from('translated-image-bytes');
    globalThis.fetch = vi.fn(async () =>
      new Response(generatedBytes, { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await translateImages(baseInput);

    expect(result.translated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(mockedGemini).toHaveBeenCalledOnce();
    expect(mockedSeedream).toHaveBeenCalledOnce();
    // Deve chamar Seedream com o publicBaseUrl + url do imageUrls
    expect(mockedSeedream.mock.calls[0]![0].imageUrl).toBe(
      'http://localhost:3000/cloned/lp-1/abc.webp',
    );
    // writeFile sobrescreve o path local original
    expect(mockedWriteFile).toHaveBeenCalledOnce();
    expect(mockedWriteFile.mock.calls[0]![0]).toBe('/tmp/public/cloned/lp-1/abc.webp');
    // Custo total = gemini + seedream
    expect(result.totalCostUsd).toBeCloseTo(0.04 + 0.00001);
  });

  it('erro no readFile (arquivo faltando) → failed sem crash', async () => {
    mockedReadFile.mockRejectedValueOnce(new Error('ENOENT'));

    const result = await translateImages(baseInput);

    expect(result.failed).toBe(1);
    expect(result.translated).toBe(0);
    expect(mockedRunOcr).not.toHaveBeenCalled();
  });

  it('erro no OCR retorna wordCount=0 (via runOcr catch) → treated as SKIP', async () => {
    // O provider tesseract.runOcr real captura erros internamente e devolve
    // OcrResult com error+wordCount=0. Mimicamos isso.
    mockedRunOcr.mockResolvedValue({
      text: '',
      confidence: 0,
      wordCount: 0,
      detectedLang: 'eng',
      latencyMs: 50,
      error: 'tesseract exploded',
    });

    const result = await translateImages(baseInput);

    // wordCount 0 < threshold 3 → skip (não é failed)
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockedGemini).not.toHaveBeenCalled();
  });

  it('falha permanente na tradução Gemini → failed, próximas imagens seguem', async () => {
    // mockReset limpa TUDO (implementations + queued Once responses) — evita
    // vazamento de state entre tests.
    mockedGemini.mockReset();
    mockedRunOcr.mockReset();
    mockedSeedream.mockReset();

    mockedRunOcr.mockResolvedValue({
      text: 'lorem ipsum text',
      confidence: 90,
      wordCount: 3,
      detectedLang: 'eng',
      latencyMs: 200,
    });

    // Contador rastreia quantas vezes callGemini foi invocado. Retorna erro
    // NÃO-TRANSIENTE (Gemini HTTP 400) pra evitar o withRetry interno; erros
    // 4xx (exceto 429) não são retentados por isTransientError.
    let geminiCalls = 0;
    mockedGemini.mockImplementation(async () => {
      geminiCalls += 1;
      // Imagem 1 (calls 1) → falha permanente. Imagem 2 (call 2+) → sucesso.
      // Como não há retry em 400, cada imagem gasta exatamente 1 chamada.
      if (geminiCalls === 1) {
        throw new Error('Gemini HTTP 400: invalid prompt');
      }
      return {
        content: 'traduzido',
        tokens_in: 10,
        tokens_out: 5,
        cost_usd: 0.00001,
        latency_ms: 100,
        model: 'gemini-3.6-flash',
      };
    });
    mockedSeedream.mockResolvedValue({
      taskId: 't',
      imageUrl: 'https://f.com/x.png',
      status: 'COMPLETED',
      latencyMs: 10000,
      costUsd: 0.04,
    });
    globalThis.fetch = vi.fn(async () =>
      new Response(Buffer.from('x'), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await translateImages({
      ...baseInput,
      imageUrls: ['/cloned/lp-1/a.webp', '/cloned/lp-1/b.webp'],
    });

    expect(geminiCalls).toBe(2); // 1 falha permanente + 1 sucesso (sem retry)
    expect(result.failed).toBe(1);
    expect(result.translated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.perImage.find((p) => p.status === 'failed')?.error).toContain(
      'Gemini HTTP 400',
    );
  });

  it('erro TRANSIENTE (HTTP 5xx) em Gemini retenta e recupera', async () => {
    // isTransientError considera HTTP 500-599, 429, timeout retriables.
    // withRetry maxAttempts=2 → 1 retry após 1s backoff.
    mockedGemini.mockReset();
    mockedRunOcr.mockReset();
    mockedSeedream.mockReset();

    mockedRunOcr.mockResolvedValue({
      text: 'transient test text',
      confidence: 90,
      wordCount: 3,
      detectedLang: 'eng',
      latencyMs: 100,
    });
    let attempts = 0;
    mockedGemini.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Gemini HTTP 503: overloaded');
      return {
        content: 'traduzido',
        tokens_in: 5,
        tokens_out: 3,
        cost_usd: 0,
        latency_ms: 50,
        model: 'gemini-3.6-flash',
      };
    });
    mockedSeedream.mockResolvedValue({
      taskId: 't',
      imageUrl: 'https://f.com/x.png',
      status: 'COMPLETED',
      latencyMs: 1000,
      costUsd: 0.04,
    });
    globalThis.fetch = vi.fn(async () =>
      new Response(Buffer.from('x'), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await translateImages(baseInput);

    expect(attempts).toBe(2); // 1 falha + 1 retry sucesso
    expect(result.translated).toBe(1);
    expect(result.failed).toBe(0);
  }, 10_000); // timeout maior por causa do backoff de 1s

  it('Seedream com status FAILED → failed[] entry (cobrança contabilizada)', async () => {
    mockedRunOcr.mockResolvedValue({
      text: 'buy now!',
      confidence: 90,
      wordCount: 2,
      detectedLang: 'eng',
      latencyMs: 100,
    });
    // Ajusta threshold pra 2 pra passar
    mockedGemini.mockResolvedValue({
      content: 'compre agora!',
      tokens_in: 5,
      tokens_out: 3,
      cost_usd: 0.00001,
      latency_ms: 80,
      model: 'gemini-3.6-flash',
    });
    mockedSeedream.mockResolvedValue({
      taskId: 't-fail',
      imageUrl: '',
      status: 'FAILED',
      latencyMs: 8000,
      costUsd: 0.04,
      error: 'safety filter',
    });

    const result = await translateImages({ ...baseInput, minWordsThreshold: 2 });

    expect(result.failed).toBe(1);
    expect(result.translated).toBe(0);
    expect(mockedWriteFile).not.toHaveBeenCalled();
    // Custo do Gemini + Seedream ambos contam mesmo em failure
    expect(result.totalCostUsd).toBeCloseTo(0.04 + 0.00001);
  });

  it('emite events de progresso na ordem: start → image:* → complete', async () => {
    mockedRunOcr.mockResolvedValue({
      text: 'a b c d',
      confidence: 90,
      wordCount: 4,
      detectedLang: 'eng',
      latencyMs: 100,
    });
    mockedGemini.mockResolvedValue({
      content: 'x y z w',
      tokens_in: 5,
      tokens_out: 5,
      cost_usd: 0.00001,
      latency_ms: 80,
      model: 'gemini-3.6-flash',
    });
    mockedSeedream.mockResolvedValue({
      taskId: 't',
      imageUrl: 'https://f.com/x.png',
      status: 'COMPLETED',
      latencyMs: 5000,
      costUsd: 0.04,
    });
    globalThis.fetch = vi.fn(async () =>
      new Response(Buffer.from('x'), { status: 200 }),
    ) as unknown as typeof fetch;

    const events: string[] = [];
    await translateImages({
      ...baseInput,
      onProgress: (e) => {
        events.push(e.phase);
      },
    });

    expect(events[0]).toBe('start');
    expect(events).toContain('image:start');
    expect(events).toContain('image:ocr:done');
    expect(events).toContain('image:done');
    expect(events[events.length - 1]).toBe('complete');
  });

  it('callback onProgress que joga NÃO aborta o pipeline', async () => {
    mockedRunOcr.mockResolvedValue({
      text: 'a b c',
      confidence: 90,
      wordCount: 3,
      detectedLang: 'eng',
      latencyMs: 100,
    });
    mockedGemini.mockResolvedValue({
      content: 'x y z',
      tokens_in: 5,
      tokens_out: 5,
      cost_usd: 0,
      latency_ms: 10,
      model: 'gemini-3.6-flash',
    });
    mockedSeedream.mockResolvedValue({
      taskId: 't',
      imageUrl: 'https://f.com/x.png',
      status: 'COMPLETED',
      latencyMs: 1000,
      costUsd: 0.04,
    });
    globalThis.fetch = vi.fn(async () =>
      new Response(Buffer.from('x'), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await translateImages({
      ...baseInput,
      onProgress: () => {
        throw new Error('SSE disconnected');
      },
    });
    expect(result.translated).toBe(1); // pipeline completou apesar do throw
  });

  // ─── Task #42 — abort via AbortSignal ─────────────────────────────
  it('signal já aborted ANTES do loop → retorna aborted:true sem chamar OCR/Gemini/Seedream', async () => {
    const ac = new AbortController();
    ac.abort();

    const result = await translateImages({
      ...baseInput,
      imageUrls: ['/cloned/lp-1/a.webp', '/cloned/lp-1/b.webp'],
      signal: ac.signal,
    });

    expect(result.aborted).toBe(true);
    expect(result.translated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(mockedRunOcr).not.toHaveBeenCalled();
    expect(mockedGemini).not.toHaveBeenCalled();
    expect(mockedSeedream).not.toHaveBeenCalled();
  });

  it('signal aborta ENTRE imagens → processa 1ª, pula 2ª+, retorna aborted:true', async () => {
    const ac = new AbortController();

    mockedRunOcr.mockResolvedValue({
      text: 'hello world text',
      confidence: 90,
      wordCount: 3,
      detectedLang: 'eng',
      latencyMs: 50,
    });
    mockedGemini.mockResolvedValue({
      content: 'olá mundo texto',
      tokens_in: 5,
      tokens_out: 3,
      cost_usd: 0.00001,
      latency_ms: 30,
      model: 'gemini-3.6-flash',
    });
    mockedSeedream.mockResolvedValue({
      taskId: 't',
      imageUrl: 'https://f.com/x.png',
      status: 'COMPLETED',
      latencyMs: 100,
      costUsd: 0.04,
    });
    globalThis.fetch = vi.fn(async () =>
      new Response(Buffer.from('x'), { status: 200 }),
    ) as unknown as typeof fetch;

    // Aborta assim que a 1ª imagem completa (via onProgress phase='image:done').
    const result = await translateImages({
      ...baseInput,
      imageUrls: [
        '/cloned/lp-1/a.webp',
        '/cloned/lp-1/b.webp',
        '/cloned/lp-1/c.webp',
      ],
      signal: ac.signal,
      onProgress: (e) => {
        if (e.phase === 'image:done') ac.abort();
      },
    });

    expect(result.aborted).toBe(true);
    expect(result.translated).toBe(1); // só a primeira completou
    expect(mockedGemini).toHaveBeenCalledTimes(1);
    expect(mockedSeedream).toHaveBeenCalledTimes(1);
  });

  it('emite evento aborted (não complete) quando abortado', async () => {
    const ac = new AbortController();
    ac.abort();

    const events: string[] = [];
    await translateImages({
      ...baseInput,
      imageUrls: ['/cloned/lp-1/a.webp'],
      signal: ac.signal,
      onProgress: (e) => {
        events.push(e.phase);
      },
    });

    expect(events).toContain('aborted');
    expect(events).not.toContain('complete');
    expect(events[events.length - 1]).toBe('aborted');
  });
});
