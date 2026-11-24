// Story 25.1 (AC 7, 10) — posição do bloco do sistema escolhida no editor.
//
// Resolve, na hora de salvar, onde o bloco do sistema entra (`data-ll-offers-anchor`) e qual
// elemento sai (`data-ll-bundle-root="manual"`). Só insere atributos no texto original, pela
// posição da tag de abertura (parse5 via cheerio): o html_body não é reserializado.

import * as cheerio from 'cheerio';
import { BUNDLE_ROOT_ATTR, OFFERS_ANCHOR_ATTR } from '@blackshop/shared/landing-offers';

export type OffersAnchorMode = 'auto' | 'price' | 'title' | 'selector';

export interface OffersPlacementConfig {
  /** `auto`: usa a raiz marcada na clonagem. */
  anchor: OffersAnchorMode;
  anchorSelector?: string;
  removeSelector?: string;
  /** Resultado da última resolução (lido pelo publish-check). */
  anchorOk?: boolean;
  removeOk?: boolean | null;
}

const NEVER_MARK = new Set(['html', 'head', 'body', 'main']);
const VOID_TAGS = new Set(['img', 'hr', 'br', 'input', 'source', 'embed', 'wbr']);
const SELECTOR_MAX = 300;

export function readOffersPlacement(ctaConfig: unknown): OffersPlacementConfig {
  const raw =
    ctaConfig && typeof ctaConfig === 'object'
      ? (ctaConfig as Record<string, unknown>)['offersPlacement']
      : undefined;
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const anchor = p['anchor'];
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, SELECTOR_MAX) : undefined);
  return {
    anchor: anchor === 'price' || anchor === 'title' || anchor === 'selector' ? anchor : 'auto',
    anchorSelector: str(p['anchorSelector']),
    removeSelector: str(p['removeSelector']),
    anchorOk: typeof p['anchorOk'] === 'boolean' ? p['anchorOk'] : undefined,
    removeOk: typeof p['removeOk'] === 'boolean' ? p['removeOk'] : null,
  };
}

/** Grava a posição em `cta_config.offersPlacement` sem tocar nas outras chaves do jsonb. */
export function mergeOffersPlacement(ctaConfig: unknown, placement: OffersPlacementConfig): Record<string, unknown> {
  const base = ctaConfig && typeof ctaConfig === 'object' ? { ...(ctaConfig as Record<string, unknown>) } : {};
  base['offersPlacement'] = placement;
  return base;
}

/** Remove as marcas manuais anteriores (as do adaptador, `data-ll-bundle-root=""`, ficam). */
export function clearManualPlacementMarks(html: string): string {
  return html
    .replace(new RegExp(`\\s${OFFERS_ANCHOR_ATTR}(?:="[^"]*")?(?=[\\s/>])`, 'g'), '')
    .replace(new RegExp(`\\s${BUNDLE_ROOT_ATTR}="manual"`, 'g'), '');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type El = any;

function markable(el: El): boolean {
  const loc = el?.sourceCodeLocation;
  if (!loc?.startTag || NEVER_MARK.has(String(el.name).toLowerCase())) return false;
  // Elemento sem tag de fechamento explícita (ex.: <p> implícito) não dá para achar depois sem parser.
  return Boolean(loc.endTag) || VOID_TAGS.has(String(el.name).toLowerCase());
}

function insertAttr(el: El, attr: string): { at: number; text: string } {
  const at = el.sourceCodeLocation.startTag.startOffset + 1 + String(el.name).length;
  return { at, text: ` ${attr}` };
}

function uniqueMatch($: cheerio.CheerioAPI, selector: string | undefined): El | null {
  if (!selector) return null;
  try {
    const found = $(selector);
    return found.length === 1 ? found.get(0) : null;
  } catch {
    return null; // seletor inválido
  }
}

function outsideOffers($: cheerio.CheerioAPI, el: El): boolean {
  return $(el).closest(`[data-ll-offer], [${BUNDLE_ROOT_ATTR}]`).length === 0;
}

function findPriceAnchor($: cheerio.CheerioAPI): El | null {
  const sels = ['[class*="product__price"]', '[class*="product-price"]', '.price', '[class*="price"]'];
  for (const sel of sels) {
    const el = $(sel)
      .toArray()
      .find((e) => outsideOffers($, e) && markable(e));
    if (!el) continue;
    // Sobe até o container de preço mais externo (o bloco não deve entrar dentro de um flex do preço).
    let top: El = el;
    for (let p = $(el).parent(); p.length; p = p.parent()) {
      const node = p.get(0);
      if (!/price/i.test(p.attr('class') ?? '') || !markable(node)) break;
      top = node;
    }
    return top;
  }
  return null;
}

function findTitleAnchor($: cheerio.CheerioAPI): El | null {
  for (const sel of ['[class*="product__title"]', '[class*="product-title"]', 'h1']) {
    const el = $(sel)
      .toArray()
      .find((e) => outsideOffers($, e) && markable(e));
    if (el) return el;
  }
  return null;
}

export interface PlacementResolution {
  html: string;
  placement: OffersPlacementConfig;
}

/**
 * Aplica a posição escolhida ao html_body. Âncora/remoção só valem quando casam com exatamente 1
 * elemento que não seja html/head/body/main; senão nada é marcado e o resultado vai em
 * `anchorOk`/`removeOk` (o publish-check avisa).
 */
export function resolveOffersPlacement(htmlBody: string, input: OffersPlacementConfig): PlacementResolution {
  const html = clearManualPlacementMarks(htmlBody);
  const $ = cheerio.load(html, { sourceCodeLocationInfo: true });
  const edits: Array<{ at: number; text: string }> = [];

  let anchorOk = true;
  if (input.anchor !== 'auto') {
    const el =
      input.anchor === 'price'
        ? findPriceAnchor($)
        : input.anchor === 'title'
          ? findTitleAnchor($)
          : uniqueMatch($, input.anchorSelector);
    anchorOk = Boolean(el && markable(el));
    if (anchorOk) edits.push(insertAttr(el, `${OFFERS_ANCHOR_ATTR}=""`));
  }

  let removeOk: boolean | null = null;
  if (input.removeSelector) {
    const el = uniqueMatch($, input.removeSelector);
    removeOk = Boolean(el && markable(el) && el.sourceCodeLocation.endTag);
    if (removeOk) edits.push(insertAttr(el, `${BUNDLE_ROOT_ATTR}="manual"`));
  }

  let out = html;
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at);

  return {
    html: out,
    placement: {
      anchor: input.anchor,
      anchorSelector: input.anchor === 'selector' ? input.anchorSelector : undefined,
      removeSelector: input.removeSelector,
      anchorOk,
      removeOk,
    },
  };
}

/** Por card `data-ll-offer=N`: tem lista de bullets marcada? (aviso da AC 6). */
export function bulletsMarkedByCard(htmlBody: string): Set<number> {
  const marked = new Set<number>();
  if (!htmlBody.includes('data-ll-bullets')) return marked;
  const $ = cheerio.load(htmlBody);
  $('[data-ll-offer]').each((_, el) => {
    const n = Number.parseInt($(el).attr('data-ll-offer') ?? '', 10);
    if (Number.isInteger(n) && $(el).find('[data-ll-bullets]').length > 0) marked.add(n);
  });
  return marked;
}
