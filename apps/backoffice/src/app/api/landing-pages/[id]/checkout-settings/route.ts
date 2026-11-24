// GET  /api/landing-pages/[id]/checkout-settings
// POST /api/landing-pages/[id]/checkout-settings  { market_id, checkout_provider }
//
// Story 15.2 — mercado (idioma/moeda/frete) + provider de checkout da landing.
// Ao escolher um mercado com outra moeda, a moeda da landing é reescrita no
// HTML e no banco (mesma rotina do editor de preço) e o apply-bundle é
// reenfileirado. Trocar para 'stripe' exige o checklist completo (D19).
//
// Story 15.6 (AC2) — `subscription` (Subscribe & Save sem selling plan, só em
// landing Stripe): subs_enabled, subs_preselected, subs_discount_percent,
// subs_interval, subs_interval_count. Ligada exige intervalo e preço
// recorrente > 0 em todas as ofertas com preço. Salvar reprocessa o HTML
// (apply-bundle injeta o widget); a landing publicada precisa ser republicada.
// `market_id` ausente no corpo = mantém o mercado atual.
//
// Story 15.7 — imagem do produto e header do checkout (logo/altura/alinhamento
// + nome da marca = brand_to). Corpo só com esses campos (sem market_id,
// checkout_provider e subscription) grava só a aparência: não revalida o
// checklist Stripe nem mexe em mercado/moeda — é o salvamento automático do
// upload no editor. Logo: só URL https do Storage do projeto (upload do editor).
// Sem imagem enviada o checkout mostra um quadro neutro (sem imagem do clone).
//
// Story 16.3 — `checkout_provider: 'external'` (checkout do produtor) + `external_checkout`
// ({ "1"|"3"|"5": url https, default?, allowSphereTracker? }) validado pelo validador único de
// `@blackshop/shared/external-checkout` e gravado em `cta_config.externalCheckout` sem apagar
// `mappings`/`lastRewriteAt`. URL inválida = 400 com kit e motivo (nada gravado). Assinatura
// não existe em `external`.

import { landingBundleOffers, landingMarkets, landingPages, stripeAccounts } from '@blackshop/db';
import {
  CHECKOUT_LOGO_HEIGHT,
  cleanProductName,
  isCheckoutLogoAlign,
  isProjectStorageUrl,
  isValidCheckoutLogoHeight,
} from '@blackshop/payments/checkout';
import { stripeCheckoutReadiness, type ReadinessIssue } from '@blackshop/payments/markets';
import {
  isCheckoutProvider,
  mergeExternalCheckoutIntoCtaConfig,
  normalizeCheckoutProvider,
  parseExternalCheckoutInput,
  readExternalCheckoutConfig,
  type CheckoutProvider,
  type ExternalCheckoutConfig,
} from '@blackshop/shared/external-checkout';
import { and, asc, count, eq, gt } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { requireAdminRequest } from '@/lib/admin/auth-guard';
import { enqueueApplyBundle } from '@/lib/enqueue-apply-bundle';
import { applySetPriceCurrency } from '@/lib/landing-currency-html';
import { getDb } from '@/lib/landing-db';
import {
  parseStripeSubscriptionInput,
  recurringPreview,
  stripeSubscriptionIssues,
  type OfferForPreview,
  type StripeSubscriptionSettings,
} from '@/lib/landing-subscription-settings';

const STORE_ID = 'l0i';

export const runtime = 'nodejs';
export const maxDuration = 20;

type Provider = CheckoutProvider;

