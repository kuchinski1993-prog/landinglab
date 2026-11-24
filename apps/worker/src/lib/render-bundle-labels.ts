// render-bundle-labels — título e badge visíveis de cada oferta (out/2026).
//
// Bug (landing a164a45a, Kaching): o owner editou no editor os títulos das
// ofertas ("Compra 1 e ricevi 2 GRATIS"); o preço visível mudou (renderBundleOffers
// reescreve .kaching-bundles__bar-price), mas o título continuava o do HTML
// clonado. Aqui fazemos para título/badge o mesmo que o preço já tem:
// landing_bundle_offers.title/badge → texto do card, server-side.
//
// Separado de renderBundleOffers de propósito (aquele módulo é "refactor, não
// redesign" — não muda lógica). Mesmos cards, mesma ordem (card i ↔ oferta i).
//
// Regras:
//   - Só roda com ofertas do landing_bundle_offers (o caller garante) — a
//     fonte legada não tem badge.
//   - Título vazio no banco → não mexe (nunca escreve "Bundle N").
//   - Badge preenchido → escreve no elemento de badge do card (se o tema tem);
//     badge vazio → esconde o badge do clone (mesma política do preço riscado
//     sem compare_at: não vaza texto que o owner não vê no editor).
//   - Troca só o 1º nó de texto do elemento: preserva os marcadores <!----> do
//     Svelte/Kaching e filhos (ícones). Idempotente.
//   - Nenhum script novo: o storefront serve o HTML pronto (sem loop com a
//     Engine V2).

import type * as cheerio from 'cheerio';

export interface BundleOfferLabel {
  title: string | null;
  badge: string | null;
}

export interface RenderBundleLabelsResult {
  titlesRewritten: number;
  badgesRewritten: number;
  badgesHidden: number;
}

/** Título visível do card (Kaching, Aurivita). Sem seletor genérico: evita títulos de bloco. */
export const OFFER_TITLE_SELECTOR = ['.kaching-bundles__bar-title', '.cc-pdp-offer__title', '[data-ll-offer-title]'].join(', ');

/** Badge visível do card ("Più Popolare"). */
export const OFFER_BADGE_SELECTOR = [
  '.kaching-bundles__bar-most-popular__content',
  '.cc-pdp-offer__badge',
  '[data-ll-offer-badge]',
].join(', ');

/** Contêiner a esconder quando o badge do banco está vazio. */
const BADGE_CONTAINER_SELECTOR = '.kaching-bundles__bar-most-popular, .cc-pdp-offer__badge, [data-ll-offer-badge]';

function setPrimaryText($: cheerio.CheerioAPI, el: cheerio.Cheerio<never>, value: string): boolean {
  const nodes = el.contents().toArray() as Array<{ type: string; data?: string }>;
  const textNode = nodes.find((n) => n.type === 'text' && (n.data ?? '').trim().length > 0);
  if (textNode) {
    const current = textNode.data ?? '';
    // Mantém espaços das bordas do texto original (layout inline do tema).
    const lead = /^\s*/.exec(current)?.[0] ?? '';
    const trail = /\s*$/.exec(current)?.[0] ?? '';
    const next = `${lead}${value}${trail}`;
    if (current === next) return false;
    textNode.data = next;
    return true;
  }
  if (el.text().trim() === value) return false;
  el.prepend($('<span></span>').text(value).html() ?? '');
  return true;
}

export function renderBundleLabels(
  $: cheerio.CheerioAPI,
  context: { cards: cheerio.Cheerio<never>; offers: BundleOfferLabel[] },
): RenderBundleLabelsResult {
  const result: RenderBundleLabelsResult = { titlesRewritten: 0, badgesRewritten: 0, badgesHidden: 0 };
  const n = Math.min(context.cards.length, context.offers.length);
  for (let i = 0; i < n; i++) {
    const offer = context.offers[i];
    if (!offer) continue;
    const card = context.cards.eq(i);

    const title = (offer.title ?? '').trim();
    if (title) {
      card
        .find(OFFER_TITLE_SELECTOR)
        .each((_, el) => {
          if (setPrimaryText($, $(el) as cheerio.Cheerio<never>, title)) result.titlesRewritten++;
        });
    }

    const badge = (offer.badge ?? '').trim();
    const badgeEls = card.find(OFFER_BADGE_SELECTOR);
    if (badge) {
      badgeEls.each((_, el) => {
        if (setPrimaryText($, $(el) as cheerio.Cheerio<never>, badge)) result.badgesRewritten++;
      });
      // Badge escondido por uma execução anterior (badge estava vazio) volta a aparecer.
      card.find(BADGE_CONTAINER_SELECTOR).each((_, el) => {
        const $el = $(el);
        if ($el.attr('data-ll-badge-hidden') === '1') {
          const original = $el.attr('data-ll-badge-style');
          if (original) $el.attr('style', original);
          else $el.removeAttr('style');
          $el.removeAttr('data-ll-badge-hidden');
          $el.removeAttr('data-ll-badge-style');
        }
      });
    } else if (badgeEls.length > 0) {
      card.find(BADGE_CONTAINER_SELECTOR).each((_, el) => {
        const $el = $(el);
        if ($el.attr('data-ll-badge-hidden') === '1') return;
        const original = $el.attr('style') ?? '';
        $el.attr('data-ll-badge-hidden', '1');
        if (original) $el.attr('data-ll-badge-style', original);
        $el.attr('style', `${original ? `${original.replace(/;\s*$/, '')};` : ''}display:none !important;`);
        result.badgesHidden++;
      });
    }
  }
  return result;
}
