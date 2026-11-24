// resolveLanding — lookup landing por hostname + slug.
//
// Fluxo:
//   1. hostname (do request Host header) → landing_domains.domain (role=active)
//   2. slug (do URL path) → landing_domain_bindings (domain_id, slug)
//   3. binding.landing_page_id → landing_pages row com htmlBody
//
// Retorna null quando qualquer etapa falha (domain não cadastrado, blocked,
// slug não bindado, landing arquivada, etc). Middleware trata como 404.
//
// Storefront LandingLab espera:
//   - hostname 'meudominio.com' com binding {slug: ''} → mostra landing default
//   - hostname 'meudominio.com/oferta1' → binding {slug: 'oferta1'}

import { and, eq, sql } from 'drizzle-orm';
import {
  landingBundleOffers,
  landingDomainBindings,
  landingDomains,
  landingPages,
} from '@blackshop/db/schema-landinglab-core';
import {
  normalizeCheckoutProvider,
  readExternalCheckoutConfig,
  type CheckoutProvider,
  type ExternalCheckoutConfig,
} from '@blackshop/shared/external-checkout';

import { getDb } from './db';

export interface BundleOfferInject {
  position: number;
  title: string;
  qty: number;
  priceCents: number;
  compareAtCents: number | null;
  saveText: string | null;
  badge: string | null;
  variantId: string | null;
  isPreselected: boolean;
}

export interface ResolvedLanding {
  landingPageId: string;
  title: string;
  slug: string;
  htmlBody: string;
  customCss: string | null;
  status: string;
  isDefaultRoot: boolean;
  domainId: string;
  domain: string;
  // SEO / metadata fields (Task #44).
  seoTitle: string | null;
  seoDescription: string | null;
  seoImage: string | null;
  mediaUrls: string[];
  contentLanguage: string | null;
  /** Locale do mercado da landing (fallback do idioma do banner de consentimento). */
  marketLocale?: string | null;
  manufacturer: string | null;
  productType: string | null;
  price: string; // numeric → string em drizzle-pg.
  currency: string;
  compareAtPrice: string | null;
  // Bundle Engine V2 (set/2026): quando true, storefront injeta
  // window.__LL_BUNDLE_OFFERS__ com bundleOffers no <head>. Runtime script
  // no HTML clonado popula os data-ll-* dos cards.
  useNewBundleEngine: boolean;
  bundleOffers: BundleOfferInject[];
  // Story 15.3: provider do checkout (decisão final continua no servidor).
  // Story 16.3: `external` = checkout do produtor (navegação direta, sem API de checkout).
  checkoutProvider: CheckoutProvider;
  /** Story 16.3: mapa kit->URL revalidado de `cta_config.externalCheckout` (vazio fora do `external`). */
  externalCheckout: ExternalCheckoutConfig;
}

/**
 * Normaliza hostname removendo porta e www.
 * Ex: 'www.meudominio.com:443' → 'meudominio.com'
 */
export function normalizeHostname(host: string): string {
  return host
    .toLowerCase()
    .replace(/:\d+$/, '') // remove porta
    .replace(/^www\./, ''); // remove www.
}