interface Body {
  market_id?: string | null;
  checkout_provider?: Provider;
  /** Story 15.3 — nome/imagem no checkout (string vazia = volta ao padrão). */
  checkout_product_name?: string | null;
  checkout_product_image?: string | null;
  /** Story 15.7 — header do checkout: logo (URL do upload), altura e alinhamento. */
  checkout_logo_url?: string | null;
  checkout_logo_height?: number;
  checkout_logo_align?: string;
  /** Story 15.7 — nome da marca (brand_to): header sem logo e alt do logo. */
  brand_name?: string | null;
  /** Story 15.6 — assinatura Stripe (snake_case; ver parseStripeSubscriptionInput). */
  subscription?: unknown;
  /** Story 16.3 — mapa kit->URL do checkout externo (só com provider `external`). */
  external_checkout?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadLanding(id: string) {
  const [row] = await getDb()
    .select({
      id: landingPages.id,
      htmlBody: landingPages.htmlBody,
      currency: landingPages.currency,
      price: landingPages.price,
      marketId: landingPages.marketId,
      checkoutProvider: landingPages.checkoutProvider,
      ctaConfig: landingPages.ctaConfig,
      title: landingPages.title,
      checkoutProductName: landingPages.checkoutProductName,
      checkoutProductImage: landingPages.checkoutProductImage,
      checkoutLogoUrl: landingPages.checkoutLogoUrl,
      checkoutLogoHeight: landingPages.checkoutLogoHeight,
      checkoutLogoAlign: landingPages.checkoutLogoAlign,
      brandTo: landingPages.brandTo,
      subsEnabled: landingPages.subsEnabled,
      subsPreselected: landingPages.subsPreselected,
      subsDiscountPercent: landingPages.subsDiscountPercent,
      subsInterval: landingPages.subsInterval,
      subsIntervalCount: landingPages.subsIntervalCount,
      subsSellingPlanId: landingPages.subsSellingPlanId,
    })
    .from(landingPages)
    .where(and(eq(landingPages.id, id), eq(landingPages.storeId, STORE_ID)))
    .limit(1);
  return row ?? null;
}

async function readinessContext(landingId: string) {
  const db = getDb();
  const [accounts] = await db
    .select({ n: count() })
    .from(stripeAccounts)
    .where(and(eq(stripeAccounts.storeId, STORE_ID), eq(stripeAccounts.status, 'active')));
  const [offers] = await db
    .select({ n: count() })
    .from(landingBundleOffers)
    .where(and(eq(landingBundleOffers.landingPageId, landingId), gt(landingBundleOffers.priceCents, 0)));
  return {
    activeStripeAccounts: Number(accounts?.n ?? 0),
    // Story 15.3: o botão do checkout Stripe vive no runtime de bundles —
    // exige ofertas (landing_bundle_offers) com preço.
    pricedOffers: Number(offers?.n ?? 0),
  };
}

async function listOffers(landingId: string): Promise<OfferForPreview[]> {
  const rows = await getDb()
    .select({
      id: landingBundleOffers.id,
      position: landingBundleOffers.position,
      title: landingBundleOffers.title,
      qty: landingBundleOffers.qty,
      priceCents: landingBundleOffers.priceCents,
    })
    .from(landingBundleOffers)
    .where(eq(landingBundleOffers.landingPageId, landingId))
    .orderBy(asc(landingBundleOffers.position));
  return rows;
}

async function listMarkets() {
  return getDb()
    .select({
      id: landingMarkets.id,
      name: landingMarkets.name,
      currency: landingMarkets.currency,
      locale: landingMarkets.locale,
      status: landingMarkets.status,
      countryCodes: landingMarkets.countryCodes,
    })
    .from(landingMarkets)
    .where(eq(landingMarkets.storeId, STORE_ID))
    .orderBy(asc(landingMarkets.name));
}

export async function GET(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;

  const landing = await loadLanding(params.id);
  if (!landing) return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });

  const markets = await listMarkets();
  const market = markets.find((m) => m.id === landing.marketId) ?? null;
  const ctx = await readinessContext(landing.id);
  const issues = stripeCheckoutReadiness({ market, landingCurrency: landing.currency, ...ctx });
  const offers = await listOffers(landing.id);
  const preview = recurringPreview(offers, landing.subsDiscountPercent);

  return NextResponse.json({
    ok: true,
    market_id: landing.marketId,
    checkout_provider: normalizeCheckoutProvider(landing.checkoutProvider),
    // Story 16.3 — mapa kit->URL revalidado (vazio se não configurado).
    external_checkout: readExternalCheckoutConfig(landing.ctaConfig),
    currency: landing.currency,
    markets: markets.map((m) => ({
      id: m.id,
      name: m.name,
      currency: m.currency,
      locale: m.locale,
      status: m.status,
      country_codes: m.countryCodes,
    })),
    stripe_ready: issues.length === 0,
    stripe_issues: issues,
    checkout_product_name: landing.checkoutProductName,
    checkout_product_name_default: cleanProductName(landing.title),
    checkout_product_image: landing.checkoutProductImage,
    // Story 15.7 — header do checkout.
    checkout_logo_url: landing.checkoutLogoUrl ?? null,
    checkout_logo_height: landing.checkoutLogoHeight ?? CHECKOUT_LOGO_HEIGHT.default,
    checkout_logo_align: landing.checkoutLogoAlign ?? 'left',
    brand_name: landing.brandTo ?? null,
    // Story 15.6 — assinatura Stripe (Subscribe & Save sem selling plan).
    subscription: {
      enabled: landing.subsEnabled,
      preselected: landing.subsPreselected,
      discount_percent: landing.subsDiscountPercent,
      interval: landing.subsInterval,
      interval_count: landing.subsIntervalCount,
      selling_plan_saved: Boolean(landing.subsSellingPlanId),
    },
    offers: preview.map((r) => ({
      id: r.offerId,
      position: r.position,
      title: r.title,
      qty: r.qty,
      price_minor: r.priceMinor,
      recurring_minor: r.recurringMinor,
    })),
  });
}

