// Story 26.1 — runtime das edições do editor visual (link de botão e texto travado).
//
// O editor grava no próprio `html_body`:
//   - `data-ll-href="<https://… | #âncora>"`: para onde o botão leva (vale para <button>, <a> e afins);
//   - `data-ll-lock-text="<texto>"`: texto de botão ou preço que nenhum script do tema pode trocar;
//   - `data-ll-hidden="1"` + `display:none !important` inline: seção oculta (não precisa de script);
//   - `<script type="application/json" data-ll-edits>`: receita de cada link/texto travado (seletor + posição).
//     Scripts da landing que redesenham o bloco (cards de oferta, preço por moeda) criam elementos sem os
//     atributos acima; o runtime acha o elemento novo pela receita e recoloca o atributo.
//
// Este script é o mesmo no storefront, no preview limpo e nos dois zips de export (Story 26.2). Vai no
// `<head>` ANTES do script de ofertas, da Engine V2 e do checkout externo: todos escutam clique em
// `window` na fase de captura e o primeiro registrado vence (`stopImmediatePropagation`).

import { EXTERNAL_CHECKOUT_PASSTHROUGH, validateExternalCheckoutUrl } from './external-checkout.js';

const json = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

export const EDIT_HREF_ATTR = 'data-ll-href';
export const LOCK_TEXT_ATTR = 'data-ll-lock-text';
export const HIDDEN_ATTR = 'data-ll-hidden';
export const HIDDEN_STYLE = 'display:none !important';
export const EDITS_RUNTIME_MARKER = 'data-landinglab-engine="edits"';
export const EDITS_MANIFEST_ATTR = 'data-ll-edits';

/** Uma edição reaplicável: `document.querySelectorAll(s)[i]` recebe o link `h` e/ou o texto travado `t`. */
export interface EditsManifestEntry {
  s: string;
  i: number;
  h?: string;
  t?: string;
}

/** `<script type="application/json" data-ll-edits>` com as receitas (vazio = sem tag). */
export function buildEditsManifestTag(entries: readonly EditsManifestEntry[]): string {
  return entries.length ? `<script type="application/json" ${EDITS_MANIFEST_ATTR}>${json(entries)}</script>` : '';
}

const ANCHOR_RE = /^#[A-Za-z][\w\-:.]{0,100}$/;

export type ButtonHrefResult = { ok: true; href: string } | { ok: false; reason: string };

/** Link aceito num botão: `#âncora` ou `https://` com as regras do checkout externo (sem IP, porta ou credenciais). */
export function validateButtonHref(raw: unknown): ButtonHrefResult {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'link vazio' };
  const value = raw.trim();
  if (value.startsWith('#')) {
    return ANCHOR_RE.test(value) ? { ok: true, href: value } : { ok: false, reason: 'âncora inválida (use #id-da-seção)' };
  }
  const res = validateExternalCheckoutUrl(value);
  if (!res.ok) return { ok: false, reason: res.reason === 'not_https' ? 'só https:// é aceito' : `link inválido (${res.reason})` };
  return { ok: true, href: res.url };
}

/** O HTML tem link de botão, texto travado ou receitas (o runtime só entra quando precisa). */
export function htmlNeedsEditsRuntime(html: string): boolean {
  return /\sdata-ll-(?:href|lock-text|edits)(?:\s*=|[\s>])/i.test(html);
}

/** Corpo do runtime (ES5, sem dependências). */
export const LANDING_EDITS_RUNTIME_BODY = `(function(){
if (window.__LL_EDITS_RUNTIME__) return; window.__LL_EDITS_RUNTIME__ = true;
var PASS = ${json(EXTERNAL_CHECKOUT_PASSTHROUGH)};
function dest(raw){
  if (!raw) return null; raw = String(raw).trim();
  if (raw.charAt(0) === '#') return raw.length > 1 ? raw : null;
  var url; try { url = new URL(raw); } catch (e) { return null; }
  if (url.protocol !== 'https:') return null;
  var page = new URLSearchParams(window.location.search);
  for (var i = 0; i < PASS.length; i++) {
    var k = PASS[i]; var v = page.get(k);
    if (!v || v.length > 500 || url.searchParams.has(k)) continue;
    url.searchParams.set(k, v);
  }
  return url.toString();
}
window.addEventListener('click', function(ev){
  var t = ev.target; if (!t || !t.closest) return;
  var el = t.closest('[${EDIT_HREF_ATTR}]'); if (!el) return;
  var d = dest(el.getAttribute('${EDIT_HREF_ATTR}')); if (!d) return;
  ev.preventDefault(); ev.stopPropagation(); if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
  if (d.charAt(0) === '#') {
    var id = d.slice(1); var target = document.getElementById(id) || document.querySelector('[name="' + id.replace(/"/g, '') + '"]');
    if (target && target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  window.location.assign(d);
}, true);
function mainText(el){
  var best = null;
  for (var n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim() && (!best || n.nodeValue.trim().length > best.nodeValue.trim().length)) best = n;
  }
  return best;
}
function lock(el){
  var v = el.getAttribute('${LOCK_TEXT_ATTR}'); if (v == null) return;
  if (!el.firstElementChild) { if ((el.textContent || '').trim() !== v.trim()) el.textContent = v; return; }
  var n = mainText(el); if (n && n.nodeValue.trim() !== v.trim()) n.nodeValue = v;
}
function lockAll(){
  var els = document.querySelectorAll('[${LOCK_TEXT_ATTR}]');
  for (var i = 0; i < els.length; i++) lock(els[i]);
  return els.length;
}
var recipes = [];
function readRecipes(){
  var tag = document.querySelector('script[${EDITS_MANIFEST_ATTR}]'); if (!tag) return;
  try { var list = JSON.parse(tag.textContent || '[]'); if (list && list.length) recipes = list; } catch (e) {}
}
function reapply(){
  for (var i = 0; i < recipes.length; i++) {
    var r = recipes[i]; if (!r || typeof r.s !== 'string') continue;
    var els; try { els = document.querySelectorAll(r.s); } catch (e) { continue; }
    var el = els[r.i]; if (!el) continue;
    if (typeof r.h === 'string' && el.getAttribute('${EDIT_HREF_ATTR}') !== r.h) el.setAttribute('${EDIT_HREF_ATTR}', r.h);
    if (typeof r.t === 'string' && el.getAttribute('${LOCK_TEXT_ATTR}') !== r.t) el.setAttribute('${LOCK_TEXT_ATTR}', r.t);
  }
}
function refresh(){ reapply(); return lockAll(); }
var queued = false;
function schedule(){ if (queued) return; queued = true; setTimeout(function(){ queued = false; refresh(); }, 0); }
function start(){
  readRecipes();
  if (!refresh() && !recipes.length) return;
  if (window.MutationObserver) new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  var tries = 0; var iv = setInterval(function(){ refresh(); if (++tries >= 20) clearInterval(iv); }, 500);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();`;

export function buildEditsRuntimeScript(): string {
  return `<script ${EDITS_RUNTIME_MARKER}>${LANDING_EDITS_RUNTIME_BODY}</script>`;
}

/** `buildEditsRuntimeScript()` só quando o HTML precisa; senão string vazia. */
export function editsRuntimeScriptFor(html: string): string {
  return htmlNeedsEditsRuntime(html) ? buildEditsRuntimeScript() : '';
}
