// GET /api/landing-cta?landingId=UUID → { ctas: DetectedCta[], config: CtaConfig|null }
// POST /api/landing-cta { landingId, mappings } → aplica rewriteCtas e salva.
//
// Usado pela UI de "Configurar CTAs" na página de edição da landing.
// Zero custo API (parse5 puro).

import { landingPages } from '@blackshop/db/schema-landinglab-core';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { getDb } from '@/lib/landing-db';
import { buildRateLimitResponse, getClientIdentity, rateLimit } from '@/lib/rate-limit';
import { requireVerifiedApiSession } from '@/lib/session';
const STORE_ID = 'l0i';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface PostBody {
  landingId?: string;
  mappings?: Array<{ selector: string; newHref: string | null }>;
}

export async function GET(req: Request): Promise<Response> {
  // Épico 0 · 0.1 — sessão verificada na API (não basta o cookie existir).
  const authError = await requireVerifiedApiSession(req);
  if (authError) return authError;

  const url = new URL(req.url);
  const landingId = url.searchParams.get('landingId');
  if (!landingId) {
    return NextResponse.json({ ok: false, message: 'landingId obrigatório' }, { status: 400 });
  }

  const db = getDb();
  const rows = await db
    .select({
      htmlBody: landingPages.htmlBody,
      sourceUrl: landingPages.sourceUrl,
      ctaConfig: landingPages.ctaConfig,
    })
    .from(landingPages)
    .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });
  }
  if (!row.htmlBody || row.htmlBody.length < 50) {
    return NextResponse.json({ ok: false, message: 'Landing sem HTML' }, { status: 400 });
  }

  const mod = (await import(/* webpackIgnore: true */ '@blackshop/landinglab-cloner')) as {
    extractCtas: (
      html: string,
      opts?: { sourceUrl?: string },
    ) => { html: string; ctas: unknown[] };
  };
  const { ctas } = mod.extractCtas(row.htmlBody, {
    sourceUrl: row.sourceUrl ?? undefined,
  });

  return NextResponse.json({ ok: true, ctas, config: row.ctaConfig ?? null });
}

export async function POST(req: Request): Promise<Response> {
  // Épico 0 · 0.1 — sessão verificada na API (não basta o cookie existir).
  const authError = await requireVerifiedApiSession(req);
  if (authError) return authError;

  const rl = await rateLimit(`landing-cta:${getClientIdentity(req)}`, 30, 60 * 60 * 1000);
  if (!rl.ok) return buildRateLimitResponse(rl.resetAt);

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ ok: false, message: 'JSON inválido' }, { status: 400 });
  }

  const { landingId, mappings } = body;
  if (!landingId) {
    return NextResponse.json({ ok: false, message: 'landingId obrigatório' }, { status: 400 });
  }
  if (!Array.isArray(mappings)) {
    return NextResponse.json({ ok: false, message: 'mappings deve ser array' }, { status: 400 });
  }

  const db = getDb();
  const rows = await db
    .select({ htmlBody: landingPages.htmlBody, sourceUrl: landingPages.sourceUrl })
    .from(landingPages)
    .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });
  }

  const mod = (await import(/* webpackIgnore: true */ '@blackshop/landinglab-cloner')) as {
    extractCtas: (
      html: string,
      opts?: { sourceUrl?: string },
    ) => { html: string; ctas: Array<{ selector: string; category: string; currentHref: string }> };
    rewriteCtas: (
      html: string,
      mappings: Array<{ selector: string; newHref: string | null }>,
    ) => { html: string; applied: number; skipped: number };
  };

  // Primeiro anota o HTML (garante data-cta-idx presente) — idempotente.
  const { html: annotated, ctas: detected } = mod.extractCtas(row.htmlBody, {
    sourceUrl: row.sourceUrl ?? undefined,
  });
  const result = mod.rewriteCtas(annotated, mappings);

  // Persiste HTML novo + snapshot da config.
  const configSnapshot = {
    mappings: mappings
      .filter((m) => m.newHref !== null)
      .map((m) => {
        const orig = detected.find((c) => c.selector === m.selector);
        return {
          selector: m.selector,
          originalHref: orig?.currentHref ?? '',
          newHref: m.newHref,
          category: orig?.category ?? 'unknown',
        };
      }),
    lastRewriteAt: new Date().toISOString(),
  };

  await db
    .update(landingPages)
    .set({
      htmlBody: result.html,
      ctaConfig: configSnapshot,
      updatedAt: new Date(),
    })
    .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)));

  return NextResponse.json({
    ok: true,
    applied: result.applied,
    skipped: result.skipped,
  });
}
