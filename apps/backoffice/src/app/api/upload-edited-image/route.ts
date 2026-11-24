// POST /api/upload-edited-image — upload de imagem editada manualmente
// pra substituir a original no Supabase.
//
// Fluxo:
//   1. Operator baixa imagem original via DownloadImagesModal
//   2. Edita manualmente (Canva/Figma/Photoshop) — traduz textos, muda marca, etc
//   3. Upload aqui — endpoint recebe arquivo + URL original, sobrescreve no bucket
//   4. Cache Cloudflare invalida automaticamente (no-cache header)
//
// Body (multipart/form-data):
//   - file: File (imagem editada)
//   - originalUrl: string (URL Supabase da imagem a substituir)

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { buildRateLimitResponse, getClientIdentity, rateLimit } from '@/lib/rate-limit';
import { requireVerifiedApiSession } from '@/lib/session';
const CLONE_BUCKET = 'cloned-landings';

export const runtime = 'nodejs';
export const maxDuration = 30;

function parseSupabasePath(url: string, bucket: string): string | null {
  const marker = `/storage/v1/object/public/${bucket}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  const path = url.slice(idx + marker.length);
  const q = path.indexOf('?');
  return q === -1 ? path : path.slice(0, q);
}

export async function POST(req: Request): Promise<Response> {
  // Épico 0 · 0.1 — sessão verificada na API (não basta o cookie existir).
  const authError = await requireVerifiedApiSession(req);
  if (authError) return authError;

  const rl = await rateLimit(`upload-edited:${getClientIdentity(req)}`, 60, 60 * 60 * 1000);
  if (!rl.ok) return buildRateLimitResponse(rl.resetAt);

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, message: 'Body deve ser multipart/form-data' }, { status: 400 });
  }

  const file = formData.get('file');
  const originalUrl = formData.get('originalUrl');

  if (!(file instanceof Blob)) {
    return NextResponse.json({ ok: false, message: 'file (Blob) obrigatório' }, { status: 400 });
  }
  if (typeof originalUrl !== 'string' || originalUrl.length === 0) {
    return NextResponse.json({ ok: false, message: 'originalUrl obrigatório' }, { status: 400 });
  }

  const objectPath = parseSupabasePath(originalUrl, CLONE_BUCKET);
  if (!objectPath) {
    return NextResponse.json(
      { ok: false, message: 'originalUrl não é uma URL Supabase do bucket cloned-landings' },
      { status: 400 },
    );
  }

  const supaUrl = process.env['SUPABASE_URL'];
  const supaKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!supaUrl || !supaKey) {
    return NextResponse.json(
      { ok: false, message: 'Supabase env vars ausentes' },
      { status: 500 },
    );
  }

  const supabase = createSupabaseClient(supaUrl, supaKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const buffer = Buffer.from(await file.arrayBuffer());
  const contentType = file.type || 'image/jpeg';

  const { error } = await supabase.storage.from(CLONE_BUCKET).upload(objectPath, buffer, {
    contentType,
    upsert: true,
    cacheControl: '31536000, immutable',
  });

  if (error) {
    return NextResponse.json(
      { ok: false, message: `Supabase upload falhou: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    message: 'Imagem substituída. Recarregue a landing (Ctrl+Shift+R) pra ver o resultado.',
    objectPath,
    bytes: buffer.length,
  });
}
