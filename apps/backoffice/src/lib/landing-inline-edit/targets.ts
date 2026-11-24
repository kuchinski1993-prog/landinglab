// Story 26.1 — alvos do editor visual (seção, botão, preço) e aplicação das edições.
//
// A MESMA função (`collectInlineEditTargets`) roda no preview `?edit=inline` (para marcar os elementos com
// `data-ll-eid`/`data-ll-kind`) e no `PATCH edit-inline` (para achar o alvo pelo ID), sempre sobre o
// `html_body` cru. Por isso o ID não depende do DOM vivo (que o tema e o overlay alteram).
//
// ID: `<s|b|p>_<ordem no tipo>_<hash de tag + texto>` — muda se o HTML mudar; o editor recarrega após salvar.
// Os IDs de texto/imagem antigos (`e_…`, calculados no navegador) continuam como estavam.

import { HIDDEN_ATTR, HIDDEN_STYLE, LOCK_TEXT_ATTR, EDIT_HREF_ATTR } from '@blackshop/shared/landing-edits-runtime';

export type InlineTargetKind = 'section' | 'button' | 'price';

export interface InlineEditTarget {
  id: string;
  kind: InlineTargetKind;
  el: Element;
}

const PREFIX: Record<InlineTargetKind, string> = { section: 's', button: 'b', price: 'p' };

const STRONG_SECTION = '.shopify-section, [id^="shopify-section-"]';
const SECTION_CANDIDATES = `${STRONG_SECTION}, section, main > *, body > *`;
const BUTTON_CANDIDATES =
  'a[href], button, input[type="submit"], input[type="button"], [role="button"], [data-ll-cta]';
const PRICE_CANDIDATES = '[data-ll-price], [data-ll-compare], [class*="price"]';
const NON_CONTENT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'BR', 'HR']);
const SKIP_ANCESTOR_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'SVG']);
const PRICE_MAX_TEXT = 40;
export const TEXT_MAX = 300;

export function djb2(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) + h + str.charCodeAt(i);
    h = h & 0xffffffff;
  }
  return (h >>> 0).toString(36);
}

/** Texto visível (sem o conteúdo de script/style/svg), com espaços normalizados. */
export function normText(el: Element): string {
  let out = '';
  const walk = (node: Node): void => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) out += c.nodeValue ?? '';
      else if (c.nodeType === 1 && !SKIP_ANCESTOR_TAGS.has((c as Element).tagName)) walk(c);
    }
  };
  walk(el);
  return out.replace(/\s+/g, ' ').trim();
}

function hasSkipAncestor(el: Element): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (SKIP_ANCESTOR_TAGS.has(p.tagName)) return true;
  }
  return false;
}

function hasMedia(el: Element): boolean {
  return !!el.querySelector('img, video, picture, svg, iframe');
}

function isSectionCandidate(el: Element): boolean {
  if (NON_CONTENT_TAGS.has(el.tagName) || el.tagName === 'MAIN') return false;
  if (el.hasAttribute('hidden')) return false;
  if (!normText(el) && !hasMedia(el)) return false;
  // Wrapper de página (ex.: <div id="page"> com as seções dentro): as seções de dentro é que contam.
  if (!el.matches(STRONG_SECTION) && el.querySelector(`${STRONG_SECTION}, section`)) return false;
  return true;
}

function isInside(el: Element, accepted: Set<Element>): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) if (accepted.has(p)) return true;
  return false;
}

function priceText(el: Element): string | null {
  const text = normText(el);
  if (!text || text.length > PRICE_MAX_TEXT || !/\d/.test(text)) return null;
  return text;
}

/** Elemento que guarda o texto principal (o maior trecho de texto) dentro de `el`. */
export function mainTextHost(el: Element): { host: Element; node: Text } | null {
  let best: Text | null = null;
  const walk = (node: Node): void => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        const v = (c.nodeValue ?? '').trim();
        if (v && (!best || v.length > (best.nodeValue ?? '').trim().length)) best = c as Text;
      } else if (c.nodeType === 1 && !SKIP_ANCESTOR_TAGS.has((c as Element).tagName)) {
        walk(c);
      }
    }
  };
  walk(el);
  const node = best as Text | null;
  return node && node.parentElement ? { host: node.parentElement, node } : null;
}

