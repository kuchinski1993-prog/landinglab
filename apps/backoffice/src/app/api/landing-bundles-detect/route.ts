// GET /api/landing-bundles-detect?landingId=UUID
//
// Wizard V2 Step 4 (Preços): detecta bundles/faixas de preço da landing origem
// via IA (Gemini Flash). Custo ~$0.001 por landing. Cache no wizard_state.pricing.
//
// Diferente de /api/landing-product-extract que usa regex (pega variantes
// tradicionais Shopify), esse endpoint usa IA (mais robusto pra bundles
// custom via Kaching/ReCharge/temas modernos).

import { landingPages } from '@blackshop/db/schema-landinglab-core';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { getDb } from '@/lib/landing-db';
import { buildRateLimitResponse, getClientIdentity, rateLimit } from '@/lib/rate-limit';
import { requireVerifiedApiSession } from '@/lib/session';
const STORE_ID = 'l0i';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(req: Request): Promise<Response> {
  // Épico 0 · 0.1 — sessão verificada na API (não basta o cookie existir).
  const authError = await requireVerifiedApiSession(req);
  if (authError) return authError;

  const rl = await rateLimit(`bundles-detect:${getClientIdentity(req)}`, 30, 60 * 60 * 1000);
  if (!rl.ok) return buildRateLimitResponse(rl.resetAt);

  const url = new URL(req.url);
  const landingId = url.searchParams.get('landingId');
  if (!landingId) {
    return NextResponse.json({ ok: false, message: 'landingId obrigatório' }, { status: 400 });
  }

  const db = getDb();
  const rows = await db
    .select({
      htmlBody: landingPages.htmlBody,
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

  try {
    const mod = (await import(/* webpackIgnore: true */ '@blackshop/landinglab-cloner')) as {
      detectBundles: (html: string) => Promise<{
        bundles: Array<{
          name: string;
          description: string;
          quantityUnits: number | null;
          priceCents: number;
          compareAtPriceCents: number | null;
          currency: string;
          confidence: number;
        }>;
        costUsd: number;
        latencyMs: number;
        source: string;
        warnings: string[];
      }>;
    };
    const result = await mod.detectBundles(row.htmlBody);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, message: `Falha detectar bundles: ${message}` },
      { status: 500 },
    );
  }
}
