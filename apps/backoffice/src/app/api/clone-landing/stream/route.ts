// GET /api/clone-landing/stream?jobId=X (Fase F.3)
//
// Server-Sent Events streaming do clone job processado pelo worker Railway.
// Consulta o estado do job na API (Railway) e retransmite pro browser.
//
// Fluxo:
//   1. POST /api/clone-landing → enfileira job → retorna { jobId }
//   2. GET /api/clone-landing/stream?jobId=X → SSE stream:
//      event: init      → { jobId, landingId?, status }
//      event: progress  → { phase, ...payload }        (updateProgress do worker)
//      event: complete  → { landingId, stats }
//      event: error     → { message }
//      event: aborted   → { reason }
//
// IMPORTANT: reescrito 2026-09-15 — versão antiga rodava Playwright direto no
// Vercel (não funciona: serverless sem Chromium, filesystem read-only).
// 2026-11 — não conecta mais no Redis: o Redis fica só na rede interna do Railway
// (sem acesso público). Em vez de QueueEvents, consulta GET /landinglab/queues/... na
// API a cada POLL_INTERVAL_MS e emite `progress` quando o progresso muda.
//
// Timeouts:
//   - maxDuration 300s cobre clones lentos (default clone ~30-90s + margem)
//   - Fecha stream após 'complete', 'error', 'aborted' ou timeout de 5min sem
//     eventos (job travado/perdido).

import { landingPages } from '@blackshop/db/schema-landinglab-core';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { STREAM_TIMEOUT_MS } from './constants';

import { getJobStatus, sessionHeader, type QueueJobStatus } from '@/lib/api-queue';
import { getDb } from '@/lib/landing-db';
import { requireVerifiedApiSession } from '@/lib/session';
const STORE_ID = 'l0i';
const CLONE_QUEUE = 'landinglab.squad0.clone';
const POLL_INTERVAL_MS = 2_000;
/** Falhas seguidas de consulta à API antes de desistir (~30 s). */
const MAX_POLL_ERRORS = 15;

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/** Formata um SSE frame. Newline duplo termina a mensagem. */
function sseFrame(event: string, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  const dataLines = payload.split('\n').map((l) => `data: ${l}`).join('\n');
  return `event: ${event}\n${dataLines}\n\n`;
}

/** returnvalue pode vir stringificado — devolve o objeto quando der. */
function parseStats(returnvalue: unknown): unknown {
  if (typeof returnvalue !== 'string') return returnvalue;
  try {
    return JSON.parse(returnvalue);
  } catch {
    return returnvalue;
  }
}

export async function GET(req: Request): Promise<Response> {
  // Épico 0 · 0.1 — sessão verificada na API (não basta o cookie existir).
  const authError = await requireVerifiedApiSession(req);
  if (authError) return authError;

  const url = new URL(req.url);
  const jobId = url.searchParams.get('jobId')?.trim();
  if (!jobId) {
    return NextResponse.json(
      { ok: false, message: 'jobId obrigatório (?jobId=...)' },
      { status: 400 },
    );
  }

  const db = getDb();
  // Lido agora: o stream continua depois que o handler retorna.
  const cookie = sessionHeader();
  let job: QueueJobStatus | null;
  try {
    job = await getJobStatus(CLONE_QUEUE, jobId, cookie);
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: `Não foi possível consultar o clone: ${err instanceof Error ? err.message : String(err)}` },
      { status: 503 },
    );
  }
  if (!job) {
    return NextResponse.json(
      { ok: false, message: `Job ${jobId} não encontrado (pode ter expirado)` },
      { status: 404 },
    );
  }

  const landingPageId = (job.data as { landingPageId?: string } | null)?.landingPageId ?? null;
  const initial = job;

  const encoder = new TextEncoder();
  let closed = false;
  const send = (ctrl: ReadableStreamDefaultController, event: string, data: unknown): void => {
    if (closed) return;
    try {
      ctrl.enqueue(encoder.encode(sseFrame(event, data)));
    } catch {
      closed = true;
    }
  };
  const safeClose = (ctrl: ReadableStreamDefaultController): void => {
    if (closed) return;
    closed = true;
    try {
      ctrl.close();
    } catch {
      /* já fechado — ignore */
    }
  };

  let stop: () => void = () => undefined;
  const stream = new ReadableStream({
    start(controller) {
      // Init: manda estado atual + landingId pra frontend preparar UI.
      send(controller, 'init', { jobId, landingId: landingPageId, status: initial.state });

      let lastProgress = JSON.stringify(initial.progress ?? null);
      let pollErrors = 0;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;

      const heartbeat = setInterval(() => {
        // Heartbeat a cada 15s pra manter conexão viva através de proxies (Vercel,
        // Cloudflare) que dropam idle connections. Cliente ignora comentários SSE.
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          closed = true;
        }
      }, 15_000);
      const timeout = setTimeout(() => {
        send(controller, 'aborted', {
          reason: 'stream_timeout',
          message: 'Clone ainda em andamento — recarregue a página pra ver o resultado.',
        });
        finish();
      }, STREAM_TIMEOUT_MS);

      function finish(): void {
        clearInterval(heartbeat);
        clearTimeout(timeout);
        if (pollTimer) clearTimeout(pollTimer);
        safeClose(controller);
      }
      stop = finish;

      /** Emite o evento terminal se o job acabou. Devolve true quando o stream deve fechar. */
      async function handle(status: QueueJobStatus): Promise<boolean> {
        const progress = JSON.stringify(status.progress ?? null);
        if (progress !== lastProgress && status.progress != null && typeof status.progress === 'object') {
          send(controller, 'progress', status.progress);
        }
        lastProgress = progress;

        if (status.state === 'failed') {
          send(controller, 'error', { message: status.failedReason ?? 'unknown', landingId: landingPageId });
          return true;
        }
        if (status.state !== 'completed') return false;
        // Confirma que landing_pages foi realmente atualizada (defensivo).
        if (landingPageId) {
          const row = await db
            .select({ title: landingPages.title })
            .from(landingPages)
            .where(and(eq(landingPages.id, landingPageId), eq(landingPages.storeId, STORE_ID)))
            .limit(1);
          if (row.length === 0) {
            send(controller, 'error', { message: 'Landing sumiu do DB após clone', landingId: landingPageId });
            return true;
          }
        }
        send(controller, 'complete', { landingId: landingPageId, stats: parseStats(status.returnvalue) });
        return true;
      }

      async function poll(): Promise<void> {
        if (closed) return;
        try {
          const status = await getJobStatus(CLONE_QUEUE, jobId!, cookie);
          pollErrors = 0;
          if (!status) {
            send(controller, 'error', { message: 'Job sumiu da fila antes de terminar', landingId: landingPageId });
            finish();
            return;
          }
          if (await handle(status)) {
            finish();
            return;
          }
        } catch (err) {
          pollErrors += 1;
          if (pollErrors >= MAX_POLL_ERRORS) {
            send(controller, 'error', {
              message: `Perdi contato com a fila: ${err instanceof Error ? err.message : String(err)}`,
              landingId: landingPageId,
            });
            finish();
            return;
          }
        }
        if (!closed) pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }

      // Se job já completou/falhou antes do stream conectar, emite e fecha.
      handle(initial).then(
        (done) => {
          if (done) finish();
          else pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        },
        () => {
          pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        },
      );

      // Se cliente desconectar durante stream, fecha (job continua no worker;
      // não abortamos o job — refresh mostra resultado quando pronto).
      req.signal?.addEventListener('abort', finish, { once: true });
    },
    cancel() {
      stop();
      closed = true;
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