function countTextPieces(el: Element): number {
  let n = 0;
  const walk = (node: Node): void => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3 && (c.nodeValue ?? '').trim()) n++;
      else if (c.nodeType === 1 && !SKIP_ANCESTOR_TAGS.has((c as Element).tagName)) walk(c);
    }
  };
  walk(el);
  return n;
}

function makeId(kind: InlineTargetKind, index: number, el: Element): string {
  const basis = `${kind}|${el.tagName}|${normText(el).slice(0, 40)}|${el.getAttribute('href') ?? ''}`;
  return `${PREFIX[kind]}_${index}_${djb2(basis)}`;
}

/** Alvos em ordem de documento. Determinístico para o mesmo HTML. */
export function collectInlineEditTargets(doc: Document): InlineEditTarget[] {
  const out: InlineEditTarget[] = [];
  const taken = new Set<Element>();

  const sections = new Set<Element>();
  for (const el of Array.from(doc.querySelectorAll(SECTION_CANDIDATES))) {
    if (hasSkipAncestor(el) || isInside(el, sections) || !isSectionCandidate(el)) continue;
    sections.add(el);
  }
  let i = 0;
  for (const el of sections) {
    out.push({ id: makeId('section', i++, el), kind: 'section', el });
    taken.add(el);
  }

  const buttons = new Set<Element>();
  for (const el of Array.from(doc.querySelectorAll(BUTTON_CANDIDATES))) {
    if (taken.has(el) || hasSkipAncestor(el) || isInside(el, buttons)) continue;
    buttons.add(el);
  }
  i = 0;
  for (const el of buttons) {
    out.push({ id: makeId('button', i++, el), kind: 'button', el });
    taken.add(el);
  }

  const prices: Element[] = [];
  for (const el of Array.from(doc.querySelectorAll(PRICE_CANDIDATES))) {
    if (taken.has(el) || hasSkipAncestor(el) || !priceText(el)) continue;
    // Só o mais interno: um filho que também é preço ganha.
    const inner = Array.from(el.querySelectorAll(PRICE_CANDIDATES)).some((c) => priceText(c));
    if (inner) continue;
    prices.push(el);
  }
  i = 0;
  for (const el of prices) out.push({ id: makeId('price', i++, el), kind: 'price', el });
  return out;
}

function sectionLabel(el: Element): string {
  const h = el.querySelector('h1, h2, h3, h4');
  const text = (h && normText(h)) || normText(el);
  return text.slice(0, 60) || el.id || el.tagName.toLowerCase();
}

/** Marca os alvos para o overlay do editor (só no preview `?edit=inline`, nunca no HTML gravado). */
export function markInlineEditTargets(doc: Document): Record<InlineTargetKind, number> {
  const counts: Record<InlineTargetKind, number> = { section: 0, button: 0, price: 0 };
  for (const { id, kind, el } of collectInlineEditTargets(doc)) {
    counts[kind]++;
    el.setAttribute('data-ll-eid', id);
    el.setAttribute('data-ll-kind', kind);
    if (kind === 'section') {
      el.setAttribute('data-ll-label', sectionLabel(el));
      continue;
    }
    if (el.tagName === 'INPUT') {
      el.setAttribute('data-ll-cur-text', el.getAttribute('value') ?? '');
    } else {
      const main = mainTextHost(el);
      el.setAttribute('data-ll-cur-text', main ? (main.node.nodeValue ?? '').trim() : '');
      if (main) main.host.setAttribute('data-ll-text-host', id);
      if (countTextPieces(el) > 1) el.setAttribute('data-ll-multi-text', '1');
    }
    if (kind === 'button') {
      el.setAttribute('data-ll-cur-href', el.getAttribute(EDIT_HREF_ATTR) ?? el.getAttribute('href') ?? '');
    }
  }
  return counts;
}

