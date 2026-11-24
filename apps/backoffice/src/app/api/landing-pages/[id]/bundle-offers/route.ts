// Bundle Engine V2 — CRUD de ofertas (set/2026).
//
// GET  → lista ofertas + metadata da landing (adapter, notes, flag)
// PUT  → upsert em massa (substituição total). Body: { offers: [...], offersSource?, placement? }
// PATCH → toggle useNewBundleEngine
//
// Story 25.1: bullets e link por oferta, modo das ofertas (página/sistema) e posição do bloco do
// sistema (âncora/remoção manual em cta_config.offersPlacement, marcada no html_body).

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { landingBundleOffers, landingPages } from '@blackshop/db';
import {
  EXTERNAL_URL_REASON_PT,
  validateExternalCheckoutUrl,
} from '@blackshop/shared/external-checkout';
import {
  BULLETS_REASON_PT,
  BUNDLE_ROOT_ATTR,
  OFFERS_ANCHOR_ATTR,
  findMarkedElementRanges,
  normalizeOffersSource,
  validateOfferBullets,
} from '@blackshop/shared/landing-offers';

import { getDb } from '@/lib/landing-db';
import { enqueueApplyBundle } from '@/lib/enqueue-apply-bundle';
import { requireAdminRequest } from '@/lib/admin/auth-guard';
import {
  bulletsMarkedByCard,
  mergeOffersPlacement,
  readOffersPlacement,
  resolveOffersPlacement,
  type OffersPlacementConfig,
} from '@/lib/landing-offers-placement';

const STORE_ID = 'l0i';

export const runtime = 'nodejs';
export const maxDuration = 20;

interface OfferInput {
  position: number;
  title?: string;
  qty?: number;
  priceCents?: number;
  compareAtCents?: number | null;
  saveText?: string | null;
  badge?: string | null;
  variantId?: string | null;
  isPreselected?: boolean;
  bullets?: unknown;
  checkoutUrl?: string | null;
}

interface OfferFieldError {
  index: number;
  field: 'bullets' | 'checkoutUrl' | 'priceCents' | 'qty';
  message: string;
}

function parsePlacementInput(raw: unknown): OffersPlacementConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  return readOffersPlacement({ offersPlacement: raw });
}

async function fetchLanding(landingId: string) {
  const db = getDb();
  const [row] = await db
    .select({
      id: landingPages.id,
      currency: landingPages.currency,
      useNewBundleEngine: landingPages.useNewBundleEngine,
      bundleAdapter: landingPages.bundleAdapter,
      bundleAdapterNotes: landingPages.bundleAdapterNotes,
      offersSource: landingPages.offersSource,
      ctaConfig: landingPages.ctaConfig,
      htmlBody: landingPages.htmlBody,
      updatedAt: landingPages.updatedAt,
    })
    .from(landingPages)
    .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)))
    .limit(1);
  return row ?? null;
}

export async function GET(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;

  const landing = await fetchLanding(params.id);
  if (!landing) return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });

  const db = getDb();
  const offers = await db
    .select()
    .from(landingBundleOffers)
    .where(eq(landingBundleOffers.landingPageId, params.id))
    .orderBy(landingBundleOffers.position);

  const html = landing.htmlBody ?? '';
  const bulletsMarked = bulletsMarkedByCard(html);

  return NextResponse.json({
    ok: true,
    currency: landing.currency,
    useNewBundleEngine: landing.useNewBundleEngine,
    bundleAdapter: landing.bundleAdapter,
    bundleAdapterNotes: landing.bundleAdapterNotes,
    offersSource: normalizeOffersSource(landing.offersSource),
    placement: readOffersPlacement(landing.ctaConfig),
    hasBundleRoot: findMarkedElementRanges(html, BUNDLE_ROOT_ATTR).length > 0,
    hasOffersAnchor: findMarkedElementRanges(html, OFFERS_ANCHOR_ATTR).length > 0,
    offers: offers.map((o, i) => ({ ...o, bulletsMarked: bulletsMarked.has(i) })),
    // updatedAt = timestamp da última reescrita do html_body pelo worker.
    // Frontend usa pra polling: espera esse valor mudar depois de PUT+enqueue.
    landingUpdatedAt: landing.updatedAt?.toISOString() ?? null,
  });
}

