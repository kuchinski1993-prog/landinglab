// Story 25.1 — marcações comuns dos adaptadores de bundle.
//
// `data-ll-bundle-root` na raiz do bloco (o modo "sistema" remove esse elemento no storefront) e,
// dentro de cada card, `data-ll-title`, `data-ll-badge` e `data-ll-bullets` (o modo "página" troca
// os textos). Os bullets detectados vão para a oferta. Limites iguais aos do editor
// (`@blackshop/shared/landing-offers`: 8 bullets × 120 caracteres).

import type * as cheerio from 'cheerio';

import type { DetectedBundleOffer } from './types.js';

const BULLETS_MAX = 8;
const BULLET_MAX_LEN = 120;
const NEVER_ROOT = new Set(['html', 'head', 'body', 'main']);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sel = cheerio.Cheerio<any>;

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, BULLET_MAX_LEN);
}

function tagName(el: Sel): string {
  return String(el.prop('tagName') ?? '').toLowerCase();
}

/** Marca título, badge e lista de bullets do card; preenche `offer.bullets` com o que achou. */
export function markOfferTexts(
  $: cheerio.CheerioAPI,
  card: Sel,
  offer: DetectedBundleOffer,
  titleSelector = '[class*="bar-title"], [class*="title"]',
): void {
  const title = card.find(titleSelector).first();
  if (title.length) title.attr('data-ll-title', '');

  const badge = card.find('[class*="badge"]').first();
  if (badge.length) badge.attr('data-ll-badge', '');

  let list = card.find('ul, ol').first();
  if (!list.length) list = card.find('[class*="benefit"], [class*="bullet"]').first();
  if (!list.length) return;
  list.attr('data-ll-bullets', '');

  const items = ['ul', 'ol'].includes(tagName(list)) ? list.children('li') : list.children();
  const bullets: string[] = [];
  items.each((_, el) => {
    const text = cleanText($(el).text());
    if (text && bullets.length < BULLETS_MAX) bullets.push(text);
  });
  if (bullets.length === 0) {
    const text = cleanText(list.text());
    if (text) bullets.push(text);
  }
  offer.bullets = bullets;
}

/** Elemento mais externo que casa com `rootSelector` acima do card; senão o fallback ou o pai do card. */
export function markBundleRoot(_$: cheerio.CheerioAPI, firstCard: Sel, rootSelector: string, fallback?: Sel): void {
  let root: Sel | null = null;
  if (firstCard.length) {
    const outer = firstCard.parents(rootSelector);
    root = outer.length ? outer.last() : firstCard.parent();
  } else if (fallback?.length) {
    root = fallback;
  }
  if (!root?.length || NEVER_ROOT.has(tagName(root))) return;
  root.attr('data-ll-bundle-root', '');
}

/** Menor ancestral comum a todos os cards (nunca html/body/main). */
export function markCommonRoot($: cheerio.CheerioAPI, cards: Sel): void {
  if (cards.length < 2) return;
  const all = cards.toArray();
  let candidate = cards.first().parent();
  while (candidate.length && !NEVER_ROOT.has(tagName(candidate))) {
    const node = candidate.get(0);
    if (node && all.every((c) => c === node || $(c).parents().toArray().includes(node))) {
      candidate.attr('data-ll-bundle-root', '');
      return;
    }
    candidate = candidate.parent();
  }
}
