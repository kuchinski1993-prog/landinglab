// GET /api/landing-pages/[id]/semantic-model
//
// Fase 11.7 — Endpoint read-only expondo PageSemanticModel completo.
// Fase 12.0 — auth via assertAdmin (allowlist header).
// Fase 12.A (SECURITY FIX) — requireApiSession adicionado ANTES do
// assertAdmin. `x-admin-user-id` sozinho é spoofable de client externo
// (verified via curl externa → 200 antes deste fix). Auth real vem do
// `blackshop.sid` cookie server-set por Fastify — HttpOnly, não spoofable.
//
// AUTH atual (defense-in-depth):
//   1. Cookie `blackshop.sid` obrigatório (identity/session)
//        - Ausente/inválido → 401 (não vaza landing existence)
//   2. Header `x-admin-user-id` obrigatório (authorization allowlist)
//        - Ausente → 401
//        - Value não em ADMIN_USER_IDS → 403
//        - ADMIN_USER_IDS não configurado → 403 (fail-closed)
//
// Note: allowlist header continua útil quando Clerk landar — vira
// `sessionClaims.metadata.role === 'admin'` mantendo mesma assinatura.
//
// Contrato:
//   - Read-only. NÃO faz DB writes.
//   - NÃO muta html_body.
//   - NÃO altera Shopify, currency, bundles.
//   - Sem cache (D-11.6 do design review).
//   - Response é o PageSemanticModel completo (family + regions + slots +
//     textBlocks + confidence).

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { landingPages } from '@blackshop/db';
import {
  computePageSemanticModel,
  createAdapterRegistry,
  createSharedDetectorRegistry,
  kachingAdapter,
  accordionDetector,
  articleDetector,
  footerDetector,
  shopifyCtaDetector,
  type ImageOcrMetadataEntry,
  type PageFamily,
} from '@blackshop/landinglab-adapters';

import { getDb } from '@/lib/landing-db';
import { assertAdmin, handleAdminAuthError } from '@/lib/admin/auth-guard';
import { requireVerifiedApiSession } from '@/lib/session';

const STORE_ID = 'l0i';

export const runtime = 'nodejs';
export const maxDuration = 30;

// Cache de registries a nível de módulo (livre pra Node.js reuse dentro
// do mesmo lambda invocation — sem risco de leak; registries são frozen).
let cachedAdapterRegistry: ReturnType<typeof createAdapterRegistry> | null = null;
let cachedSharedRegistry: ReturnType<typeof createSharedDetectorRegistry> | null = null;

function getAdapterRegistry() {
  if (cachedAdapterRegistry) return cachedAdapterRegistry;
  const r = createAdapterRegistry();
  r.register(kachingAdapter);
  r.freeze();
  cachedAdapterRegistry = r;
  return r;
}

function getSharedRegistry() {
  if (cachedSharedRegistry) return cachedSharedRegistry;
  const r = createSharedDetectorRegistry();
  r.register(shopifyCtaDetector);
  r.register(articleDetector);
  r.register(accordionDetector);
  r.register(footerDetector);
  r.freeze();
  cachedSharedRegistry = r;
  return r;
}

function mapLandingKindToPageFamily(
  kind: string | null | undefined,
): PageFamily | null {
  if (kind === 'sales_page') return 'sales_page';
  if (kind === 'advertorial') return 'advertorial';
  if (kind === 'pdp_derived') return 'pdp_derived';
  return null;
}

export async function GET(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  // Fase 12.A — REAL identity check (session cookie server-issued).
  // Runs FIRST because it's the trust boundary. Cookie is HttpOnly → not
  // spoofable from client. Ausência → 401.
  // Épico 0 · 0.1 — a sessão é validada na API (/auth/me); antes só se
  // checava se o cookie existia, o que qualquer cliente consegue forjar.
  const sessionError = await requireVerifiedApiSession(req);
  if (sessionError) return sessionError;

  // Fase 12.0 — Authorization allowlist check (defense-in-depth).
  // Header x-admin-user-id é spoofable, mas só é aceitável DEPOIS de
  // session válida. Serve como camada extra: "user tem session E é admin".
  try {
    assertAdmin(req);
  } catch (err) {
    const authResponse = handleAdminAuthError(err);
    if (authResponse) return authResponse;
    return NextResponse.json({ error: 'auth_error' }, { status: 500 });
  }

  const landingId = params.id;
  const db = getDb();

  const [row] = await db
    .select({
      id: landingPages.id,
      htmlBody: landingPages.htmlBody,
      landingKind: landingPages.landingKind,
      imageOcrMetadata: landingPages.imageOcrMetadata,
    })
    .from(landingPages)
    .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)))
    .limit(1);

  if (!row) {
    return NextResponse.json(
      { ok: false, message: 'Landing não encontrada' },
      { status: 404 },
    );
  }

  if (!row.htmlBody) {
    return NextResponse.json(
      { ok: false, message: 'Landing sem html_body' },
      { status: 422 },
    );
  }

  const ocrMetadata = Array.isArray(row.imageOcrMetadata)
    ? (row.imageOcrMetadata as ImageOcrMetadataEntry[])
    : undefined;

  const startedAt = performance.now();
  const model = computePageSemanticModel({
    html: row.htmlBody,
    landingPageId: row.id,
    userHint: mapLandingKindToPageFamily(row.landingKind),
    adapterRegistry: getAdapterRegistry(),
    sharedRegistry: getSharedRegistry(),
    ...(ocrMetadata ? { ocrMetadata } : {}),
    computedAt: new Date().toISOString(),
  });
  const latencyMs = Math.round(performance.now() - startedAt);

  return NextResponse.json(
    {
      ok: true,
      model,
      meta: {
        latencyMs,
        htmlBytes: row.htmlBody.length,
      },
    },
    {
      status: 200,
      headers: {
        // No cache — mapper roda a cada request. Caching decision fica pra
        // fase futura quando editor V1 exigir.
        'cache-control': 'no-store',
      },
    },
  );
}
