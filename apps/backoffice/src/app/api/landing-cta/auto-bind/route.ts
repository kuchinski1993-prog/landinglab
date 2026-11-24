// POST /api/landing-cta/auto-bind — auto-vincula botão de compra + bundle radios.
//
// Wizard V2 Step 5 chama isso depois de criar Shopify product + landing_variants.
// Estratégia REGEX-ONLY (não usa parse5) porque parse5 re-serializa e quebra
// custom elements Shopify como <product-form> e <kaching-bundles-block>.
//
// Anotações aplicadas:
//   1. <button name="add"> (ProductSubmitButton) recebe data-landing-cta="buy"
//      + type="submit" → type="button" (não submete form pai que iria pra 404).
//   2. Os N primeiros <div data-deal-bar-id="..."> (widget Kaching real)
//      recebem data-landing-variant-id + data-landing-qty.
//   3. Script inline em </body> intercepta clicks/submits e faz POST /landing-checkout.
//
// Idempotente: skipp elementos que já têm os data-attrs.

import { landingPages, landingVariants } from '@blackshop/db/schema-landinglab-core';
import { and, asc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { getDb } from '@/lib/landing-db';
import { buildRateLimitResponse, getClientIdentity, rateLimit } from '@/lib/rate-limit';
import { requireVerifiedApiSession } from '@/lib/session';
const STORE_ID = 'l0i';

export const runtime = 'nodejs';
export const maxDuration = 30;

interface PostBody {
  landingId?: string;
}

const CHECKOUT_SCRIPT = `<script>(function(){
  var API = window.__LL_CHECKOUT_API__ || '/api/landing-checkout';
  function readCookie(name){
    var m = document.cookie.match(new RegExp('(?:^|;\\\\s*)' + name + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function readQuery(){
    var out = {};
    var s = window.location.search.slice(1);
    if(!s) return out;
    var parts = s.split('&');
    for(var i=0; i<parts.length; i++){
      var kv = parts[i].split('=');
      if(kv[0]) out[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1]||'');
    }
    return out;
  }
  function collectAttribution(){
    var q = readQuery();
    var pick = function(k){ return q[k] || readCookie(k) || null; };
    return {
      fbclid: pick('fbclid'), fbp: readCookie('_fbp'), fbc: readCookie('_fbc'),
      utmSource: pick('utm_source'), utmMedium: pick('utm_medium'),
      utmCampaign: pick('utm_campaign'), utmContent: pick('utm_content'),
      utmTerm: pick('utm_term')
    };
  }
  function findActiveVariantId(){
    var active = document.querySelector('[data-landing-variant-active="true"]');
    if(active) return active.getAttribute('data-landing-variant-id');
    var first = document.querySelector('[data-landing-variant-id]:not([data-landing-cta])');
    return first ? first.getAttribute('data-landing-variant-id') : null;
  }
  // Variants Shopify já são packs — sempre qty=1 no checkout pra não multiplicar preço.
  function findActiveQty(){ return 1; }
  function findBundleQtyForPixel(){
    var a = document.querySelector('[data-landing-variant-active="true"]');
    if(a){ var q = a.getAttribute('data-landing-qty'); if(q) return parseInt(q, 10) || 1; }
    return 1;
  }
  function findSellingPlanId(){
    var active = document.querySelector('[data-landing-variant-active="true"]');
    if(active){
      var form = active.closest('form') || active.querySelector('form');
      if(form){
        var inp = form.querySelector('input[name="selling_plan"]');
        if(inp && inp.value) return inp.value;
      }
    }
    var inputs = document.querySelectorAll('input[name="selling_plan"]');
    for(var i=0; i<inputs.length; i++){
      if(inputs[i].value && inputs[i].value.trim() !== '') return inputs[i].value;
    }
    return null;
  }
  function findLandingPageId(){
    var el = document.querySelector('[data-landing-page-id]');
    return el ? el.getAttribute('data-landing-page-id') : null;
  }
  function checkout(landingVariantId, qty){
    if(!landingVariantId){ alert('Este botão ainda não foi configurado.'); return; }
    var sellingPlanId = findSellingPlanId();
    try {
      if (typeof window.fbq === 'function') {
        window.fbq('track', 'InitiateCheckout', {
          content_ids: [landingVariantId],
          num_items: findBundleQtyForPixel(),
          subscription: sellingPlanId ? true : false,
        });
      }
    } catch (_) {}
    var item = { landingVariantId: landingVariantId, qty: qty || 1 };
    if(sellingPlanId) item.sellingPlanId = sellingPlanId;
    var body = {
      cartItems: [item],
      attribution: collectAttribution(),
      landingPageId: findLandingPageId()
    };
    fetch(API, {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function(r){ return r.json(); }).then(function(d){
      if(d && d.checkoutUrl){ window.location.assign(d.checkoutUrl); }
      else { alert('Não foi possível iniciar o pagamento.'); }
    }).catch(function(){ alert('Erro de conexão. Tente novamente.'); });
  }
  var lastFbqVid = null;
  function applyDefaultActive(){
    // Sempre respeita o que o Kaching selecionou visualmente (--selected).
    // Se não existir ainda, cai no primeiro bundle.
    var preSelected = document.querySelector('[data-landing-variant-id]:not([data-landing-cta]).kaching-bundles__bar--selected');
    if(!preSelected){
      preSelected = document.querySelector('[data-landing-variant-id]:not([data-landing-cta])');
    }
    if(!preSelected) return;
    var current = document.querySelector('[data-landing-variant-active="true"]');
    if(current === preSelected){
      // já sincronizado, mas ainda dispara fbq se mudou
      var vid0 = preSelected.getAttribute('data-landing-variant-id');
      var qty0 = parseInt(preSelected.getAttribute('data-landing-qty') || '1', 10);
      if(vid0 && vid0 !== lastFbqVid){ lastFbqVid = vid0; fireAddToCart(vid0, qty0); }
      return;
    }
    // Sincroniza: limpa outros e marca o preSelected
    var all = document.querySelectorAll('[data-landing-variant-id]:not([data-landing-cta])');
    for(var i=0; i<all.length; i++){
      if(all[i] !== preSelected){
        all[i].removeAttribute('data-landing-variant-active');
        all[i].setAttribute('aria-checked', 'false');
      }
    }
    preSelected.setAttribute('data-landing-variant-active', 'true');
    preSelected.setAttribute('aria-checked', 'true');
    // Dispara fbq AddToCart quando active muda (bundle novo selecionado)
    var vid = preSelected.getAttribute('data-landing-variant-id');
    var qty = parseInt(preSelected.getAttribute('data-landing-qty') || '1', 10);
    if(vid && vid !== lastFbqVid){ lastFbqVid = vid; fireAddToCart(vid, qty); }
  }
  // Aguarda Kaching hidratar (--selected aparece async) por até 3s, polling 200ms.
  function waitForKachingReady(cb){
    var tries = 0;
    var iv = setInterval(function(){
      tries++;
      var hasSelected = !!document.querySelector('[data-landing-variant-id]:not([data-landing-cta]).kaching-bundles__bar--selected');
      if(hasSelected || tries >= 15){ clearInterval(iv); cb(); }
    }, 200);
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', function(){ waitForKachingReady(applyDefaultActive); });
  } else { waitForKachingReady(applyDefaultActive); }
  // Também re-sincroniza sempre que o Kaching mudar --selected (via MutationObserver).
  // Isso resolve o problema do cliente clicar num bundle e Kaching mover o --selected
  // pra outro elemento — nosso data-landing-variant-active fica sempre em sincronia.
  function observeKachingSelected(){
    var kb = document.querySelector('kaching-bundles');
    if(!kb) { setTimeout(observeKachingSelected, 500); return; }
    var obs = new MutationObserver(function(){ applyDefaultActive(); });
    obs.observe(kb, { attributes: true, subtree: true, attributeFilter: ['class'] });
  }
  observeKachingSelected();
  // AddToCart debounce — evita spammar Meta com mesmo bundle várias vezes
  var lastAddToCartVid = null;
  function fireAddToCart(vid, qty){
    if(!vid || lastAddToCartVid === vid) return;
    lastAddToCartVid = vid;
    try {
      if(typeof window.fbq === 'function'){
        window.fbq('track', 'AddToCart', {
          content_ids: [vid],
          num_items: qty || 1,
        });
      }
    } catch(_) {}
  }
  // Bundle click: NÃO interceptamos. Kaching gerencia seleção nativa e
  // MutationObserver acima sincroniza data-landing-variant-active com --selected.

  // Botão universal de comprar (data-landing-cta=buy sem variantId — usa a ativa)
  document.addEventListener('click', function(e){
    var t = e.target;
    while(t && t !== document.body){
      if(t.getAttribute && t.getAttribute('data-landing-cta') === 'buy' && !t.getAttribute('data-landing-variant-id')){
        e.preventDefault(); e.stopPropagation();
        if(e.stopImmediatePropagation) e.stopImmediatePropagation();
        var vid = findActiveVariantId();
        checkout(vid, findActiveQty());
        return;
      }
      t = t.parentElement;
    }
  }, true);
  document.addEventListener('submit', function(e){
    var form = e.target;
    if(!form || !form.action) return;
    if(form.action.indexOf('/cart/add') !== -1){
      e.preventDefault(); e.stopPropagation();
      var vid = findActiveVariantId();
      checkout(vid, findActiveQty());
    }
  }, true);
})();</script>`;

const SCRIPT_START_MARKER = '<script>(function(){\n  var API = window.__LL_CHECKOUT_API__';
const SCRIPT_END_MARKER = '})();</script>';

// Remove ALL previous injections of our script (idempotência).
// Boundary matching by markers (nao regex greedy).
function removeOldScripts(html: string): string {
  let out = html;
  let startIdx = out.indexOf(SCRIPT_START_MARKER);
  while (startIdx !== -1) {
    const endIdx = out.indexOf(SCRIPT_END_MARKER, startIdx);
    if (endIdx === -1) break;
    out = out.substring(0, startIdx) + out.substring(endIdx + SCRIPT_END_MARKER.length);
    startIdx = out.indexOf(SCRIPT_START_MARKER);
  }
  return out;
}

function annotateAddToCartButton(html: string): { html: string; count: number } {
  const buttonRx = /<button([^>]*\bname="add"[^>]*)>/gi;
  let count = 0;
  const out = html.replace(buttonRx, (_match, attrs: string) => {
    count++;
    let newAttrs = attrs.replace(/\btype="submit"/i, 'type="button"');
    if (!/data-landing-cta=/.test(newAttrs)) {
      newAttrs = ` data-landing-cta="buy" data-landing-qty="1"` + newAttrs;
    }
    return `<button${newAttrs}>`;
  });
  return { html: out, count };
}

// Reconhece 2 formatos de bundle:
//   1. LandingLab bundle padrão: <div class="ll-bundle__slot" data-slot-index="N">
//   2. Kaching Bundles (bepurex): <div data-deal-bar-id="..."> dentro de <kaching-bundles-block>
function annotateBundles(
  html: string,
  lvRows: Array<{ id: string; qty: number | null }>,
): { html: string; count: number } {
  // Estratégia 1: LandingLab bundle padrão (prioridade)
  if (/<[a-z]+\b[^>]*data-landinglab-bundle="v1"/i.test(html)) {
    const slotRx = /<div\b([^>]*\bclass="ll-bundle__slot"[^>]*\bdata-slot-index="(\d+)"[^>]*)>/gi;
    const positions: Array<{ start: number; end: number; attrs: string; idx: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = slotRx.exec(html)) !== null) {
      const idx = parseInt(m[2] ?? '0', 10);
      if (idx >= lvRows.length) continue;
      positions.push({
        start: m.index,
        end: m.index + m[0].length,
        attrs: m[1] ?? '',
        idx,
      });
    }
    let out = html;
    let modified = 0;
    for (let i = positions.length - 1; i >= 0; i--) {
      const pos = positions[i]!;
      const lv = lvRows[pos.idx]!;
      if (pos.attrs.includes('data-landing-variant-id')) continue;
      const newTag = `<div${pos.attrs} data-landing-variant-id="${lv.id}" data-landing-qty="${lv.qty ?? 1}">`;
      out = out.substring(0, pos.start) + newTag + out.substring(pos.end);
      modified++;
    }
    return { html: out, count: modified };
  }

  // Estratégia 2: Kaching Bundles (legado, bepurex-style)
  const kbStart = html.indexOf('<kaching-bundles-block');
  if (kbStart === -1) return { html, count: 0 };
  const kbEnd = html.indexOf('</kaching-bundles-block>', kbStart);
  if (kbEnd === -1) return { html, count: 0 };

  const blockHtml = html.substring(kbStart, kbEnd);
  const dealBarRx = /<div\b([^>]*\bdata-deal-bar-id="[^"]+"[^>]*)>/gi;
  const positions: Array<{ start: number; end: number; attrs: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = dealBarRx.exec(blockHtml)) !== null) {
    if (positions.length >= lvRows.length) break;
    positions.push({
      start: kbStart + m.index,
      end: kbStart + m.index + m[0].length,
      attrs: m[1] ?? '',
    });
  }

  let out = html;
  let modified = 0;
  for (let i = positions.length - 1; i >= 0; i--) {
    const pos = positions[i]!;
    const lv = lvRows[i]!;
    if (pos.attrs.includes('data-landing-variant-id')) continue;
    const newTag = `<div data-landing-variant-id="${lv.id}" data-landing-qty="${lv.qty ?? 1}"${pos.attrs}>`;
    out = out.substring(0, pos.start) + newTag + out.substring(pos.end);
    modified++;
  }
  return { html: out, count: modified };
}

