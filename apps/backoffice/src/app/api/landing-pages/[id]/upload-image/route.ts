// POST /api/landing-pages/:id/upload-image
//
// Upload de um arquivo de imagem para o Supabase Storage da landing.
// Não modifica html_body — apenas persiste o arquivo e retorna a URL pública.
// Usado pelo editor para substituição de imagens via arquivo local.
//
// Body: multipart/form-data
//   - file: File (imagem JPG/PNG/WebP/AVIF/GIF, máx 10 MB)
//
// Response: { ok: true, url: string, bytes: number, mime: string }

import crypto from 'node:crypto';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { landingPages } from '@blackshop/db/schema-landinglab-core';

import { getDb } from '@/lib/landing-db';
import { requireAdminRequest } from '@/lib/admin/auth-guard';

const STORE_ID = 'l0i';
const BUCKET = 'cloned-landings';
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'];

export const runtime = 'nodejs';
export const maxDuration = 30;

interface Ctx {
  params: { id: string };
}

export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;

  const db = getDb();
  const [row] = await db
    .select({ id: landingPages.id })
    .from(landingPages)
    .where(and(eq(landingPages.id, params.id), eq(landingPages.storeId, STORE_ID)))
    .limit(1);
  if (!row) {
    return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, message: 'multipart/form-data esperado' }, { status: 400 });
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, message: 'file obrigatório' }, { status: 400 });
  }

  const mime = file.type || 'image/jpeg';
  if (!ACCEPTED_MIME.includes(mime)) {
    return NextResponse.json(
      { ok: false, message: `Formato não aceito: ${mime}. Use JPG, PNG, WebP ou AVIF.` },
      { status: 400 },
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, message: `Arquivo muito grande (${(buf.length / 1024 / 1024).toFixed(1)} MB). Máximo 10 MB.` },
      { status: 400 },
    );
  }

  const ext = /webp/i.test(mime) ? 'webp' : /png/i.test(mime) ? 'png' : /gif/i.test(mime) ? 'gif' : /avif/i.test(mime) ? 'avif' : 'jpg';
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const objectPath = `landings/${params.id}/${params.id}/${hash}.${ext}`;

  const supaUrl = process.env['SUPABASE_URL'];
  const supaKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!supaUrl || !supaKey) {
    return NextResponse.json({ ok: false, message: 'Supabase env vars ausentes' }, { status: 500 });
  }

  const supa = createSupabaseClient(supaUrl, supaKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error } = await supa.storage.from(BUCKET).upload(objectPath, buf, {
    contentType: mime,
    upsert: true,
    cacheControl: '31536000, immutable',
  });

  if (error) {
    return NextResponse.json({ ok: false, message: `Upload falhou: ${error.message}` }, { status: 500 });
  }

  const url = `${supaUrl}/storage/v1/object/public/${BUCKET}/${objectPath}`;
  return NextResponse.json({ ok: true, url, bytes: buf.length, mime });
}
