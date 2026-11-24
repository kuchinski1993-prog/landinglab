// /api/landing-pages/:id/exports — pacotes para baixar a landing (zip HTML portátil + zip de tema Shopify).
//
// POST: enfileira o job `landinglab.export` (worker Railway monta os zips e sobe no bucket privado
//       `landing-exports`). Responde { jobId } na hora.
// GET:  ?jobId= opcional → estado do job; sempre lista os pacotes já gerados com link assinado (1 h).
//
// Worker: apps/worker/src/processors/landinglab-export.processor.ts

import { landingPages } from '@blackshop/db/schema-landinglab-core';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { requireAdminRequest } from '@/lib/admin/auth-guard';
import { enqueueJob, getJobStatus } from '@/lib/api-queue';
import { getDb } from '@/lib/landing-db';

const STORE_ID = 'l0i';
const QUEUE = 'landinglab.export';
const BUCKET = 'landing-exports';
const SIGNED_URL_TTL_S = 60 * 60;
const MAX_LISTED = 10;

export const runtime = 'nodejs';
export const maxDuration = 15;

interface Ctx {
  params: { id: string };
}

export interface LandingExportFile {
  name: string;
  format: 'html' | 'shopify' | null;
  bytes: number | null;
  createdAt: string | null;
  url: string | null;
}

async function landingExists(id: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: landingPages.id })
    .from(landingPages)
    .where(and(eq(landingPages.id, id), eq(landingPages.storeId, STORE_ID)))
    .limit(1);
  return Boolean(row);
}

function errorResponse(err: unknown, status = 500): Response {
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json({ ok: false, message }, { status });
}

export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;
  try {
    if (!(await landingExists(params.id))) {
      return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });
    }
    const { jobId, deduped } = await enqueueJob(
      QUEUE,
      'export',
      { landingPageId: params.id },
      { attempts: 1, removeOnComplete: { age: 24 * 3600, count: 200 }, removeOnFail: { age: 7 * 24 * 3600 } },
      { dedupeBy: 'landingPageId' },
    );
    return NextResponse.json({ ok: true, jobId, deduped });
  } catch (err) {
    return errorResponse(err, 502);
  }
}

export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;
  try {
    if (!(await landingExists(params.id))) {
      return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });
    }

    const jobId = new URL(req.url).searchParams.get('jobId');
    let job: { state: string; progress: unknown; failedReason: string | null } | null = null;
    if (jobId) {
      const status = await getJobStatus(QUEUE, jobId);
      job = status
        ? { state: status.state, progress: status.progress, failedReason: status.failedReason }
        : { state: 'missing', progress: null, failedReason: null };
    }

    const supaUrl = process.env['SUPABASE_URL'];
    const supaKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
    if (!supaUrl || !supaKey) {
      return NextResponse.json({ ok: false, message: 'Supabase env vars ausentes' }, { status: 500 });
    }
    const storage = createSupabaseClient(supaUrl, supaKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }).storage.from(BUCKET);

    const { data: listed, error } = await storage.list(params.id, {
      limit: MAX_LISTED,
      sortBy: { column: 'created_at', order: 'desc' },
    });
    if (error) throw new Error(`Falha ao listar pacotes: ${error.message}`);
    const objects = (listed ?? []).filter((o) => o.name.endsWith('.zip'));

    let urls: Array<{ path: string | null; signedUrl: string | null }> = [];
    if (objects.length) {
      const { data: signed, error: signErr } = await storage.createSignedUrls(
        objects.map((o) => `${params.id}/${o.name}`),
        SIGNED_URL_TTL_S,
        { download: true },
      );
      if (signErr) throw new Error(`Falha ao assinar links: ${signErr.message}`);
      urls = (signed ?? []).map((s) => ({ path: s.path, signedUrl: s.signedUrl }));
    }

    const files: LandingExportFile[] = objects.map((o) => {
      const meta = (o.metadata ?? {}) as { size?: number };
      const format = o.name.endsWith('-html.zip') ? 'html' : o.name.endsWith('-shopify.zip') ? 'shopify' : null;
      return {
        name: o.name,
        format,
        bytes: typeof meta.size === 'number' ? meta.size : null,
        createdAt: o.created_at ?? null,
        url: urls.find((u) => u.path === `${params.id}/${o.name}`)?.signedUrl ?? null,
      };
    });

    return NextResponse.json({ ok: true, job, files });
  } catch (err) {
    return errorResponse(err);
  }
}
