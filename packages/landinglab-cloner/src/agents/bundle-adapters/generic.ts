// Generic adapter — fallback pra apps de bundle não-Kaching (set/2026).
//
// Estratégia: procurar "grupos de cards" que se pareçam com bundle:
//   - <input type="radio" name="id" value="VARIANT_ID"> dentro de form action=/cart
//   - OR: elementos com classes tipo "bundle", "option", "offer" com preço interno
//
// Se achar >= 2 cards → considera bundle detectado.

import * as cheerio from 'cheerio';

import { markCommonRoot, markOfferTexts } from './marks.js';
import type {
  BundleAdapter,
  BundleAdapterResult,
  DetectedBundleOffer,
} from './types.js';

const MONEY_RE = /([R$€£¥]|CHF|R\$|C\$|A\$|zł|kr|\$)\s*(\d[\d.,]*)/;

function extractMoneyCents(text: string): number | null {
  const m = MONEY_RE.exec(text);
  if (!m) return null;
  const raw = m[2]?.replace(/\./g, '').replace(',', '.');
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

export const genericAdapter: BundleAdapter = {
  name: 'generic',

  detect(html: string): boolean {
    // Tenta 3 padrões:
    // 1. radios name=id em form /cart (Shopify puro)
    // 2. elementos com "bundle" ou "offer" no class + >= 2 cards
    // 3. elementos com "volume-discount" (bundler apps genéricos)
    if (/<form[^>]+action="[^"]*\/cart[^"]*"[^>]*>[\s\S]*?<input[^>]+type="radio"[^>]+name="id"/i.test(html)) {
      return true;
    }
    // Cheerio-based count
    try {
      const $ = cheerio.load(html);
      const cards = $('[class*="bundle-selector"] [class*="option"], [class*="bundle-picker"] [class*="option"], [class*="volume-discount"] [class*="option"]');
      if (cards.length >= 2) return true;
    } catch {
      return false;
    }
    return false;
  },

  apply(html: string): BundleAdapterResult {
    const $ = cheerio.load(html);
    const offers: DetectedBundleOffer[] = [];
    // Tipo any evita divergência entre cheerio v1 (AnyNode) vs Element
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cards: cheerio.Cheerio<any> = $() as unknown as cheerio.Cheerio<any>;

    // Tenta pattern 1: radios em form /cart
    const radioLabels = $('form[action*="/cart"] input[type="radio"][name="id"]').parent();
    if (radioLabels.length >= 2) {
      cards = radioLabels;
    } else {
      // Pattern 2/3: cards com bundle/volume-discount
      cards = $(
        '[class*="bundle-selector"] [class*="option"], [class*="bundle-picker"] [class*="option"], [class*="volume-discount"] [class*="option"]',
      );
    }

    if (cards.length < 2) {
      return {
        adapter: 'generic',
        offers: [],
        html,
        notes: 'Generic: nenhum grupo de cards detectado (< 2)',
      };
    }

    cards.each((i, el) => {
      const $el = $(el);
      // Título: primeiro texto de heading OU span destacado
      const title =
        $el.find('h1,h2,h3,h4,h5,strong').first().text().trim() ||
        $el.find('[class*="title"]').first().text().trim() ||
        `Oferta ${i + 1}`;
      // Preço: primeiro elemento com $ ou classe money/price
      const priceText = $el.find('[class*="price"]').first().text().trim() || $el.text();
      const priceCents = extractMoneyCents(priceText) ?? 0;
      const compareText = $el.find('[class*="compare"], del, s').first().text().trim();
      const compareAtCents = compareText ? extractMoneyCents(compareText) : null;
      const saveText = $el.find('[class*="save"], [class*="discount"]').first().text().trim() || null;
      const variantId = $el.find('input[type="radio"][name="id"]').attr('value') ?? null;
      const isPreselected =
        $el.find('input[type="radio"][name="id"][checked]').length > 0 ||
        /is-active|is-selected|selected/.test($el.attr('class') ?? '');

      offers.push({
        position: i,
        title,
        qty: 1, // Genérico não sabe qty
        priceCents,
        compareAtCents,
        saveText,
        badge: null,
        detectedVariantId: variantId,
        isPreselected,
        bullets: [],
      });

      // Marca card com data-ll-*
      $el.attr('data-ll-offer', String(i));
      if (isPreselected) $el.attr('data-ll-preselected', 'true');
      $el.find('[class*="price"]').first().attr('data-ll-price', '');
      $el.find('[class*="compare"], del, s').first().attr('data-ll-compare', '');
      $el.find('[class*="save"], [class*="discount"]').first().attr('data-ll-save', '');
      // Story 25.1: título, badge e bullets onde existirem.
      const titleSelector = $el.find('h1,h2,h3,h4,h5,strong').length ? 'h1,h2,h3,h4,h5,strong' : '[class*="title"]';
      markOfferTexts($, $el, offers[offers.length - 1]!, titleSelector);
    });

    // Story 25.1: raiz do bloco = menor ancestral comum dos cards.
    markCommonRoot($, cards);

    // CTA de compra: primeiro form action=/cart submit button OU botão .buy
    const cta = $('form[action*="/cart"] button[type="submit"], button[name="add"], [class*="add-to-cart"]').first();
    if (cta.length > 0) {
      cta.attr('data-ll-cta', 'buy');
    }

    // Nenhum script pra remover no adapter genérico — cards eram já parte do tema
    // (não app externo). CSS mantém, JS não interfere.

    const notes = `Generic detectado — ${offers.length} cards, ${offers.filter((o) => o.detectedVariantId).length} com variant_id detectado`;

    return {
      adapter: 'generic',
      offers,
      html: $.html(),
      notes,
    };
  },
};
