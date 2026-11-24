// Story 25.1 — ofertas do LandingLab: modo "página" ou "sistema", bullets e link por oferta.
//
// Módulo puro (sem dependências) usado pelo storefront (em tempo de request) e pelo export da
// 25.2. No modo "sistema" o bloco original marcado na clonagem (`data-ll-bundle-root`) ou
// escolhido no editor sai do HTML e entra o bloco do sistema, renderizado aqui. O script de
// ofertas (`buildOffersScript`) aplica a prioridade do link da oferta no clique e, no modo
// "página", troca título, badge e bullets onde o elemento marcado existir.

import { EXTERNAL_CHECKOUT_PASSTHROUGH } from './external-checkout.js';

export const OFFERS_SOURCES = ['page', 'system'] as const;
export type OffersSource = (typeof OFFERS_SOURCES)[number];

export function normalizeOffersSource(value: unknown): OffersSource {
  return value === 'system' ? 'system' : 'page';
}

export const OFFER_BULLETS_MAX = 8;
export const OFFER_BULLET_MAX_LEN = 120;

/** Atributo do elemento raiz do bloco de ofertas original (adaptador: `""`; editor: `"manual"`). */
export const BUNDLE_ROOT_ATTR = 'data-ll-bundle-root';
/** Atributo do elemento depois do qual entra o bloco do sistema (posição escolhida no editor). */
export const OFFERS_ANCHOR_ATTR = 'data-ll-offers-anchor';
export const SYSTEM_OFFERS_ATTR = 'data-ll-system-offers';
export const OFFERS_SCRIPT_MARKER = 'data-landinglab-engine="offers"';

export interface LandingOfferView {
  position: number;
  title: string;
  qty: number;
  priceCents: number;
  compareAtCents: number | null;
  saveText: string | null;
  badge: string | null;
  bullets: string[];
  checkoutUrl: string | null;
  variantId: string | null;
  isPreselected: boolean;
}

/** Textarea "um por linha" → lista sem linhas vazias. */
export function parseBulletsText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export type BulletsValidation =
  | { ok: true; bullets: string[] }
  | { ok: false; reason: 'invalid' | 'too_many' | 'too_long' };

export const BULLETS_REASON_PT: Record<'invalid' | 'too_many' | 'too_long', string> = {
  invalid: 'Bullets inválidos.',
  too_many: `Máximo de ${OFFER_BULLETS_MAX} bullets por oferta.`,
  too_long: `Cada bullet pode ter no máximo ${OFFER_BULLET_MAX_LEN} caracteres.`,
};

export function validateOfferBullets(raw: unknown): BulletsValidation {
  if (raw == null) return { ok: true, bullets: [] };
  if (!Array.isArray(raw) || raw.some((b) => typeof b !== 'string')) return { ok: false, reason: 'invalid' };
  const bullets = (raw as string[]).map((b) => b.trim()).filter((b) => b.length > 0);
  if (bullets.length > OFFER_BULLETS_MAX) return { ok: false, reason: 'too_many' };
  if (bullets.some((b) => b.length > OFFER_BULLET_MAX_LEN)) return { ok: false, reason: 'too_long' };
  return { ok: true, bullets };
}

// ─────────────────────────────────────────────────────────────────────────
// Busca de elementos marcados no HTML (sem parser: o storefront não tem cheerio)
// ─────────────────────────────────────────────────────────────────────────

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
]);
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'noscript']);
const TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y;
const ATTR_RE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

export interface MarkedElementRange {
  start: number;
  end: number;
  tag: string;
}

interface TagToken {
  start: number;
  end: number;
  closing: boolean;
  name: string;
  attrs: string;
  selfClosing: boolean;
}

function hasAttr(attrs: string, attr: string): boolean {
  const wanted = attr.toLowerCase();
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(attrs))) {
    if (m[1]!.toLowerCase() === wanted) return true;
  }
  return false;
}

/** Próxima tag a partir de `from`, pulando comentários, doctype e conteúdo de script/style. */
function nextTag(html: string, from: number): TagToken | null {
  let i = from;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) return null;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(html);
    if (!m) {
      i = lt + 1;
      continue;
    }
    const attrs = m[3] ?? '';
    return {
      start: lt,
      end: lt + m[0].length,
      closing: m[1] === '/',
      name: m[2]!.toLowerCase(),
      attrs,
      selfClosing: /\/\s*$/.test(attrs),
    };
  }
  return null;
}