export async function POST(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, message: 'JSON inválido' }, { status: 400 });
  }

  const provider: Provider | undefined = body.checkout_provider;
  if (provider !== undefined && !isCheckoutProvider(provider)) {
    return NextResponse.json({ ok: false, message: 'Checkout inválido.' }, { status: 400 });
  }
  let externalCheckout: ExternalCheckoutConfig | null = null;
  if (body.external_checkout !== undefined) {
    const parsed = parseExternalCheckoutInput(body.external_checkout);
    if (!parsed.ok) {
      const first = parsed.errors[0]!;
      const label = first.kit === 'config' || first.kit === 'default' ? '' : ` (kit ${first.kit})`;
      return NextResponse.json(
        { ok: false, message: `Checkout externo inválido${label}: ${first.reason}.`, external_errors: parsed.errors },
        { status: 400 },
      );
    }
    externalCheckout = parsed.config;
  }
  if (body.market_id !== undefined && body.market_id !== null && !UUID_RE.test(body.market_id)) {
    return NextResponse.json({ ok: false, message: 'Mercado inválido.' }, { status: 400 });
  }
  const appearance = parseAppearance(body);
  if (!appearance.ok) return NextResponse.json({ ok: false, message: appearance.message }, { status: 400 });

  let subscription: StripeSubscriptionSettings | null = null;
  if (body.subscription !== undefined) {
    const parsed = parseStripeSubscriptionInput(body.subscription);
    if (!parsed.ok) return NextResponse.json({ ok: false, message: parsed.message }, { status: 400 });
    subscription = parsed.value;
  }

  const landing = await loadLanding(params.id);
  if (!landing) return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });

  // Story 15.7 — só aparência (upload/remoção de imagem, header): grava direto.
  if (
    body.market_id === undefined &&
    body.checkout_provider === undefined &&
    body.subscription === undefined &&
    body.external_checkout === undefined
  ) {
    if (Object.keys(appearance.patch).length === 0) {
      return NextResponse.json({ ok: false, message: 'Nada para salvar.' }, { status: 400 });
    }
    await getDb()
      .update(landingPages)
      .set({ ...appearance.patch, updatedAt: new Date() })
      .where(and(eq(landingPages.id, landing.id), eq(landingPages.storeId, STORE_ID)));
    return NextResponse.json({ ok: true, appearance_only: true, ...appearanceResponse(landing, appearance.patch) });
  }

  const marketId = body.market_id === undefined ? landing.marketId : body.market_id;

  const markets = await listMarkets();
  const market = marketId ? (markets.find((m) => m.id === marketId) ?? null) : null;
  if (marketId && !market) {
    return NextResponse.json({ ok: false, message: 'Mercado não encontrado.' }, { status: 404 });
  }
  if (market && market.status !== 'active' && market.id !== landing.marketId) {
    return NextResponse.json({ ok: false, message: `O mercado "${market.name}" está arquivado.` }, { status: 400 });
  }

  const nextProvider: Provider = provider ?? normalizeCheckoutProvider(landing.checkoutProvider);

  if (externalCheckout && nextProvider !== 'external') {
    return NextResponse.json(
      { ok: false, message: 'O mapa de checkout externo só vale com o provedor "Checkout externo".' },
      { status: 400 },
    );
  }
  if (nextProvider === 'external' && !externalCheckout) {
    const current = readExternalCheckoutConfig(landing.ctaConfig);
    if (!current['1'] && !current['3'] && !current['5']) {
      return NextResponse.json(
        { ok: false, message: 'Informe ao menos 1 checkout externo (1, 3 ou 5 potes).', external_errors: [{ kit: 'config', reason: 'checkout externo não configurado' }] },
        { status: 400 },
      );
    }
  }
  const nextCurrency = market ? market.currency : landing.currency;

  if (nextProvider === 'stripe') {
    const ctx = await readinessContext(landing.id);
    const issues: ReadinessIssue[] = stripeCheckoutReadiness({ market, landingCurrency: nextCurrency, ...ctx });
    if (issues.length > 0) {
      return NextResponse.json(
        { ok: false, message: 'A landing ainda não pode usar o checkout Stripe.', stripe_issues: issues },
        { status: 422 },
      );
    }
  }

  if (subscription) {
    // Landing Shopify continua no fluxo do selling plan (subs-config) — AC2.
    // Story 16.3 — `external` não tem assinatura (checkout é do produtor).
    if (nextProvider === 'external') {
      return NextResponse.json(
        { ok: false, message: 'Assinatura não está disponível com checkout externo.' },
        { status: 400 },
      );
    }
    if (nextProvider !== 'stripe') {
      return NextResponse.json(
        { ok: false, message: 'Assinatura sem selling plan só existe em landing com checkout Stripe.' },
        { status: 400 },
      );
    }
    const subscriptionIssues = stripeSubscriptionIssues(subscription, await listOffers(landing.id));
    if (subscriptionIssues.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          message: 'A assinatura ainda não pode ser ligada.',
          subscription_issues: subscriptionIssues.map((message, i) => ({ code: `subscription_${i}`, message })),
        },
        { status: 422 },
      );
    }
  }

  const patch: Record<string, unknown> = {
    marketId: market?.id ?? null,
    checkoutProvider: nextProvider,
    updatedAt: new Date(),
  };
  Object.assign(patch, appearance.patch);
  if (externalCheckout) patch.ctaConfig = mergeExternalCheckoutIntoCtaConfig(landing.ctaConfig, externalCheckout);
  if (subscription) {
    patch.subsEnabled = subscription.enabled;
    patch.subsPreselected = subscription.enabled && subscription.preselected;
    patch.subsDiscountPercent = subscription.discountPercent;
    patch.subsInterval = subscription.interval;
    patch.subsIntervalCount = subscription.intervalCount;
  }
  const subscriptionChanged =
    subscription !== null &&
    (subscription.enabled !== landing.subsEnabled ||
      (subscription.enabled && subscription.preselected) !== landing.subsPreselected ||
      subscription.discountPercent !== landing.subsDiscountPercent ||
      subscription.interval !== landing.subsInterval ||
      subscription.intervalCount !== landing.subsIntervalCount);
  const currencyChanged = nextCurrency.toUpperCase() !== landing.currency.toUpperCase();
  if (currencyChanged) {
    const rewritten = applySetPriceCurrency(
      landing.htmlBody,
      { operation: 'set-price-currency', currency: nextCurrency },
      landing.currency,
      landing.price,
    );
    patch.htmlBody = rewritten.html;
    Object.assign(patch, rewritten.dbPatch);
  }

  await getDb()
    .update(landingPages)
    .set(patch)
    .where(and(eq(landingPages.id, landing.id), eq(landingPages.storeId, STORE_ID)));

  let reprocessing = false;
  if (currencyChanged || subscriptionChanged) {
    const enqueue = await enqueueApplyBundle(
      landing.id,
      currencyChanged ? 'checkout-settings:market-currency' : 'checkout-settings:subscription',
    );
    reprocessing = enqueue.queued;
  }

  return NextResponse.json({
    ok: true,
    market_id: market?.id ?? null,
    checkout_provider: nextProvider,
    ...(externalCheckout ? { external_checkout: externalCheckout } : {}),
    currency: nextCurrency,
    currency_changed: currencyChanged,
    subscription_changed: subscriptionChanged,
    reprocessing,
  });
}