export async function resolveLanding(
  hostname: string,
  slug: string,
): Promise<ResolvedLanding | null> {
  const db = getDb();
  const normalizedHost = normalizeHostname(hostname);
  const normalizedSlug = slug.replace(/^\/+|\/+$/g, ''); // trim leading/trailing slashes

  // 1. Busca domínio ativo com esse hostname.
  //
  // Suporte a dois modelos:
  //   A) Hostname literal (dominio.com) com slug em path
  //      Ex: cubipiccanti.online/oferta1 → domain='cubipiccanti.online', slug='oferta1'
  //   B) Subdomínio (sub.dominio.com) mapeado como binding-slug do root
  //      Ex: bepurex-page.cubipiccanti.online → domain='cubipiccanti.online',
  //          slug='bepurex-page' (o subdomínio VIRA o slug do binding)
  //
  // Tentamos A primeiro. Se falhar, tenta B extraindo subdomínio.
  let domainRow = (
    await db
      .select({
        id: landingDomains.id,
        domain: landingDomains.domain,
        role: landingDomains.role,
      })
      .from(landingDomains)
      .where(eq(landingDomains.domain, normalizedHost))
      .limit(1)
  )[0];

  // Fallback: procura pelo domínio ROOT (remove primeiro subdomínio).
  // Só pega binding cujo slug bate com o subdomínio extraído.
  let effectiveSlug = normalizedSlug;
  let viaSubdomain = false;
  if (!domainRow && normalizedHost.split('.').length >= 3) {
    const parts = normalizedHost.split('.');
    const subPrefix = parts[0]!;
    const rootDomain = parts.slice(1).join('.');
    domainRow = (
      await db
        .select({
          id: landingDomains.id,
          domain: landingDomains.domain,
          role: landingDomains.role,
        })
        .from(landingDomains)
        .where(eq(landingDomains.domain, rootDomain))
        .limit(1)
    )[0];
    // Se resolveu por root, subdomínio vira o slug efetivo (path é ignorado
    // neste modelo — não faz sentido "sub.dominio.com/oferta1" ainda).
    if (domainRow) {
      effectiveSlug = subPrefix;
      viaSubdomain = true;
    }
  }

  if (!domainRow) return null;
  if (domainRow.role === 'blocked' || domainRow.role === 'disabled') return null;

  // 2. Busca binding por slug (empty '' = root).
  const findBinding = async (bySlug: boolean) =>
    (
      await db
        .select({
          landingPageId: landingDomainBindings.landingPageId,
          slug: landingDomainBindings.slug,
          isDefaultRoot: landingDomainBindings.isDefaultRoot,
        })
        .from(landingDomainBindings)
        .where(
          and(
            eq(landingDomainBindings.domainId, domainRow.id),
            bySlug
              ? eq(landingDomainBindings.slug, effectiveSlug)
              : eq(landingDomainBindings.isDefaultRoot, true),
            // Binding desativado (endereço tirado do ar) não serve a landing,
            // mesmo que ela continue publicada em outro endereço.
            eq(landingDomainBindings.isActive, true),
          ),
        )
        .limit(1)
    )[0];

  // Landing na raiz do domínio: caminhos sem binding próprio (links do
  // rodapé clonado, ex. /pages/contact) caem na landing padrão — mesmo
  // comportamento do modelo subdomínio, que ignora o path.
  const binding =
    (await findBinding(true)) ??
    (!viaSubdomain && effectiveSlug !== '' ? await findBinding(false) : undefined);

  if (!binding) return null;

  // 3. Busca a landing + bundle offers em PARALELO (reduz pool pressure).
  // Antes: 2 queries sequenciais (landing → depois offers) = 2 pool slots por request.
  // Agora: Promise.all executa juntas = mesmo tempo total mas mais chance
  // de reuso de connection pelo postgres.js client (menos EMAXCONN).
  const [landingRow, offersRow] = await Promise.all([
    db
      .select({
        title: landingPages.title,
        slug: landingPages.slug,
        htmlBody: landingPages.htmlBody,
        customCss: landingPages.customCss,
        status: landingPages.status,
        seoTitle: landingPages.seoTitle,
        seoDescription: landingPages.seoDescription,
        seoImage: landingPages.seoImage,
        mediaUrls: landingPages.mediaUrls,
        contentLanguage: landingPages.contentLanguage,
        marketLocale: sql<string | null>`(select m.locale from landing_markets m where m.id = ${landingPages.marketId})`,
        manufacturer: landingPages.manufacturer,
        productType: landingPages.productType,
        price: landingPages.price,
        currency: landingPages.currency,
        compareAtPrice: landingPages.compareAtPrice,
        useNewBundleEngine: landingPages.useNewBundleEngine,
        checkoutProvider: landingPages.checkoutProvider,
        ctaConfig: landingPages.ctaConfig,
      })
      .from(landingPages)
      .where(eq(landingPages.id, binding.landingPageId))
      .limit(1),
    // Sempre busca offers — quase-free (index já otimizado) e evita
    // segunda round-trip DB quando flag ativa. Se flag off, ignoramos abaixo.
    db
      .select({
        position: landingBundleOffers.position,
        title: landingBundleOffers.title,
        qty: landingBundleOffers.qty,
        priceCents: landingBundleOffers.priceCents,
        compareAtCents: landingBundleOffers.compareAtCents,
        saveText: landingBundleOffers.saveText,
        badge: landingBundleOffers.badge,
        variantId: landingBundleOffers.variantId,
        isPreselected: landingBundleOffers.isPreselected,
      })
      .from(landingBundleOffers)
      .where(eq(landingBundleOffers.landingPageId, binding.landingPageId))
      .orderBy(landingBundleOffers.position),
  ]);

  const landing = landingRow[0];
  if (!landing) return null;
  // Só serve landings 'published'. Draft/archived = 404 no storefront.
  if (landing.status !== 'published') return null;
  if (!landing.htmlBody || landing.htmlBody.trim().length < 10) return null;

  const bundleOffers: BundleOfferInject[] = landing.useNewBundleEngine ? offersRow : [];
  const checkoutProvider = normalizeCheckoutProvider(landing.checkoutProvider);

  return {
    checkoutProvider,
    externalCheckout: checkoutProvider === 'external' ? readExternalCheckoutConfig(landing.ctaConfig) : {},
    landingPageId: binding.landingPageId,
    title: landing.title,
    slug: landing.slug,
    htmlBody: landing.htmlBody,
    customCss: landing.customCss,
    status: landing.status,
    isDefaultRoot: binding.isDefaultRoot,
    domainId: domainRow.id,
    domain: domainRow.domain,
    seoTitle: landing.seoTitle,
    seoDescription: landing.seoDescription,
    seoImage: landing.seoImage,
    mediaUrls: landing.mediaUrls ?? [],
    contentLanguage: landing.contentLanguage,
    marketLocale: landing.marketLocale,
    manufacturer: landing.manufacturer,
    productType: landing.productType,
    price: landing.price,
    currency: landing.currency,
    compareAtPrice: landing.compareAtPrice,
    useNewBundleEngine: landing.useNewBundleEngine,
    bundleOffers,
  };
}