/** Fim do conteúdo bruto de script/style (posição do `</tag`), ou o fim do HTML. */
function skipRawText(html: string, name: string, from: number): number {
  const re = new RegExp(`</${name}\\b`, 'ig');
  re.lastIndex = from;
  const m = re.exec(html);
  return m ? m.index : html.length;
}

/** Posição logo depois do `</tag>` que fecha o elemento aberto em `from`, ou -1. */
function findClose(html: string, name: string, from: number): number {
  let depth = 1;
  let i = from;
  for (;;) {
    const t = nextTag(html, i);
    if (!t) return -1;
    i = t.end;
    if (!t.closing && RAW_TEXT_TAGS.has(t.name)) {
      i = skipRawText(html, t.name, t.end);
      continue;
    }
    if (t.name !== name) continue;
    if (t.closing) {
      depth -= 1;
      if (depth === 0) return t.end;
    } else if (!t.selfClosing) {
      depth += 1;
    }
  }
}

/** Elementos (abertura até o fechamento) que têm o atributo; marcados dentro de outro marcado não repetem. */
export function findMarkedElementRanges(html: string, attr: string): MarkedElementRange[] {
  const ranges: MarkedElementRange[] = [];
  let i = 0;
  for (;;) {
    const t = nextTag(html, i);
    if (!t) break;
    i = t.end;
    if (t.closing) continue;
    if (RAW_TEXT_TAGS.has(t.name)) {
      i = skipRawText(html, t.name, t.end);
      continue;
    }
    if (!hasAttr(t.attrs, attr)) continue;
    if (VOID_TAGS.has(t.name) || t.selfClosing) {
      ranges.push({ start: t.start, end: t.end, tag: t.name });
      continue;
    }
    const end = findClose(html, t.name, t.end);
    if (end < 0) continue; // sem fechamento: não arrisca remover o resto da página
    ranges.push({ start: t.start, end, tag: t.name });
    i = end;
  }
  return ranges;
}

export function removeMarkedElements(html: string, attr: string): string {
  const ranges = findMarkedElementRanges(html, attr);
  let out = html;
  for (let k = ranges.length - 1; k >= 0; k -= 1) {
    const r = ranges[k]!;
    out = out.slice(0, r.start) + out.slice(r.end);
  }
  return out;
}