function injectCheckoutScript(html: string): string {
  const cleaned = removeOldScripts(html);
  if (cleaned.includes('</body>')) {
    return cleaned.replace('</body>', CHECKOUT_SCRIPT + '</body>');
  }
  return cleaned + CHECKOUT_SCRIPT;
}

export async function POST(req: Request): Promise<Response> {
  // Épico 0 · 0.1 — sessão verificada na API (não basta o cookie existir).
  const authError = await requireVerifiedApiSession(req);
  if (authError) return authError;

  const rl = await rateLimit(`cta-auto-bind:${getClientIdentity(req)}`, 30, 60 * 60 * 1000);
  if (!rl.ok) return buildRateLimitResponse(rl.resetAt);

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ ok: false, message: 'JSON inválido' }, { status: 400 });
  }

  const { landingId } = body;
  if (!landingId) {
    return NextResponse.json({ ok: false, message: 'landingId obrigatório' }, { status: 400 });
  }

  const db = getDb();

  const [landing] = await db
    .select({ htmlBody: landingPages.htmlBody })
    .from(landingPages)
    .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)))
    .limit(1);
  if (!landing) {
    return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });
  }
  if (!landing.htmlBody) {
    return NextResponse.json(
      { ok: false, message: 'Landing sem HTML' },
      { status: 400 },
    );
  }

  const lvRows = await db
    .select({
      id: landingVariants.id,
      qty: landingVariants.quantityOfItems,
    })
    .from(landingVariants)
    .where(eq(landingVariants.landingPageId, landingId))
    .orderBy(asc(landingVariants.sortOrder));

  if (lvRows.length === 0) {
    return NextResponse.json(
      { ok: false, message: 'Nenhum landing_variant vinculado. Crie produto Shopify primeiro (Step 5).' },
      { status: 400 },
    );
  }

  let html = landing.htmlBody;

  const buttonResult = annotateAddToCartButton(html);
  html = buttonResult.html;

  const bundleResult = annotateBundles(html, lvRows);
  html = bundleResult.html;

  html = injectCheckoutScript(html);

  await db
    .update(landingPages)
    .set({
      htmlBody: html,
      updatedAt: new Date(),
    })
    .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)));

  return NextResponse.json({
    ok: true,
    variantsAvailable: lvRows.length,
    buttonsAnnotated: buttonResult.count,
    bundlesAnnotated: bundleResult.count,
    message: `${buttonResult.count} botão(ões) + ${bundleResult.count} bundle(s) anotados. Checkout pronto.`,
  });
}
