// Kaching Bundles adapter (set/2026).
//
// Detecta Kaching pelo custom element `<kaching-bundles-block>` + `<script id="kaching-bundles-config">`.
// Extrai as ofertas do `kaching-bundles-deal-block-settings.dealBars[]`.
// Marca cards `.kaching-bundles__bar` com data-ll-offer/data-ll-price/data-ll-cta e (Story 25.1)
// a raiz do bloco, título, badge e bullets de cada card.
// Remove TODO o JS Kaching (scripts, modulepreloads, config, tokens do concorrente).

import * as cheerio from 'cheerio';

import { markBundleRoot, markOfferTexts } from './marks.js';
import type {
  BundleAdapter,
  BundleAdapterResult,
  DetectedBundleOffer,
} from './types.js';

interface DealBar {
  id?: string;
  title?: string;
  subtitle?: string;
  badgeText?: string;
  quantity?: number;
  buyQuantity?: number;
  getQuantity?: number;
  discountType?: string;
  discountValue?: number;
  getDiscountType?: string;
  getDiscountValue?: number;
}

interface DealBlockSettings {
  preselectedDealBarId?: string;
  dealBars?: DealBar[];
}

function parseDealBars(html: string): { bars: DealBar[]; preselectedId: string | null } {
  // Kaching duplica o script frequentemente (uma vez por deal-block instance).
  // Extraímos o primeiro dealBars não-vazio e deduplicamos por id.
  const $ = cheerio.load(html);
  const scripts = $('script.kaching-bundles-deal-block-settings');
  const seenIds = new Set<string>();
  const bars: DealBar[] = [];
  let preselectedId: string | null = null;

  scripts.each((_, el) => {
    const raw = $(el).html()?.trim() || '';
    if (!raw.startsWith('{')) return;
    try {
      const data = JSON.parse(raw) as DealBlockSettings;
      if (!preselectedId && data.preselectedDealBarId) {
        preselectedId = data.preselectedDealBarId;
      }
      if (!Array.isArray(data.dealBars)) return;
      for (const bar of data.dealBars) {
        const id = bar?.id ?? '';
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        bars.push(bar);
      }
    } catch {
      // silêncio — script mal-formado
    }
  });

  return { bars, preselectedId };
}

/**
 * Kaching não armazena preço absoluto — só regras. Precisamos ESTIMAR pra
 * popular price_cents inicial (usuário edita no painel depois).
 *
 * Base price default: 0 (usuário edita). Se o HTML tiver landing_pages.price
 * setado no clone, o clone processor pode injetar aqui — mas por default 0.
 */
function estimatePriceCents(bar: DealBar, basePriceCents: number): {
  qty: number;
  priceCents: number;
  compareAtCents: number | null;
} {
  // BOGO
  if (bar.buyQuantity != null && bar.getQuantity != null) {
    const qty = bar.buyQuantity + bar.getQuantity;
    const gross = qty * basePriceCents;
    const paidPortion = bar.buyQuantity * basePriceCents;
    const freeDiscount = bar.getDiscountType === 'percentage'
      ? Math.round((bar.getDiscountValue ?? 0) / 100 * (bar.getQuantity ?? 0) * basePriceCents)
      : 0;
    return {
      qty,
      priceCents: Math.max(0, paidPortion - (freeDiscount === paidPortion * bar.getQuantity ? 0 : 0)),
      // Compare-at é o valor "sem oferta" (qty × base_price).
      compareAtCents: gross > paidPortion ? gross : null,
    };
  }
  // Simple discount
  const qty = bar.quantity ?? 1;
  const gross = qty * basePriceCents;
  const discountAmount =
    bar.discountType === 'percentage'
      ? Math.round((bar.discountValue ?? 0) / 100 * gross)
      : bar.discountType === 'fixed_amount'
        ? Math.round((bar.discountValue ?? 0) * 100)
        : 0;
  return {
    qty,
    priceCents: Math.max(0, gross - discountAmount),
    compareAtCents: discountAmount > 0 ? gross : null,
  };
}