/** O modo "sistema" tem onde entrar (raiz do bloco original ou âncora)? */
export function hasSystemOffersPlacement(html: string): boolean {
  return (
    findMarkedElementRanges(html, OFFERS_ANCHOR_ATTR).length > 0 ||
    findMarkedElementRanges(html, BUNDLE_ROOT_ATTR).length > 0
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Bloco do sistema
// ─────────────────────────────────────────────────────────────────────────

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const jsonForScript = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

const BUY_LABELS: Record<string, string> = {
  pt: 'Comprar agora',
  en: 'Buy now',
  es: 'Comprar ahora',
  fr: 'Acheter maintenant',
  de: 'Jetzt kaufen',
  it: 'Acquista ora',
  pl: 'Kup teraz',
  nl: 'Nu kopen',
};

export function offerBuyLabel(lang: string | null | undefined): string {
  const key = (lang ?? '').toLowerCase().slice(0, 2);
  return BUY_LABELS[key] ?? BUY_LABELS['en']!;
}

/** Valor em unidades menores → texto na moeda (casas decimais da própria moeda: JPY 0, EUR 2). */
export function formatOfferPrice(cents: number, currency: string, locale?: string | null): string {
  const code = (currency || 'USD').toUpperCase();
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions()
      .maximumFractionDigits ?? 2;
    return new Intl.NumberFormat(locale || 'en', { style: 'currency', currency: code }).format(
      cents / 10 ** digits,
    );
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`;
  }
}

export interface SystemOffersRenderOptions {
  currency: string;
  /** Locale de formatação do preço (ex.: `pt-BR`, `de-DE`). */
  locale?: string | null;
  /** Idioma do rótulo do botão (ex.: `pt`, `de`). */
  lang?: string | null;
}

const SYSTEM_OFFERS_CSS = `
.ll-sys-offers{--ll-accent:#111;--ll-accent-text:#fff;font-family:inherit;color:inherit;margin:16px 0;display:block}
.ll-sys-offers *{box-sizing:border-box}
.ll-sys-offers__list{display:flex;flex-direction:column;gap:10px}
.ll-sys-offer{position:relative;border:2px solid rgba(0,0,0,.15);border-radius:10px;padding:14px 14px 12px;cursor:pointer;background:#fff;transition:border-color .15s}
.ll-sys-offer[data-landing-variant-active="true"]{border-color:var(--ll-accent);box-shadow:0 0 0 1px var(--ll-accent)}
.ll-sys-offer__badge{position:absolute;top:-11px;right:12px;background:var(--ll-accent);color:var(--ll-accent-text);font-size:12px;font-weight:700;line-height:1;padding:5px 9px;border-radius:999px}
.ll-sys-offer__head{display:flex;align-items:center;gap:10px}
.ll-sys-offer__radio{flex:0 0 18px;width:18px;height:18px;border-radius:50%;border:2px solid rgba(0,0,0,.35)}
.ll-sys-offer[data-landing-variant-active="true"] .ll-sys-offer__radio{border-color:var(--ll-accent);background:radial-gradient(circle,var(--ll-accent) 45%,transparent 50%)}
.ll-sys-offer__info{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.ll-sys-offer__title{font-weight:700;font-size:16px;line-height:1.25}
.ll-sys-offer__qty{font-weight:400;opacity:.7;margin-left:4px}
.ll-sys-offer__save{font-size:13px;font-weight:600;color:var(--ll-accent)}
.ll-sys-offer__prices{display:flex;flex-direction:column;align-items:flex-end;gap:2px;white-space:nowrap}
.ll-sys-offer__price{font-weight:700;font-size:17px}
.ll-sys-offer__compare{font-size:13px;opacity:.6}
.ll-sys-offer__bullets{list-style:none;margin:10px 0 0;padding:0 0 0 28px;display:flex;flex-direction:column;gap:4px;font-size:14px;line-height:1.35}
.ll-sys-offer__bullets li{position:relative;padding-left:18px}
.ll-sys-offer__bullets li:before{content:"\\2713";position:absolute;left:0;color:var(--ll-accent);font-weight:700}
.ll-sys-offers__buy{display:block;width:100%;margin-top:14px;padding:15px 18px;border:0;border-radius:8px;background:var(--ll-accent);color:var(--ll-accent-text);font:inherit;font-size:17px;font-weight:700;cursor:pointer}
.ll-sys-offers__buy:hover{filter:brightness(1.08)}
`;

// Script do bloco: seleção do card (delegada na raiz; o runtime do storefront clona botões) e a
// cor de destaque tirada do botão principal da página.
const SYSTEM_OFFERS_SCRIPT = `(function(){
var s=document.currentScript;var root=s&&s.closest?s.closest('[${SYSTEM_OFFERS_ATTR}]'):null;if(!root)return;
function pick(card){
  var cards=root.querySelectorAll('[data-ll-offer]');
  for(var i=0;i<cards.length;i++){var on=cards[i]===card;
    if(on)cards[i].setAttribute('data-landing-variant-active','true');else cards[i].removeAttribute('data-landing-variant-active');
    cards[i].setAttribute('aria-checked',on?'true':'false');}
  var pos=parseInt(card.getAttribute('data-landing-position'),10);
  if(!isNaN(pos)&&typeof window.__LL_SET_ACTIVE_OFFER__==='function'){try{window.__LL_SET_ACTIVE_OFFER__(pos);}catch(e){}}
}
root.addEventListener('click',function(ev){var c=ev.target&&ev.target.closest?ev.target.closest('[data-ll-offer]'):null;if(c&&root.contains(c))pick(c);});
root.addEventListener('keydown',function(ev){if(ev.key!=='Enter'&&ev.key!==' ')return;var c=ev.target&&ev.target.closest?ev.target.closest('[data-ll-offer]'):null;if(c&&root.contains(c)){ev.preventDefault();pick(c);}});
function solid(c){return c&&c!=='transparent'&&!/rgba\\([^)]*,\\s*0\\)$/.test(c);}
function accent(){
  var sels=['[data-landing-cta="buy"]:not([data-ll-system-buy])','[data-ll-cta="buy"]','button[name="add"]','.product-form__submit','.btn--primary','.button--primary','.btn-primary'];
  for(var i=0;i<sels.length;i++){var els=document.querySelectorAll(sels[i]);
    for(var j=0;j<els.length;j++){if(root.contains(els[j]))continue;var cs=window.getComputedStyle(els[j]);
      if(solid(cs.backgroundColor)){root.style.setProperty('--ll-accent',cs.backgroundColor);root.style.setProperty('--ll-accent-text',cs.color);return;}}}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',accent);else accent();
})();`;

function renderOfferCard(offer: LandingOfferView, index: number, active: boolean, opts: SystemOffersRenderOptions): string {
  const title = offer.title.trim() || `${offer.qty}×`;
  const showQty = offer.qty > 1 && !title.includes(String(offer.qty));
  const attrs = [
    `class="ll-sys-offer"`,
    `data-ll-offer="${index}"`,
    `data-landing-position="${offer.position}"`,
    `data-landing-qty="${offer.qty}"`,
    offer.variantId ? `data-landing-variant-id="${escapeHtml(offer.variantId)}"` : '',
    active ? `data-landing-variant-active="true"` : '',
    `role="radio"`,
    `aria-checked="${active ? 'true' : 'false'}"`,
    `tabindex="0"`,
  ]
    .filter(Boolean)
    .join(' ');
  const badge = offer.badge?.trim() ? `<span class="ll-sys-offer__badge">${escapeHtml(offer.badge.trim())}</span>` : '';
  const save = offer.saveText?.trim() ? `<span class="ll-sys-offer__save">${escapeHtml(offer.saveText.trim())}</span>` : '';
  const compare =
    offer.compareAtCents != null && offer.compareAtCents > offer.priceCents
      ? `<s class="ll-sys-offer__compare">${escapeHtml(formatOfferPrice(offer.compareAtCents, opts.currency, opts.locale))}</s>`
      : '';
  const bullets = offer.bullets.length
    ? `<ul class="ll-sys-offer__bullets">${offer.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
    : '';
  return (
    `<div ${attrs}>${badge}<div class="ll-sys-offer__head"><span class="ll-sys-offer__radio" aria-hidden="true"></span>` +
    `<div class="ll-sys-offer__info"><span class="ll-sys-offer__title">${escapeHtml(title)}` +
    `${showQty ? `<span class="ll-sys-offer__qty">×${offer.qty}</span>` : ''}</span>${save}</div>` +
    `<div class="ll-sys-offer__prices"><span class="ll-sys-offer__price">${escapeHtml(
      formatOfferPrice(offer.priceCents, opts.currency, opts.locale),
    )}</span>${compare}</div></div>${bullets}</div>`
  );
}

/** Índice da oferta selecionada ao carregar: a pré-selecionada, senão a primeira. */
export function preselectedOfferIndex(offers: LandingOfferView[]): number {
  const idx = offers.findIndex((o) => o.isPreselected);
  return idx >= 0 ? idx : 0;
}

/** HTML do bloco do sistema (tudo escapado; CSS e script próprios). Ofertas na ordem de exibição. */
export function renderSystemOffersBlock(offers: LandingOfferView[], opts: SystemOffersRenderOptions): string {
  const active = preselectedOfferIndex(offers);
  const cards = offers.map((o, i) => renderOfferCard(o, i, i === active, opts)).join('');
  return (
    `<div class="ll-sys-offers" ${SYSTEM_OFFERS_ATTR}="1">` +
    `<style>${SYSTEM_OFFERS_CSS.trim()}</style>` +
    `<div class="ll-sys-offers__list" role="radiogroup">${cards}</div>` +
    `<button type="button" class="ll-sys-offers__buy" data-landing-cta="buy" data-ll-system-buy="1">${escapeHtml(
      offerBuyLabel(opts.lang),
    )}</button>` +
    `<script>${SYSTEM_OFFERS_SCRIPT}</script></div>`
  );
}

export type ApplySystemOffersResult =
  | { applied: true; html: string }
  | { applied: false; html: string; reason: 'no_offers' | 'no_placement' };

/**
 * Modo "sistema": tira o bloco original e põe o do sistema.
 * Com âncora: o bloco entra depois dela e todas as raízes saem. Sem âncora: o bloco entra no lugar
 * da primeira raiz e as outras saem. Sem nenhuma das duas: nada muda (fica o modo "página").
 */
export function applySystemOffers(
  html: string,
  offers: LandingOfferView[],
  opts: SystemOffersRenderOptions,
): ApplySystemOffersResult {
  if (offers.length === 0) return { applied: false, html, reason: 'no_offers' };
  const roots = findMarkedElementRanges(html, BUNDLE_ROOT_ATTR);
  const anchor = findMarkedElementRanges(html, OFFERS_ANCHOR_ATTR)[0];
  if (!anchor && roots.length === 0) return { applied: false, html, reason: 'no_placement' };

  let insertAt: number;
  if (anchor) {
    insertAt = anchor.end;
    // Âncora dentro de um bloco que vai sair: o bloco do sistema entra no lugar dele.
    const host = roots.find((r) => anchor.start >= r.start && anchor.start < r.end);
    if (host) insertAt = host.start;
  } else {
    insertAt = roots[0]!.start;
  }

  const block = renderSystemOffersBlock(offers, opts);
  let out = '';
  let cursor = 0;
  let inserted = false;
  for (const r of roots) {
    if (!inserted && insertAt <= r.start) {
      out += html.slice(cursor, insertAt) + block;
      cursor = insertAt;
      inserted = true;
    }
    out += html.slice(cursor, r.start);
    cursor = r.end;
  }
  if (!inserted) {
    out += html.slice(cursor, insertAt) + block;
    cursor = insertAt;
  }
  out += html.slice(cursor);
  return { applied: true, html: out };
}

// ─────────────────────────────────────────────────────────────────────────
// Script de ofertas: prioridade do link + textos do modo "página"
// ─────────────────────────────────────────────────────────────────────────

/** Parâmetros de tracking repassados ao link da oferta (mesma lista do checkout externo). */
export const OFFER_LINK_PASSTHROUGH: readonly string[] = EXTERNAL_CHECKOUT_PASSTHROUGH;

export interface OffersScriptOptions {
  /** Modo efetivo na página servida (o "sistema" sem posição vira "página"). */
  source: OffersSource;
  currency: string;
  locale?: string | null;
  /** Preenche preço/riscado/save no modo "página" quando o runtime do bundle não roda (external, export). */
  fillPrices?: boolean;
  /** Parâmetros repassados (padrão: OFFER_LINK_PASSTHROUGH). */
  passthrough?: readonly string[];
}

/**
 * Corpo do script de ofertas (vai no `<head>` ANTES do script do provider: os dois escutam clique em
 * `window` na fase de captura e o primeiro registrado roda antes). Oferta ativa com `checkoutUrl`
 * navega direto; sem link, o clique segue para o provider.
 */
export function buildOffersScriptBody(offers: LandingOfferView[], opts: OffersScriptOptions): string {
  if (offers.length === 0) return '';
  const cfg = {
    source: opts.source,
    fillPrices: opts.fillPrices === true,
    pre: preselectedOfferIndex(offers),
    pass: opts.passthrough ?? OFFER_LINK_PASSTHROUGH,
    offers: offers.map((o) => ({
      title: o.title,
      badge: o.badge ?? '',
      bullets: o.bullets,
      url: o.checkoutUrl ?? '',
      price: formatOfferPrice(o.priceCents, opts.currency, opts.locale),
      compare:
        o.compareAtCents != null && o.compareAtCents > o.priceCents
          ? formatOfferPrice(o.compareAtCents, opts.currency, opts.locale)
          : '',
      save: o.saveText ?? '',
    })),
  };
  return `(function(){
if (window.__LL_OFFERS_RUNTIME__) return; window.__LL_OFFERS_RUNTIME__ = true;
var CFG = window.__LL_OFFERS_CFG__ = ${jsonForScript(cfg)};
var O = CFG.offers; var last = -1;
var BUY = '[data-landing-cta="buy"],[data-ll-cta="buy"],button[name="add"],.pss-atc-button,.cc-pdp-buy-buttons button,.cc-pdp__buy-cta,[data-atc-button]';
function idx(el){ var n = parseInt(el.getAttribute('data-ll-offer'), 10); return isNaN(n) || n < 0 || n >= O.length ? -1 : n; }
function active(){
  var q = ['[data-ll-offer][data-landing-variant-active="true"]', '.kaching-bundles__bar--selected[data-ll-offer]', '[data-ll-offer].is-selected', '[data-ll-offer][aria-checked="true"]'];
  for (var i = 0; i < q.length; i++) { var el = document.querySelector(q[i]); if (el && idx(el) >= 0) return idx(el); }
  var r = document.querySelector('[data-ll-offer] input[type="radio"]:checked');
  if (r) { var c = r.closest('[data-ll-offer]'); if (c && idx(c) >= 0) return idx(c); }
  if (last >= 0) return last;
  return CFG.pre;
}
function link(raw){
  if (!raw) return null; var url; try { url = new URL(raw); } catch (e) { return null; }
  if (url.protocol !== 'https:') return null;
  var page = new URLSearchParams(window.location.search);
  for (var i = 0; i < CFG.pass.length; i++) {
    var k = CFG.pass[i]; var v = page.get(k);
    if (!v || v.length > 500 || url.searchParams.has(k)) continue;
    url.searchParams.set(k, v);
  }
  return url.toString();
}
window.addEventListener('click', function(ev){
  var t = ev.target; if (!t || !t.closest) return;
  if (t.closest('[data-ll-href]')) return; // Story 26.1: link escolhido no editor vence
  var card = t.closest('[data-ll-offer]'); if (card && idx(card) >= 0) last = idx(card);
  var cta = t.closest(BUY); if (!cta || cta.closest('cart-drawer, .cart-drawer')) return;
  var o = O[active()]; var dest = o && link(o.url); if (!dest) return;
  ev.preventDefault(); ev.stopPropagation(); if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
  window.location.assign(dest);
}, true);
if (CFG.source !== 'page') return;
function setText(el, v){ if (el && v && !el.closest('[data-ll-lock-text]') && el.textContent !== v) el.textContent = v; }
function bullets(el, list){
  if (!el || !list.length || el.getAttribute('data-ll-bullets-filled') === list.join('\\n')) return;
  var li = /^(UL|OL)$/.test(el.tagName); el.innerHTML = '';
  for (var i = 0; i < list.length; i++) {
    var n = document.createElement(li ? 'li' : 'span'); n.textContent = list[i];
    if (!li) n.style.display = 'block';
    el.appendChild(n);
  }
  el.setAttribute('data-ll-bullets-filled', list.join('\\n'));
}
function fill(){
  var cards = document.querySelectorAll('[data-ll-offer]');
  for (var i = 0; i < cards.length; i++) {
    var n = idx(cards[i]); if (n < 0 || cards[i].closest('[${SYSTEM_OFFERS_ATTR}]')) continue; var o = O[n];
    setText(cards[i].querySelector('[data-ll-title]'), o.title);
    var b = cards[i].querySelector('[data-ll-badge]');
    if (b) { if (o.badge) { setText(b, o.badge); b.style.display = ''; } else { b.style.display = 'none'; } }
    bullets(cards[i].querySelector('[data-ll-bullets]'), o.bullets);
    if (CFG.fillPrices && !window.__LL_BUNDLE_OFFERS__) {
      setText(cards[i].querySelector('[data-ll-price]'), o.price);
      var cmp = cards[i].querySelector('[data-ll-compare]');
      if (cmp) { if (o.compare) { setText(cmp, o.compare); cmp.style.display = ''; } else { cmp.style.display = 'none'; } }
      setText(cards[i].querySelector('[data-ll-save]'), o.save);
    }
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill); else fill();
var tries = 0; var iv = setInterval(function(){ fill(); if (++tries >= 20) clearInterval(iv); }, 500);
})();`;
}

export function buildOffersScript(offers: LandingOfferView[], opts: OffersScriptOptions): string {
  const body = buildOffersScriptBody(offers, opts);
  return body ? `<script ${OFFERS_SCRIPT_MARKER}>${body}</script>` : '';
}
