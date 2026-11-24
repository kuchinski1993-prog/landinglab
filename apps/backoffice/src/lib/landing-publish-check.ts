// Story 0.6 (AC6) — checklist de pré-publicação da landing.
//
// Mesmo formato do checklist do VSL (packages/vsl-hosting/src/publish-check.ts):
// `{ code, ok, severity: 'blocking' | 'warning', message, fixHint?, fixUrl? }`.
// O mesmo avaliador é usado:
//   - pela publicação (publishLandingCore) — item bloqueante reprovado → 422
//     PUBLISH_CHECK_FAILED, nada é gravado;
//   - por GET /api/landing-pages/[id]/publish-check — a UI mostra ANTES de publicar;
//   - por scripts/publish-check-impact.ts — lista quem seria bloqueado.
//
// Política (QA 0.6 F4, decisão do orquestrador): só BLOQUEIA o que
// comprovadamente quebra a venda — botão de compra morto (card sem variante,
// variante/oferta sem preço ou sem vínculo com o checkout) e checkout sem
// provedor configurado (Stripe sem mercado/conta). Regras com risco de falso
// positivo viram AVISO (aparecem, não bloqueiam): landing_kind 'unknown' sem
// variantes, moeda × mercado na Shopify, e a janela logo depois de "Criar
// produto Shopify" (o apply-bundle ainda está ligando os cards).
// Função pura — o carregamento dos dados vive em publish-store.ts.
//
// Story 16.3 — provider `external` (checkout do produtor): bloqueia sem nenhum kit válido
// ("checkout externo não configurado"); avisa kits 1/3/5 ausentes, botões sem kit
// identificável (usam o kit padrão) e CTAs com destino interno (`/checkout`, `/cart`,
// `button` sem `href`) — limitação conhecida de clones SPA (AC 18).

import {
  configuredExternalKits,
  missingExternalKits,
  resolveDefaultKit,
  type ExternalCheckoutConfig,
} from '@blackshop/shared/external-checkout';
import { hasSystemOffersPlacement } from '@blackshop/shared/landing-offers';

export type LandingPublishCheckCode =
  | 'html_present'
  | 'currency_matches_market'
  | 'stripe_market_set'
  | 'stripe_market_active'
  | 'stripe_account_active'
  | 'checkout_price_set'
  | 'checkout_logo_set'
  | 'offers_priced'
  | 'offers_linked_to_shopify'
  | 'variants_present'
  | 'variants_priced'
  | 'variants_linked_to_shopify'
  | 'cards_without_variant_id'
  | 'cards_point_to_existing_variants'
  | 'external_checkout_configured'
  | 'external_kits_complete'
  | 'external_ctas_kit_resolved'
  | 'external_internal_ctas'
  | 'offers_without_destination'
  | 'offers_system_placement';

export type LandingPublishCheckSeverity = 'blocking' | 'warning';

export interface LandingPublishCheckItem {
  code: LandingPublishCheckCode;
  ok: boolean;
  severity: LandingPublishCheckSeverity;
  message: string;
  /** Ação com o caminho exato na UI (só em itens pendentes). */
  fixHint?: string;
  /** Link interno para resolver (só em itens pendentes). */
  fixUrl?: string;
}

export interface LandingPublishCheckResult {
  landingId: string;
  /** `true` quando nenhum item bloqueante reprovou (avisos não contam). */
  ready: boolean;
  items: LandingPublishCheckItem[];
}

/** Dados que o checklist precisa (lidos do banco por publish-store.ts). */
export interface PublishCheckSnapshot {
  landingId: string;
  /** 'shopify' | 'stripe' | 'external' (CHECK no banco, migration 0110). */
  checkoutProvider: string;
  /** Story 16.3 — `cta_config.externalCheckout` revalidado (só usado com provider `external`). */
  externalCheckout?: ExternalCheckoutConfig;
  /** 'advertorial' | 'sales_page' | 'unknown'. Advertorial não tem checkout. */
  landingKind: string;
  htmlBody: string;
  currency: string;
  /** landing_pages.price (numeric → string). */
  price: string | number | null;
  marketId: string | null;
  market: { status: string; currency: string; name: string } | null;
  checkoutLogoUrl: string | null;
  /** landing_pages.use_new_bundle_engine — o storefront só injeta ofertas com o flag ligado. */
  useNewBundleEngine: boolean;
  variants: Array<{
    id: string;
    name: string;
    price: string | number;
    productVariantId: string | null;
    mirrorVariantId: string | null;
  }>;
  /** Última criação/alteração de landing_variants (janela pós "Criar produto Shopify"). */
  variantsChangedAt?: Date | string | null;
  offers: Array<{
    position: number;
    title: string;
    priceCents: number;
    variantId: string | null;
    /** Story 25.1 — link próprio da oferta (prioridade sobre o provider). */
    checkoutUrl?: string | null;
  }>;
  hasActiveStripeAccount: boolean;
  /** Story 25.1 — `landing_pages.offers_source` ('page' | 'system'). */
  offersSource?: string;
  /** Story 25.1 — resultado da última resolução da posição do bloco do sistema. */
  offersPlacement?: { anchorOk?: boolean; removeOk?: boolean | null };
}