export async function PUT(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;

  const landing = await fetchLanding(params.id);
  if (!landing) return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });

  let body: { offers?: OfferInput[]; offersSource?: unknown; placement?: unknown };
  try {
    body = (await req.json()) as { offers?: OfferInput[]; offersSource?: unknown; placement?: unknown };
  } catch {
    return NextResponse.json({ ok: false, message: 'JSON inválido' }, { status: 400 });
  }
  if (!Array.isArray(body.offers)) {
    return NextResponse.json({ ok: false, message: 'offers[] obrigatório' }, { status: 400 });
  }

  // Validação dos campos: qualquer erro → nada é gravado (erros por oferta para o editor).
  const errors: OfferFieldError[] = [];
  const bulletsByOffer: string[][] = [];
  const urlByOffer: (string | null)[] = [];
  for (let i = 0; i < body.offers.length; i++) {
    const o = body.offers[i]!;
    if (typeof o.priceCents === 'number' && o.priceCents < 0) {
      errors.push({ index: i, field: 'priceCents', message: 'O preço não pode ser negativo.' });
    }
    if (typeof o.qty === 'number' && o.qty < 1) {
      errors.push({ index: i, field: 'qty', message: 'A quantidade deve ser pelo menos 1.' });
    }
    const bullets = validateOfferBullets(o.bullets);
    if (bullets.ok) bulletsByOffer.push(bullets.bullets);
    else {
      bulletsByOffer.push([]);
      errors.push({ index: i, field: 'bullets', message: BULLETS_REASON_PT[bullets.reason] });
    }
    const rawUrl = typeof o.checkoutUrl === 'string' ? o.checkoutUrl.trim() : '';
    if (!rawUrl) urlByOffer.push(null);
    else {
      const url = validateExternalCheckoutUrl(rawUrl);
      urlByOffer.push(url.ok ? url.url : null);
      if (!url.ok) errors.push({ index: i, field: 'checkoutUrl', message: EXTERNAL_URL_REASON_PT[url.reason] });
    }
  }
  if (errors.length > 0) {
    const first = errors[0]!;
    return NextResponse.json(
      { ok: false, message: `Oferta ${first.index + 1}: ${first.message}`, errors },
      { status: 400 },
    );
  }

  const offersSource =
    body.offersSource === undefined ? null : normalizeOffersSource(body.offersSource);
  const placementInput = parsePlacementInput(body.placement);

  const db = getDb();
  const offersToInsert = body.offers as OfferInput[];
  let placement: OffersPlacementConfig | null = null;
  // Delete-then-insert em transaction para garantir atomicidade.
  await db.transaction(async (tx) => {
    await tx.delete(landingBundleOffers).where(eq(landingBundleOffers.landingPageId, params.id));
    if (offersToInsert.length > 0) {
      await tx.insert(landingBundleOffers).values(
        offersToInsert.map((o, i) => ({
          landingPageId: params.id,
          position: o.position ?? i,
          title: o.title ?? '',
          qty: o.qty ?? 1,
          priceCents: o.priceCents ?? 0,
          compareAtCents: o.compareAtCents ?? null,
          saveText: o.saveText ?? null,
          badge: o.badge ?? null,
          variantId: o.variantId ?? null,
          isPreselected: o.isPreselected ?? false,
          bullets: bulletsByOffer[i] ?? [],
          checkoutUrl: urlByOffer[i] ?? null,
        })),
      );
    }

    if (offersSource === null && !placementInput) return;
    // Modo e posição: relê com lock (cta_config é compartilhado com a seção Checkout).
    const [current] = await tx
      .select({ htmlBody: landingPages.htmlBody, ctaConfig: landingPages.ctaConfig })
      .from(landingPages)
      .where(and(eq(landingPages.id, params.id), eq(landingPages.storeId, STORE_ID)))
      .for('update');
    if (!current) return;
    const patch: Partial<typeof landingPages.$inferInsert> = {};
    if (offersSource !== null) patch.offersSource = offersSource;
    if (placementInput) {
      // updatedAt não muda aqui: o editor espera a reescrita do worker (polling em landingUpdatedAt).
      const resolved = resolveOffersPlacement(current.htmlBody ?? '', placementInput);
      placement = resolved.placement;
      patch.ctaConfig = mergeOffersPlacement(current.ctaConfig, resolved.placement);
      if (resolved.html !== (current.htmlBody ?? '')) patch.htmlBody = resolved.html;
    }
    await tx
      .update(landingPages)
      .set(patch)
      .where(and(eq(landingPages.id, params.id), eq(landingPages.storeId, STORE_ID)));
  });

  // Dispara apply-bundle no worker pra reescrever html_body com preços/qty novos.
  // Sem isso, storefront serve HTML com preços antigos (offers no banco != HTML servido).
  const enqueue = await enqueueApplyBundle(params.id, 'bundle-offers-save');

  return NextResponse.json({
    ok: true,
    count: body.offers.length,
    placement,
    reprocessing: enqueue.queued,
    jobId: enqueue.jobId,
    deduped: enqueue.deduped ?? false,
    reprocessSkipped: !enqueue.queued ? enqueue.reason : undefined,
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;

  const landing = await fetchLanding(params.id);
  if (!landing) return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });

  let body: { useNewBundleEngine?: boolean };
  try {
    body = (await req.json()) as { useNewBundleEngine?: boolean };
  } catch {
    return NextResponse.json({ ok: false, message: 'JSON inválido' }, { status: 400 });
  }

  const db = getDb();
  await db
    .update(landingPages)
    .set({
      ...(typeof body.useNewBundleEngine === 'boolean'
        ? { useNewBundleEngine: body.useNewBundleEngine }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(landingPages.id, params.id), eq(landingPages.storeId, STORE_ID)));

  // Reprocessa HTML para refletir mudança de engine no storefront.
  const enqueue = await enqueueApplyBundle(params.id, 'toggle-bundle-engine');

  return NextResponse.json({ ok: true, reprocessing: enqueue.queued, jobId: enqueue.jobId });
}
