// GET /api/translate-images/stream?landingId=...&targetLanguage=...
//
// SSE endpoint pra Fase 5.C — traduz imagens embutidas de uma landing clonada.
// Emite progress events por imagem (start/ocr/translating/generating/done/failed).

import { join } from 'node:path';

import { landingPages } from '@blackshop/db/schema-landinglab-core';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { getDb } from '@/lib/landing-db';
import { buildRateLimitResponse, getClientIdentity, rateLimit } from '@/lib/rate-limit';
import { requireVerifiedApiSession } from '@/lib/session';
const STORE_ID = 'l0i';
const STORAGE_ROOT = join(process.cwd(), 'public', 'cloned');
const PUBLIC_PATH = '/cloned';

export const runtime = 'nodejs';
export const maxDuration = 600; // até 10min (tradução de N imagens sequencial)
export const dynamic = 'force-dynamic';

const ALLOWED_LANGS = ['en', 'it', 'de', 'fr', 'es', 'ja', 'zh', 'pt-BR', 'pt'] as const;
type AllowedLang = (typeof ALLOWED_LANGS)[number];

function sseFrame(event: string, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  const dataLines = payload.split('\n').map((l) => `data: ${l}`).join('\n');
  return `event: ${event}\n${dataLines}\n\n`;
}