// ─── Aplicação das edições ─────────────────────────────────────────────────

export interface SectionEdit {
  id: string;
  action: 'hide' | 'show' | 'remove';
}
export interface ButtonEdit {
  id: string;
  text?: string;
  /** Já validado (https ou #âncora); string vazia remove o link do editor. */
  href?: string;
}
export interface PriceEdit {
  id: string;
  text: string;
}
export interface TargetEdits {
  sectionEdits: SectionEdit[];
  buttonEdits: ButtonEdit[];
  priceEdits: PriceEdit[];
}

const HIDDEN_STYLE_RE = /;?\s*display\s*:\s*none\s*!important\s*;?/gi;

export function hideElement(el: Element): void {
  if (el.getAttribute(HIDDEN_ATTR) === '1') return;
  const style = (el.getAttribute('style') ?? '').trim().replace(/;$/, '');
  el.setAttribute('style', style ? `${style};${HIDDEN_STYLE}` : HIDDEN_STYLE);
  el.setAttribute(HIDDEN_ATTR, '1');
}

export function showElement(el: Element): void {
  if (!el.hasAttribute(HIDDEN_ATTR)) return;
  const style = (el.getAttribute('style') ?? '').replace(HIDDEN_STYLE_RE, ';').replace(/^;+|;+$/g, '').trim();
  if (style) el.setAttribute('style', style);
  else el.removeAttribute('style');
  el.removeAttribute(HIDDEN_ATTR);
}

/** Troca o texto principal e trava (o runtime reaplica se um script do tema trocar). */
export function setLockedText(el: Element, text: string): boolean {
  if (el.tagName === 'INPUT') {
    el.setAttribute('value', text);
    return true;
  }
  const main = mainTextHost(el);
  if (!main) {
    if (el.firstElementChild) return false;
    el.textContent = text;
    el.setAttribute(LOCK_TEXT_ATTR, text);
    return true;
  }
  if (main.host.firstElementChild) main.node.nodeValue = text;
  else main.host.textContent = text;
  main.host.setAttribute(LOCK_TEXT_ATTR, text);
  return true;
}

export interface ApplyTargetEditsResult {
  applied: number;
  warnings: string[];
}

/** Aplica no documento (já com os alvos calculados ANTES de qualquer mudança). Seções por último. */
export function applyTargetEdits(targets: InlineEditTarget[], edits: TargetEdits): ApplyTargetEditsResult {
  const byId = new Map(targets.map((t) => [t.id, t]));
  const warnings: string[] = [];
  let applied = 0;
  const find = (id: string, kind: InlineTargetKind): InlineEditTarget | null => {
    const t = byId.get(id);
    if (!t || t.kind !== kind) {
      warnings.push(`${kind} não encontrado (a página mudou?): ${id}`);
      return null;
    }
    return t;
  };

  for (const e of edits.buttonEdits) {
    const t = find(e.id, 'button');
    if (!t) continue;
    let did = false;
    if (typeof e.text === 'string' && e.text.trim()) {
      if (setLockedText(t.el, e.text.trim())) did = true;
      else warnings.push(`botão sem texto editável: ${e.id}`);
    }
    if (typeof e.href === 'string') {
      if (e.href) {
        t.el.setAttribute(EDIT_HREF_ATTR, e.href);
        if (t.el.tagName === 'A') t.el.setAttribute('href', e.href);
      } else {
        t.el.removeAttribute(EDIT_HREF_ATTR);
      }
      did = true;
    }
    if (did) applied++;
  }

  for (const e of edits.priceEdits) {
    const t = find(e.id, 'price');
    if (!t) continue;
    if (setLockedText(t.el, e.text.trim())) applied++;
    else warnings.push(`preço sem texto editável: ${e.id}`);
  }

  for (const e of edits.sectionEdits) {
    const t = find(e.id, 'section');
    if (!t) continue;
    if (e.action === 'hide') hideElement(t.el);
    else if (e.action === 'show') showElement(t.el);
    else t.el.parentNode?.removeChild(t.el);
    applied++;
  }

  return { applied, warnings };
}