type AppearancePatch = Partial<{
  checkoutProductName: string | null;
  checkoutProductImage: string | null;
  checkoutLogoUrl: string | null;
  checkoutLogoHeight: number;
  checkoutLogoAlign: string;
  brandTo: string | null;
}>;

/** Nome do produto / imagem / header do checkout (string vazia = volta ao padrão). */
function parseAppearance(body: Body): { ok: true; patch: AppearancePatch } | { ok: false; message: string } {
  const patch: AppearancePatch = {};
  if (body.checkout_product_name !== undefined) {
    const name = (body.checkout_product_name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    patch.checkoutProductName = name || null;
  }
  if (body.checkout_product_image !== undefined) {
    const image = typeof body.checkout_product_image === 'string' ? body.checkout_product_image.trim() : '';
    if (image && !/^https:\/\//.test(image)) return { ok: false, message: 'A imagem precisa ser uma URL https.' };
    patch.checkoutProductImage = image || null;
  }
  if (body.checkout_logo_url !== undefined) {
    const logo = typeof body.checkout_logo_url === 'string' ? body.checkout_logo_url.trim() : '';
    if (logo && !isProjectStorageUrl(logo, process.env['SUPABASE_URL'])) {
      return { ok: false, message: 'O logo precisa ser enviado pelo editor (URL do Storage do projeto).' };
    }
    patch.checkoutLogoUrl = logo || null;
  }
  if (body.checkout_logo_height !== undefined) {
    if (!isValidCheckoutLogoHeight(body.checkout_logo_height)) {
      return {
        ok: false,
        message: `Altura do logo inválida (${CHECKOUT_LOGO_HEIGHT.min}–${CHECKOUT_LOGO_HEIGHT.max} px).`,
      };
    }
    patch.checkoutLogoHeight = body.checkout_logo_height;
  }
  if (body.checkout_logo_align !== undefined) {
    if (!isCheckoutLogoAlign(body.checkout_logo_align)) {
      return { ok: false, message: 'Alinhamento do logo inválido (esquerda, centro ou direita).' };
    }
    patch.checkoutLogoAlign = body.checkout_logo_align;
  }
  if (body.brand_name !== undefined) {
    if (body.brand_name !== null && typeof body.brand_name !== 'string') {
      return { ok: false, message: 'Nome da marca inválido.' };
    }
    const name = (body.brand_name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    patch.brandTo = name || null;
  }
  return { ok: true, patch };
}

function appearanceResponse(
  landing: NonNullable<Awaited<ReturnType<typeof loadLanding>>>,
  patch: AppearancePatch,
) {
  const pick = <K extends keyof AppearancePatch>(key: K, current: AppearancePatch[K]) =>
    key in patch ? patch[key] : current;
  return {
    checkout_product_name: pick('checkoutProductName', landing.checkoutProductName),
    checkout_product_image: pick('checkoutProductImage', landing.checkoutProductImage),
    checkout_logo_url: pick('checkoutLogoUrl', landing.checkoutLogoUrl),
    checkout_logo_height: pick('checkoutLogoHeight', landing.checkoutLogoHeight),
    checkout_logo_align: pick('checkoutLogoAlign', landing.checkoutLogoAlign),
    brand_name: pick('brandTo', landing.brandTo),
  };
}