function hasOfferLink(o: { checkoutUrl?: string | null }): boolean {
  return Boolean(o.checkoutUrl?.trim());
}

/**
 * Janela depois de criar/alterar as variantes em que cards ainda sem
 * `data-landing-variant-id` são só AVISO: o apply-bundle (reenfileirado pela
 * criação do produto e de novo ao publicar) liga os cards em segundos.
 */
export const RECENT_VARIANTS_WINDOW_MS = 15 * 60 * 1000;

const VARIANT_ID_ATTR_RE = /data-landing-variant-id\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/** Valores de `data-landing-variant-id` presentes no HTML salvo. */
export function extractCardVariantIds(html: string): string[] {
  const ids: string[] = [];
  for (const match of html.matchAll(VARIANT_ID_ATTR_RE)) {
    const value = (match[1] ?? match[2] ?? '').trim();
    ids.push(value);
  }
  return ids;
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function listNames(names: string[], max = 3): string {
  const shown = names.slice(0, max).map((n) => `"${n}"`).join(', ');
  return names.length > max ? `${shown} e mais ${names.length - max}` : shown;
}

/** Caminhos da UI usados nos fixHint/fixUrl. */
const UI = {
  editor: (id: string) => `/landing-pages/${id}/editor`,
  editKind: (id: string) => `/landing-pages/${id}/edit`,
  stripeSettings: '/settings?tab=stripe',
  marketsSettings: '/settings?tab=markets',
};

type Adder = (
  code: LandingPublishCheckCode,
  severity: LandingPublishCheckSeverity,
  ok: boolean,
  message: string,
  fixHint: string,
  fixUrl?: string,
) => void;

/**
 * Avalia o checklist. Pura e determinística (testes de tabela); `now` só é
 * usado para a janela pós-criação do produto.
 */
export function evaluatePublishCheck(
  snapshot: PublishCheckSnapshot,
  now: Date = new Date(),
): LandingPublishCheckResult {
  const items: LandingPublishCheckItem[] = [];
  const add: Adder = (code, severity, ok, message, fixHint, fixUrl) =>
    items.push({ code, ok, severity, message, ...(ok ? {} : { fixHint, ...(fixUrl ? { fixUrl } : {}) }) });
  const id = snapshot.landingId;

  // ── Comuns ────────────────────────────────────────────────────────────
  const htmlOk = (snapshot.htmlBody ?? '').trim().length >= 10;
  add(
    'html_present',
    'blocking',
    htmlOk,
    htmlOk ? 'A página tem conteúdo.' : 'A página ainda está vazia (sem HTML).',
    'Landing pages › abra a landing › Editor: aguarde o clone/geração terminar (o status aparece no topo do editor) e clique em "Conferir de novo".',
    UI.editor(id),
  );

  // Advertorial não vende: o botão leva para a página de vendas.
  if (snapshot.landingKind === 'advertorial') {
    return finish(id, items);
  }

  evaluateOffersMode(snapshot, add);

  // Story 16.3: checkout do produtor — nada de Stripe/Shopify/mercado.
  if (snapshot.checkoutProvider === 'external') {
    evaluateExternal(snapshot, add);
    return finish(id, items);
  }

  const isStripe = snapshot.checkoutProvider === 'stripe';

  if (snapshot.marketId) {
    const marketCurrency = snapshot.market?.currency ?? null;
    const ok = marketCurrency !== null && marketCurrency === snapshot.currency;
    // Stripe recusa a compra com moeda divergente (stripe-checkout.service);
    // na Shopify o checkout cobra na moeda da loja — só aviso.
    add(
      'currency_matches_market',
      isStripe ? 'blocking' : 'warning',
      ok,
      ok
        ? `Moeda da landing (${snapshot.currency}) igual à do mercado.`
        : marketCurrency
          ? `A moeda da landing (${snapshot.currency}) é diferente da moeda do mercado "${snapshot.market?.name ?? ''}" (${marketCurrency}).`
          : 'O mercado escolhido para a landing não existe mais.',
      'Editor da landing › seção "Mercado e checkout" › escolha o mercado e clique em Salvar — a moeda da landing é sincronizada com a do mercado.',
      UI.editor(id),
    );
  }

  if (isStripe) {
    evaluateStripe(snapshot, add);
  } else {
    evaluateShopify(snapshot, add, now);
  }

  return finish(id, items);
}

/** Story 25.1 — posição do bloco do sistema (AC 7, 10). */
function evaluateOffersMode(snapshot: PublishCheckSnapshot, add: Adder): void {
  if (snapshot.offersSource !== 'system' || snapshot.offers.length === 0) return;
  const id = snapshot.landingId;
  const placed = hasSystemOffersPlacement(snapshot.htmlBody ?? '');
  const anchorFailed = snapshot.offersPlacement?.anchorOk === false;
  const removeFailed = snapshot.offersPlacement?.removeOk === false;
  const ok = placed && !anchorFailed && !removeFailed;
  add(
    'offers_system_placement',
    'warning',
    ok,
    ok
      ? 'O bloco de ofertas do sistema tem posição na página.'
      : !placed || anchorFailed
        ? '"Usar minhas ofertas" está ligado, mas o bloco do sistema não tem posição na página — a landing vai mostrar as ofertas originais.'
        : 'O seletor do bloco a remover não casou com exatamente 1 elemento (ou era body/main/html) — nada foi removido.',
    'Editor da landing › seção "Bundles / Ofertas" › "Posição do bloco do sistema": escolha "abaixo do preço", "abaixo do título" ou um seletor CSS que case com 1 elemento, e salve.',
    UI.editor(id),
  );
}

/** Ofertas sem link próprio e sem destino no provider (AC 11) — Stripe e external. */
function addOffersWithoutDestination(
  snapshot: PublishCheckSnapshot,
  add: Adder,
  hasProviderDestination: (o: PublishCheckSnapshot['offers'][number]) => boolean,
  fixHint: string,
): void {
  if (snapshot.offers.length === 0) return;
  const dead = snapshot.offers.filter((o) => !hasOfferLink(o) && !hasProviderDestination(o));
  add(
    'offers_without_destination',
    'warning',
    dead.length === 0,
    dead.length === 0
      ? 'Todas as ofertas têm destino de compra.'
      : `Oferta(s) sem destino: ${listNames(dead.map((o) => o.title || `posição ${o.position}`))} — o botão não navega.`,
    fixHint,
    UI.editor(snapshot.landingId),
  );
}

function evaluateStripe(snapshot: PublishCheckSnapshot, add: Adder): void {
  const id = snapshot.landingId;
  const hasMarket = Boolean(snapshot.marketId);
  add(
    'stripe_market_set',
    'blocking',
    hasMarket,
    hasMarket ? 'Mercado do checkout definido.' : 'A landing usa checkout Stripe, mas não tem mercado definido — o checkout recusaria a compra.',
    'Editor da landing › seção "Mercado e checkout" › campo Mercado › escolha o mercado (país, idioma e moeda) e clique em Salvar.',
    UI.editor(id),
  );
  if (hasMarket) {
    const active = snapshot.market?.status === 'active';
    add(
      'stripe_market_active',
      'blocking',
      active,
      active ? 'Mercado ativo.' : 'O mercado da landing está desativado — o checkout recusaria a compra.',
      'Configurações › aba Mercados › reative o mercado (ou escolha outro mercado ativo em Editor › "Mercado e checkout").',
      UI.marketsSettings,
    );
  }
  add(
    'stripe_account_active',
    'blocking',
    snapshot.hasActiveStripeAccount,
    snapshot.hasActiveStripeAccount
      ? 'Há conta Stripe ativa para receber.'
      : 'Nenhuma conta Stripe ativa — o checkout não consegue cobrar.',
    'Configurações › aba Stripe › ative (ou cadastre) uma conta antes de publicar.',
    UI.stripeSettings,
  );
  const pricedOffer = snapshot.offers.some((o) => o.priceCents > 0);
  const priced = pricedOffer || toNumber(snapshot.price) > 0;
  add(
    'checkout_price_set',
    'blocking',
    priced,
    priced ? 'Preço de venda definido.' : 'Nenhuma oferta com preço e a landing está com preço zero — o botão de compra não tem o que cobrar.',
    'Editor da landing › seção "Bundles / Ofertas" (preço de cada oferta) ou seção "Preços" › Editar.',
    UI.editor(id),
  );
  const hasLogo = Boolean(snapshot.checkoutLogoUrl?.trim());
  add(
    'checkout_logo_set',
    'warning',
    hasLogo,
    hasLogo ? 'Logo do checkout enviado.' : 'O checkout vai mostrar o nome da marca no lugar do logo.',
    'Editor da landing › seção "Mercado e checkout" › "Cabeçalho do checkout" › envie o logo.',
    UI.editor(id),
  );
  addOffersWithoutDestination(
    snapshot,
    add,
    (o) => o.priceCents > 0,
    'Editor da landing › seção "Bundles / Ofertas" › preencha o preço ou o "Link do botão" da oferta e salve.',
  );
}

const OPEN_TAG_RE = /<(a|button)\b[^>]*>/gi;
const ATTR = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
};
const INTERNAL_CHECKOUT_HREF_RE = /^\/(checkouts?|cart)(\/|\?|#|$)/i;

/** Descrição curta de um CTA para a lista do publish-check (id/classe/href). */
function describeCta(tagName: string, tag: string): string {
  const idAttr = ATTR(tag, 'id');
  if (idAttr) return `${tagName}#${idAttr}`;
  const href = ATTR(tag, 'href');
  if (href !== null) return `${tagName}[href="${href}"]`;
  const cls = (ATTR(tag, 'class') ?? '').trim().split(/\s+/).filter(Boolean)[0];
  return cls ? `${tagName}.${cls}` : tagName;
}

/** CTAs de compra sem kit e CTAs com destino interno no HTML salvo (Story 16.3, AC 5/18). */
export function scanExternalCtas(html: string): { withoutKit: string[]; internal: string[] } {
  const withoutKit: string[] = [];
  const internal: string[] = [];
  for (const match of html.matchAll(OPEN_TAG_RE)) {
    const tag = match[0];
    const tagName = (match[1] ?? '').toLowerCase();
    const isBuy = (ATTR(tag, 'data-landing-cta') ?? '').toLowerCase() === 'buy';
    const hasKit = ATTR(tag, 'data-landing-kit') !== null || ATTR(tag, 'data-landing-pots') !== null;
    const href = ATTR(tag, 'href');
    if (isBuy && !hasKit) withoutKit.push(describeCta(tagName, tag));
    if (tagName === 'a' && href !== null && INTERNAL_CHECKOUT_HREF_RE.test(href.trim())) internal.push(describeCta(tagName, tag));
    else if (tagName === 'button' && isBuy) internal.push(describeCta(tagName, tag));
  }
  const uniq = (list: string[]) => Array.from(new Set(list));
  return { withoutKit: uniq(withoutKit), internal: uniq(internal) };
}

function evaluateExternal(snapshot: PublishCheckSnapshot, add: Adder): void {
  const id = snapshot.landingId;
  const config = snapshot.externalCheckout ?? {};
  const configured = configuredExternalKits(config);
  const where = 'Editor da landing › seção "Mercado e checkout" › Checkout externo › preencha as URLs (https) de 1, 3 e 5 potes e clique em Salvar.';
  // Story 25.1: com link próprio em todas as ofertas, o mapa por kit não é obrigatório.
  const allOffersLinked = snapshot.offers.length > 0 && snapshot.offers.every(hasOfferLink);
  add(
    'external_checkout_configured',
    'blocking',
    configured.length > 0 || allOffersLinked,
    configured.length > 0
      ? `Checkout externo configurado (${configured.map((k) => `${k} ${k === '1' ? 'pote' : 'potes'}`).join(', ')}).`
      : allOffersLinked
        ? 'Todas as ofertas têm link próprio do botão.'
        : 'Checkout externo não configurado — os botões de compra não teriam para onde levar.',
    where,
    UI.editor(id),
  );
  addOffersWithoutDestination(
    snapshot,
    add,
    () => configured.length > 0,
    'Editor da landing › seção "Bundles / Ofertas" › preencha o "Link do botão" da oferta, ou configure o checkout externo em "Mercado e checkout".',
  );
  if (configured.length === 0) return;

  const missing = missingExternalKits(config);
  add(
    'external_kits_complete',
    'warning',
    missing.length === 0,
    missing.length === 0
      ? 'Checkouts de 1, 3 e 5 potes configurados.'
      : `Kit(s) sem checkout: ${missing.map((k) => `${k} ${k === '1' ? 'pote' : 'potes'}`).join(', ')} — botões desse kit usam o kit padrão.`,
    where,
    UI.editor(id),
  );

  const scan = scanExternalCtas(snapshot.htmlBody ?? '');
  const def = resolveDefaultKit(config);
  add(
    'external_ctas_kit_resolved',
    'warning',
    scan.withoutKit.length === 0,
    scan.withoutKit.length === 0
      ? 'Os botões de compra indicam o kit.'
      : `${scan.withoutKit.length} botão(ões) de compra sem kit no HTML (${listNames(scan.withoutKit)}) — sem bundle selecionado, levam ao kit padrão (${def} ${def === '1' ? 'pote' : 'potes'}).`,
    'Confira o kit padrão em "Mercado e checkout" › Checkout externo, ou marque o botão com data-landing-kit="1|3|5".',
    UI.editor(id),
  );
  add(
    'external_internal_ctas',
    'warning',
    scan.internal.length === 0,
    scan.internal.length === 0
      ? 'Nenhum botão com destino interno (/checkout, /cart).'
      : `Botão(ões) com destino interno: ${listNames(scan.internal)}. O checkout externo intercepta esses cliques e leva ao kit; em clones de SPA (React) confira no ar — se não funcionar, reescreva os CTAs na seção CTAs.`,
    'Editor da landing › seção CTAs › reescreva o destino dos botões listados para o checkout do kit, depois clique em "Conferir de novo".',
    UI.editor(id),
  );
}

function isRecent(changedAt: Date | string | null | undefined, now: Date): boolean {
  if (!changedAt) return false;
  const t = new Date(changedAt).getTime();
  return Number.isFinite(t) && now.getTime() - t >= 0 && now.getTime() - t < RECENT_VARIANTS_WINDOW_MS;
}

function evaluateShopify(snapshot: PublishCheckSnapshot, add: Adder, now: Date): void {
  const id = snapshot.landingId;
  // Engine V2: o storefront anota os cards em tempo de execução a partir de
  // landing_bundle_offers (variantId Shopify). Sem o flag ou sem ofertas, vale o
  // caminho clássico: landing_variants + cards anotados no HTML (playbook §14).
  if (snapshot.useNewBundleEngine && snapshot.offers.length > 0) {
    const unpriced = snapshot.offers.filter((o) => !(o.priceCents > 0));
    add(
      'offers_priced',
      'blocking',
      unpriced.length === 0,
      unpriced.length === 0
        ? 'Todas as ofertas têm preço.'
        : `Oferta(s) sem preço: ${listNames(unpriced.map((o) => o.title || `posição ${o.position}`))}.`,
      'Editor da landing › seção "Bundles / Ofertas" › preencha o preço de cada oferta e salve.',
      UI.editor(id),
    );
    // Story 25.1: oferta com link próprio não depende da variante Shopify.
    const unlinked = snapshot.offers.filter((o) => !o.variantId?.trim() && !hasOfferLink(o));
    add(
      'offers_linked_to_shopify',
      'blocking',
      unlinked.length === 0,
      unlinked.length === 0
        ? 'Todas as ofertas estão ligadas a uma variante da Shopify ou têm link próprio.'
        : `Oferta(s) sem destino: os botões de compra de ${listNames(unlinked.map((o) => o.title || `posição ${o.position}`))} não estão ligados a uma variante da Shopify nem têm link próprio (botão morto).`,
      'Editor da landing › seção Publicação › "Publicar landing + criar produto Shopify" (cria as variantes e liga as ofertas) — ou preencha o ID da variante ou o "Link do botão" em "Bundles / Ofertas".',
      UI.editor(id),
    );
    return;
  }

  const hasVariants = snapshot.variants.length > 0;
  // landing_kind 'unknown' pode ser advertorial legado não classificado → aviso.
  const unknownKind = snapshot.landingKind === 'unknown';
  add(
    'variants_present',
    unknownKind ? 'warning' : 'blocking',
    hasVariants,
    hasVariants
      ? `${snapshot.variants.length} variante(s) cadastrada(s).`
      : unknownKind
        ? 'A landing não tem variantes de produto e o tipo dela não foi classificado — se for página de vendas, o botão de compra fica morto.'
        : 'A landing não tem variantes de produto — o botão de compra não tem o que vender.',
    unknownKind
      ? 'Se for advertorial: Editor da landing › banner "Tipo não classificado" › "Editar tipo" › Advertorial. Se for página de vendas: Editor da landing › seção "Bundles / Ofertas" › cadastre as ofertas e clique em "Ligar Engine V2"; depois, na seção Publicação, use "Publicar landing + criar produto Shopify" (cria o produto e liga cada oferta a uma variante).'
      : 'Editor da landing › seção "Bundles / Ofertas" › cadastre as ofertas e clique em "Ligar Engine V2"; depois, na seção Publicação, use "Publicar landing + criar produto Shopify" (cria o produto e liga cada oferta a uma variante).',
    unknownKind ? UI.editKind(id) : UI.editor(id),
  );
  if (!hasVariants) return;

  const unpriced = snapshot.variants.filter((v) => !(toNumber(v.price) > 0));
  add(
    'variants_priced',
    'blocking',
    unpriced.length === 0,
    unpriced.length === 0 ? 'Todas as variantes têm preço.' : `Variante(s) sem preço: ${listNames(unpriced.map((v) => v.name))}.`,
    'Editor da landing › seção "Preços" › Editar (ou o preço de cada oferta em "Bundles / Ofertas").',
    UI.editor(id),
  );

  const unlinked = snapshot.variants.filter((v) => !v.productVariantId || !v.mirrorVariantId?.trim());
  add(
    'variants_linked_to_shopify',
    'blocking',
    unlinked.length === 0,
    unlinked.length === 0
      ? 'Todas as variantes estão ligadas à Shopify.'
      : `Variante(s) sem ligação com a Shopify: ${listNames(unlinked.map((v) => v.name))}. O checkout não sabe o que cobrar (botão morto).`,
    'Variante sem vínculo com a Shopify não é cobrável. Editor da landing › seção "Bundles / Ofertas" › cadastre as ofertas e clique em "Ligar Engine V2"; depois, na seção Publicação, use "Publicar landing + criar produto Shopify" (cria o produto e liga cada oferta a uma variante).',
    UI.editor(id),
  );

  // Janela pós-criação: o apply-bundle ainda pode estar ligando os cards.
  const recent = isRecent(snapshot.variantsChangedAt, now);
  const recentHint =
    'As variantes foram criadas/alteradas há pouco: o apply-bundle liga os cards sozinho em alguns segundos (e é reenfileirado ao publicar). Aguarde 1 minuto e clique em "Conferir de novo".';

  const cardIds = extractCardVariantIds(snapshot.htmlBody ?? '');
  const annotated = cardIds.filter((v) => v.length > 0);
  add(
    'cards_without_variant_id',
    recent ? 'warning' : 'blocking',
    annotated.length > 0,
    annotated.length > 0
      ? 'Os botões de compra estão ligados às variantes.'
      : recent
        ? 'Os botões de compra ainda não foram ligados às variantes recém-criadas.'
        : 'Os botões de compra não estão ligados às variantes — clicar mostraria "Este botão ainda não foi configurado" (botão morto).',
    recent
      ? recentHint
      : 'Editor da landing › seção "Bundles / Ofertas" › cadastre as ofertas e clique em "Ligar Engine V2"; depois, na seção Publicação, use "Publicar landing + criar produto Shopify" (cria o produto e liga cada oferta a uma variante). Depois clique em "Conferir de novo".',
    UI.editor(id),
  );
  if (annotated.length === 0) return;

  const known = new Set(snapshot.variants.map((v) => v.id));
  const orphans = Array.from(new Set(annotated.filter((v) => !known.has(v))));
  add(
    'cards_point_to_existing_variants',
    recent ? 'warning' : 'blocking',
    orphans.length === 0,
    orphans.length === 0
      ? 'Todos os botões apontam para variantes existentes.'
      : `${orphans.length} botão(ões) apontam para variante(s) que não existem mais (${listNames(orphans, 2)}) — botão morto.`,
    recent
      ? recentHint
      : 'Os cards estão ligados a variantes antigas. Editor da landing › seção "Bundles / Ofertas" › cadastre as ofertas e clique em "Ligar Engine V2"; depois, na seção Publicação, use "Publicar landing + criar produto Shopify" (cria o produto e liga cada oferta a uma variante).',
    UI.editor(id),
  );
}

function finish(landingId: string, items: LandingPublishCheckItem[]): LandingPublishCheckResult {
  return { landingId, ready: blockingFailures(items).length === 0, items };
}

/** Itens que impedem a publicação (avisos nunca entram). */
export function blockingFailures(items: LandingPublishCheckItem[]): LandingPublishCheckItem[] {
  return items.filter((item) => !item.ok && item.severity === 'blocking');
}
