// Story 25.1 — ofertas da página ou do sistema na landing servida (AC 8–11).
//
// `offers_source`, `bullets` e `checkout_url` vêm de uma consulta à parte, com try/catch: se a
// migration 0115 ainda não rodou, a landing continua no modo "página" sem bullets nem link, e as
// consultas de `resolve-landing` e da Engine V2 não mudam.
//
// No modo "sistema" o bloco original sai do HTML aqui (depois do sanitize) e entra o bloco do
// sistema; sem posição (sem raiz/âncora marcada), o modo efetivo volta a ser "página". O script de
// ofertas entra antes dos scripts do provider (ele também escuta clique em `window` na captura e
// precisa rodar primeiro para o link da oferta ter prioridade).

import { asc, eq } from 'drizzle-orm';
import { landingBundleOffers, landingPages } from '@blackshop/db/schema-landinglab-core';
import {
  applySystemOffers,
  buildOffersScript,
  normalizeOffersSource,
  type LandingOfferView,
  type OffersSource,
} from '@blackshop/shared/landing-offers';

import { getDb } from '@/lib/db';

export interface OfferExtras {
  source: OffersSource;
  byPosition: Map<number, { bullets: string[]; checkoutUrl: string | null }>;
}

export interface BaseOffer {
  position: number;
  title: string;
  qty: number;
  variantId: string | null;
  priceCents: number;
  compareAtCents: number | null;
  saveText: string | null;
  badge: string | null;
  isPreselected: boolean;
}

export async function fetchOfferExtras(landingPageId: string): Promise<OfferExtras | null> {
  try {
    const db = getDb();
    const [page] = await db
      .select({ offersSource: landingPages.offersSource })
      .from(landingPages)
      .where(eq(landingPages.id, landingPageId))
      .limit(1);
    const rows = await db
      .select({
        position: landingBundleOffers.position,
        bullets: landingBundleOffers.bullets,
        checkoutUrl: landingBundleOffers.checkoutUrl,
      })
      .from(landingBundleOffers)
      .where(eq(landingBundleOffers.landingPageId, landingPageId))
      .orderBy(asc(landingBundleOffers.position));
    return {
      source: normalizeOffersSource(page?.offersSource),
      byPosition: new Map(rows.map((r) => [r.position, { bullets: r.bullets ?? [], checkoutUrl: r.checkoutUrl }])),
    };
  } catch {
    return null; // colunas da 0115 ausentes ou erro de consulta → modo "página" legado
  }
}

export function toOfferViews(offers: BaseOffer[], extras: OfferExtras | null): LandingOfferView[] {
  return offers.map((o) => {
    const extra = extras?.byPosition.get(o.position);
    return {
      position: o.position,
      title: o.title,
      qty: o.qty,
      priceCents: o.priceCents,
      compareAtCents: o.compareAtCents,
      saveText: o.saveText,
      badge: o.badge,
      bullets: extra?.bullets ?? [],
      checkoutUrl: extra?.checkoutUrl ?? null,
      variantId: o.variantId,
      isPreselected: o.isPreselected,
    };
  });
}

export interface LandingOffersHtmlOptions {
  currency: string;
  locale?: string | null;
  lang?: string | null;
  /** `external`: o runtime do bundle não roda, então o script de ofertas preenche os preços. */
  isExternal: boolean;
}

export interface LandingOffersHtmlResult {
  html: string;
  /** Tag `<script>` para o `<head>`, antes dos scripts do provider ('' sem ofertas). */
  offersScript: string;
  source: OffersSource;
}

export function applyLandingOffers(
  html: string,
  offers: LandingOfferView[],
  requested: OffersSource,
  opts: LandingOffersHtmlOptions,
): LandingOffersHtmlResult {
  let out = html;
  let source: OffersSource = 'page';
  if (requested === 'system') {
    const r = applySystemOffers(html, offers, { currency: opts.currency, locale: opts.locale, lang: opts.lang });
    if (r.applied) {
      out = r.html;
      source = 'system';
    }
  }
  const offersScript = buildOffersScript(offers, {
    source,
    currency: opts.currency,
    locale: opts.locale,
    fillPrices: opts.isExternal,
  });
  return { html: out, offersScript, source };
}