export async function GET(req: Request): Promise<Response> {
  // Épico 0 · 0.1 — sessão verificada na API (não basta o cookie existir).
  const authError = await requireVerifiedApiSession(req);
  if (authError) return authError;

  // Rate limit: 20 stream requests/hora por usuário. Aplica ANTES de abrir o
  // stream — se limitar, retorna 429 JSON (não SSE) pra o EventSource falhar
  // no onerror do cliente.
  const rl = await rateLimit(`translate-images:${getClientIdentity(req)}`, 20, 60 * 60 * 1000);
  if (!rl.ok) return buildRateLimitResponse(rl.resetAt);

  const url = new URL(req.url);
  const landingId = url.searchParams.get('landingId')?.trim();
  const sourceLanguage = url.searchParams.get('sourceLanguage')?.trim() ?? 'auto';
  const targetLanguage = url.searchParams.get('targetLanguage')?.trim();

  if (!landingId) {
    return NextResponse.json({ ok: false, message: 'landingId obrigatório' }, { status: 400 });
  }
  if (!targetLanguage || !ALLOWED_LANGS.includes(targetLanguage as AllowedLang)) {
    return NextResponse.json(
      {
        ok: false,
        message: `targetLanguage inválido. Aceitos: ${ALLOWED_LANGS.join(', ')}`,
      },
      { status: 400 },
    );
  }

  // Thresholds OCR configuráveis via query params (Task #36).
  // Defaults matcham comportamento anterior: minWords=3, minConfidence=40.
  const minWordsRaw = url.searchParams.get('minWords');
  const minConfidenceRaw = url.searchParams.get('minConfidence');

  let minWords = 3;
  if (minWordsRaw != null) {
    const parsed = Number(minWordsRaw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
      return NextResponse.json(
        { ok: false, message: 'minWords deve ser inteiro entre 1 e 20' },
        { status: 400 },
      );
    }
    minWords = parsed;
  }

  let minConfidence = 40;
  if (minConfidenceRaw != null) {
    const parsed = Number(minConfidenceRaw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      return NextResponse.json(
        { ok: false, message: 'minConfidence deve estar entre 0 e 100' },
        { status: 400 },
      );
    }
    minConfidence = parsed;
  }

  const db = getDb();
  const [landing] = await db
    .select({
      id: landingPages.id,
      mediaUrls: landingPages.mediaUrls,
      // Fase Q — brand swap fields
      brandFrom: landingPages.brandFrom,
      brandTo: landingPages.brandTo,
      // Fase R — demografia alvo pra adaptação de rostos
      targetDemographic: landingPages.targetDemographic,
    })
    .from(landingPages)
    .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)))
    .limit(1);

  if (!landing) {
    return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });
  }

  const mediaUrls = (landing.mediaUrls ?? []).filter((u): u is string =>
    typeof u === 'string' && u.startsWith(PUBLIC_PATH),
  );

  if (mediaUrls.length === 0) {
    return NextResponse.json(
      { ok: false, message: 'Landing não tem imagens locais em /cloned/' },
      { status: 400 },
    );
  }

  // Public base URL — Seedream fetch bate no nosso servidor pra pegar a
  // imagem original. Em prod usa NEXT_PUBLIC_URL, em dev usa host header.
  const host = req.headers.get('host') ?? 'localhost:3000';
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  const publicBaseUrl = process.env['NEXT_PUBLIC_URL'] ?? `${proto}://${host}`;

  // AbortController — Task #42.
  // Sinaliza pro translateImages parar entre imagens quando o cliente SSE
  // desconecta (aba fechada, cancel do EventSource). Sem isso, o loop continua
  // rodando Gemini + Seedream mesmo com ninguém consumindo o resultado.
  const abortController = new AbortController();
  // Se o Request nasce já abortado (raro mas possível quando o navegador
  // cancela antes do handler começar), propaga imediatamente.
  if (req.signal?.aborted) {
    abortController.abort();
  } else {
    req.signal?.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  const encoder = new TextEncoder();
  // Flag defensiva — evita double-enqueue depois que cancel() já fechou o
  // stream. Sem isso, `controller.enqueue` em stream cancelado joga TypeError.
  let closed = false;
  const safeEnqueue = (
    controller: ReadableStreamDefaultController,
    chunk: Uint8Array,
  ): void => {
    if (closed) return;
    try {
      controller.enqueue(chunk);
    } catch {
      closed = true;
    }
  };
  const safeClose = (controller: ReadableStreamDefaultController): void => {
    if (closed) return;
    closed = true;
    try {
      controller.close();
    } catch {
      /* race entre finally e cancel() — ignore */
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      safeEnqueue(
        controller,
        encoder.encode(sseFrame('init', { landingId, imagesTotal: mediaUrls.length })),
      );

      let mod;
      try {
        mod = (await import(/* webpackIgnore: true */ '@blackshop/landinglab-cloner')) as {
          translateImages: (input: {
            landingId: string;
            imageUrls: string[];
            storageRoot: string;
            publicPathPrefix: string;
            publicBaseUrl: string;
            sourceLanguage: string;
            targetLanguage: string;
            minWordsThreshold?: number;
            minOcrConfidence?: number;
            onProgress?: (event: Record<string, unknown>) => void;
            signal?: AbortSignal;
            brandFrom?: string | null;
            brandTo?: string | null;
            targetDemographic?: string | null;
          }) => Promise<{
            translated: number;
            skipped: number;
            failed: number;
            totalCostUsd: number;
            totalLatencyMs: number;
            aborted?: boolean;
          }>;
        };
      } catch (err) {
        safeEnqueue(
          controller,
          encoder.encode(
            sseFrame('error', {
              message: `Falha ao carregar tradutor: ${err instanceof Error ? err.message : String(err)}`,
            }),
          ),
        );
        safeClose(controller);
        return;
      }

      try {
        const result = await mod.translateImages({
          landingId,
          imageUrls: mediaUrls,
          storageRoot: STORAGE_ROOT,
          publicPathPrefix: PUBLIC_PATH,
          publicBaseUrl,
          sourceLanguage,
          targetLanguage,
          minWordsThreshold: minWords,
          minOcrConfidence: minConfidence,
          signal: abortController.signal,
          brandFrom: landing.brandFrom as string | null,
          brandTo: landing.brandTo as string | null,
          targetDemographic: landing.targetDemographic as string | null,
          onProgress: (event) => {
            safeEnqueue(controller, encoder.encode(sseFrame('progress', event)));
          },
        });

        if (result.aborted) {
          // Loop parou por client_disconnected — stream provavelmente já foi
          // fechado pelo runtime. safeEnqueue vira no-op se for o caso.
          safeEnqueue(
            controller,
            encoder.encode(
              sseFrame('aborted', {
                landingId,
                reason: 'client_disconnected',
                partial: {
                  translated: result.translated,
                  skipped: result.skipped,
                  failed: result.failed,
                  totalCostUsd: result.totalCostUsd,
                },
              }),
            ),
          );
        } else {
          safeEnqueue(
            controller,
            encoder.encode(
              sseFrame('complete', {
                landingId,
                translated: result.translated,
                skipped: result.skipped,
                failed: result.failed,
                totalCostUsd: result.totalCostUsd,
                totalLatencyMs: result.totalLatencyMs,
              }),
            ),
          );
        }
      } catch (err) {
        safeEnqueue(
          controller,
          encoder.encode(
            sseFrame('error', {
              message: err instanceof Error ? err.message : String(err),
            }),
          ),
        );
      } finally {
        safeClose(controller);
      }
    },
    // cancel() é invocado pelo runtime quando o consumidor SSE fecha a conexão
    // (usuário fechou aba, chamou EventSource.close(), navegador crashou, etc).
    // Abortamos o signal pra que translateImages saia do loop na próxima
    // iteração — economizando as chamadas Gemini/Seedream restantes.
    cancel() {
      closed = true;
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