export const kachingAdapter: BundleAdapter = {
  name: 'kaching',

  detect(html: string): boolean {
    return (
      /<kaching-bundles-block\b/i.test(html) ||
      /<script[^>]+id="kaching-bundles-config"/i.test(html)
    );
  },

  apply(html: string): BundleAdapterResult {
    const { bars, preselectedId } = parseDealBars(html);

    if (bars.length === 0) {
      return {
        adapter: 'kaching',
        offers: [],
        html,
        notes: 'Kaching detectado mas 0 dealBars extraídas',
      };
    }

    // basePriceCents = 0 default. Usuário edita no painel.
    const basePriceCents = 0;

    const offers: DetectedBundleOffer[] = bars.map((bar, i) => {
      const est = estimatePriceCents(bar, basePriceCents);
      const savePercent =
        bar.getDiscountType === 'percentage' && bar.getDiscountValue === 100
          ? `Buy ${bar.buyQuantity} get ${bar.getQuantity} FREE`
          : bar.discountType === 'percentage' && (bar.discountValue ?? 0) > 0
            ? `${bar.discountValue}% OFF`
            : null;
      return {
        position: i,
        title: bar.title?.trim() || `Bundle ${i + 1}`,
        qty: est.qty,
        priceCents: est.priceCents,
        compareAtCents: est.compareAtCents,
        saveText: savePercent,
        badge: bar.badgeText?.trim() || null,
        detectedVariantId: null, // Kaching resolve via storefrontAccessToken em runtime
        isPreselected: bar.id === preselectedId,
        bullets: [],
      };
    });

    // Aplica transformações no HTML:
    const $ = cheerio.load(html);

    // 1. Marca cards .kaching-bundles__bar com data-ll-offer
    const cards = $('.kaching-bundles__bar[data-deal-bar-id]');
    let marked = 0;
    cards.each((_, el) => {
      const dealBarId = $(el).attr('data-deal-bar-id');
      const barIdx = bars.findIndex((b) => b.id === dealBarId);
      if (barIdx < 0) return;
      $(el).attr('data-ll-offer', String(barIdx));
      // Marca preselected
      if (offers[barIdx]?.isPreselected) {
        $(el).attr('data-ll-preselected', 'true');
      }
      // Elementos internos de preço: heuristic — spans com money-like text
      // são candidatos. Script runtime resolve isso quando popular.
      // Para pré-marcar, procuramos por descendentes com classes conhecidas.
      $(el).find('[class*="price"]').first().attr('data-ll-price', '');
      $(el).find('[class*="compare"], [class*="crossed"]').first().attr('data-ll-compare', '');
      $(el).find('[class*="save"], [class*="discount"]').first().attr('data-ll-save', '');
      // Story 25.1: título, badge e lista de bullets do card (modo "página" troca o texto).
      markOfferTexts($, $(el), offers[barIdx]!, '.kaching-bundles__bar-title, [class*="bar-title"]');
      marked += 1;
    });

    // Story 25.1: raiz do bloco (o modo "sistema" remove este elemento no storefront).
    markBundleRoot($, cards.first(), 'kaching-bundles-block, .kaching-bundles__block, .kaching-bundles', $('kaching-bundles-block').first());

    // 2. Marca CTA principal — Kaching renderiza button "Add to cart" via JS,
    //    mas o wrapper `<kaching-bundle>` tem um `<button>` estático como fallback.
    //    Vamos marcar o primeiro <button> que parece ser CTA.
    const cta = $('kaching-bundle button, .kaching-bundles__cta').first();
    if (cta.length > 0) {
      cta.attr('data-ll-cta', 'buy');
    }

    // 3. REMOVE scripts Kaching (config + deal-block-settings + product) —
    //    não precisamos mais deles. Runtime universal vai popular via
    //    window.__LL_BUNDLE_OFFERS__.
    $('script#kaching-bundles-config').remove();
    $('script.kaching-bundles-deal-block-settings').remove();
    $('script.kaching-bundles-product').remove();

    // 4. Remove modulepreloads Kaching (baixa scripts que não vão rodar)
    $('link[rel="modulepreload"][href*="kaching-bundles"]').remove();

    // 5. Remove <script src="...kaching..."> caso alguma extension seja src
    //    (raro pois é modulepreload, mas belt+suspenders)
    $('script[src*="kaching-bundles"]').remove();

    // 6. Remove SCRIPT INLINE que init Kaching (has `kachingBundlesAppEmbedLoaded`)
    $('script').each((_, el) => {
      const src = $(el).html() || '';
      if (
        /kachingBundlesAppEmbedLoaded/.test(src) ||
        /window\.__kaching_bundles_/.test(src)
      ) {
        $(el).remove();
      }
    });

    // 7. Remove bloco visual nativo "PURCHASE OPTIONS / One-time / Subscribe & save".
    //    O Blackshop subs widget (data-landinglab-subs-widget) substitui essa UI.
    //    Selling plans e sellingPlanId permanecem intactos — apenas a apresentação
    //    duplicada é removida.
    $('.kaching-bundles__subscriptions').remove();

    const notes = `Kaching detectado — ${offers.length} ofertas, ${marked}/${cards.length} cards marcados`;

    return {
      adapter: 'kaching',
      offers,
      html: $.html(),
      notes,
    };
  },
};
