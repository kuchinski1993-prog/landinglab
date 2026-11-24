// landing-offers.js — vai nos dois pacotes de export (zip HTML e seção Shopify).
//
// Fonte das ofertas, nesta ordem:
//   1. window.__LL_OFFERS__ (a seção Shopify escreve a partir das variantes reais);
//   2. offers.json ao lado do index.html (zip HTML, servido por http);
//   3. <script id="ll-offers-inline" type="application/json"> (zip aberto via file://).
//
// Cards: [data-ll-offer] se existirem; senão os cards do Kaching ([data-deal-bar-id]).
// Card N ↔ oferta N. Clique no card = oferta ativa. Clique no botão de compra = checkoutUrl
// da oferta ativa. Mesma lista de botões que o storefront do BlackShop usa.
//
// Story 25.2: preenche título, selo, bullets, preço, riscado e economia nos elementos marcados
// pelo clonador (data-ll-title, data-ll-badge, data-ll-bullets, data-ll-price…) e no bloco do
// sistema (.ll-sys-offer__*), para que editar offers.json / os blocos Oferta mude a página.

export const LANDING_OFFERS_JS = `/* landing-offers.js — gerado pelo BlackShop. Ver CLAUDE.md. */
(function(){
  'use strict';
  var CTA_SELECTORS = [
    '[data-ll-cta]',
    '[data-landing-cta="buy"]',
    'button[name="add"]',
    '.pss-atc-button',
    '.cc-pdp-buy-buttons button',
    '.cc-pdp__buy-cta',
    '[data-atc-button]'
  ];
  var state = { offers: [], active: 0, currency: 'EUR', locale: undefined };

  function loadOffers(){
    if (window.__LL_OFFERS__) return Promise.resolve(window.__LL_OFFERS__);
    var inline = function(){
      var el = document.getElementById('ll-offers-inline');
      try { return el ? JSON.parse(el.textContent || '{}') : {}; } catch (e) { return {}; }
    };
    if (location.protocol === 'file:') return Promise.resolve(inline());
    return fetch('offers.json', { cache: 'no-store' })
      .then(function(r){ if (!r.ok) throw new Error(r.status); return r.json(); })
      .catch(function(){ console.warn('[landing-offers] offers.json indisponível, usando a cópia embutida'); return inline(); });
  }

  function fmt(value){
    if (typeof value !== 'number' || !isFinite(value)) return '';
    try { return new Intl.NumberFormat(state.locale, { style: 'currency', currency: state.currency }).format(value); }
    catch (e) { return value.toFixed(2) + ' ' + state.currency; }
  }

  function priceText(o){ return o.priceFormatted || fmt(o.price); }
  function compareText(o){ return o.compareAtFormatted || fmt(o.compareAt); }

  // Story 26.2: texto editado no editor visual (data-ll-lock-text) não é sobrescrito.
  function locked(el){ return !!(el.closest && el.closest('[data-ll-lock-text]')); }

  function setText(root, sel, text){
    if (text == null || text === '') return;
    var els = root.querySelectorAll(sel);
    for (var i = 0; i < els.length; i++) if (!locked(els[i]) && els[i].textContent !== text) els[i].textContent = text;
  }

  function each(root, sel, fn){
    var els = root.querySelectorAll(sel);
    for (var i = 0; i < els.length; i++) if (!locked(els[i])) fn(els[i]);
  }

  function showText(root, sel, text){
    each(root, sel, function(el){
      if (text) { if (el.textContent !== text) el.textContent = text; el.style.display = ''; }
      else el.style.display = 'none';
    });
  }

  // Título do bloco do sistema tem o "×N" num span: troca só o texto antes dele.
  function setTitle(root, text){
    if (!text) return;
    each(root, '[data-ll-offer-title], [data-ll-title], .kaching-bundles__bar-title, .ll-sys-offer__title', function(el){
      var qty = el.querySelector('.ll-sys-offer__qty');
      if (!qty) { if (el.textContent !== text) el.textContent = text; return; }
      var t = el.firstChild;
      if (t && t.nodeType === 3) { if (t.nodeValue !== text) t.nodeValue = text; }
      else el.insertBefore(document.createTextNode(text), qty);
    });
  }

  function setBullets(root, list){
    if (!list || !list.length) return;
    var key = list.join('\\n');
    each(root, '[data-ll-bullets], .ll-sys-offer__bullets', function(el){
      if (el.getAttribute('data-ll-bullets-filled') === key) return;
      var li = /^(UL|OL)$/.test(el.tagName);
      el.innerHTML = '';
      for (var i = 0; i < list.length; i++) {
        var n = document.createElement(li ? 'li' : 'span');
        n.textContent = String(list[i]);
        if (!li) n.style.display = 'block';
        el.appendChild(n);
      }
      el.setAttribute('data-ll-bullets-filled', key);
    });
  }

  function fillCard(card, o){
    setTitle(card, o.title);
    showText(card, '[data-ll-offer-badge], [data-ll-badge], .ll-sys-offer__badge', o.badge);
    setBullets(card, o.bullets);
    setText(card, '[data-ll-offer-price], [data-ll-price], .ll-sys-offer__price', priceText(o));
    showText(card, '[data-ll-offer-compare], [data-ll-compare], .ll-sys-offer__compare', compareText(o));
    setText(card, '[data-ll-save], .ll-sys-offer__save', o.saveText);
  }

  function cards(){
    var own = document.querySelectorAll('[data-ll-offer]');
    if (own.length) return Array.prototype.slice.call(own);
    return Array.prototype.slice.call(document.querySelectorAll('[data-deal-bar-id]'));
  }

  var bound = false;
  function bindCards(){
    var list = cards();
    if (!list.length || bound) return false;
    bound = true;
    list.slice(0, state.offers.length).forEach(function(card, i){
      var o = state.offers[i];
      card.setAttribute('data-ll-offer', String(i));
      fillCard(card, o);
      card.addEventListener('click', function(){ setActive(i); }, false);
    });
    return true;
  }

  function setActive(i){
    state.active = i;
    cards().forEach(function(card, j){
      if (j === i) {
        card.setAttribute('data-ll-offer-active', 'true');
        card.setAttribute('data-landing-variant-active', 'true');
      } else {
        card.removeAttribute('data-ll-offer-active');
        card.removeAttribute('data-landing-variant-active');
      }
      if (card.getAttribute('role') === 'radio') card.setAttribute('aria-checked', j === i ? 'true' : 'false');
    });
    var o = state.offers[i];
    if (o) setText(document, '[data-ll-cta-price]', priceText(o));
  }

  function go(e){
    var o = state.offers[state.active];
    if (e) { e.preventDefault(); e.stopImmediatePropagation(); }
    if (!o || !o.checkoutUrl) { console.warn('[landing-offers] oferta sem checkoutUrl — preencha em offers.json'); return; }
    window.location.href = o.checkoutUrl;
  }

  var submitBound = false;
  function bindCtas(){
    CTA_SELECTORS.forEach(function(sel){
      var els = document.querySelectorAll(sel);
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.__llBound || el.closest('cart-drawer, .cart-drawer')) continue;
        // Clona para soltar os listeners do tema (add-to-cart da loja de origem).
        var clone = el.cloneNode(true);
        clone.__llBound = true;
        clone.setAttribute('data-ll-cta', '');
        if (clone.getAttribute('type') === 'submit') clone.setAttribute('type', 'button');
        clone.addEventListener('click', go, true);
        el.parentNode && el.parentNode.replaceChild(clone, el);
      }
    });
    if (submitBound) return;
    submitBound = true;
    document.addEventListener('submit', function(e){
      var f = e.target;
      if (f && f.matches && f.matches('form[action*="/cart/add"]')) go(e);
    }, true);
  }

  function start(data){
    state.offers = (data && data.offers) || [];
    state.currency = (data && data.currency) || 'EUR';
    state.locale = (data && data.locale) || undefined;
    if (!state.offers.length) return;
    var pre = 0;
    state.offers.forEach(function(o, i){ if (o.preselected) pre = i; });
    bindCtas();
    var tries = 0;
    var tick = setInterval(function(){
      tries++;
      if (bindCards() || tries > 60) { clearInterval(tick); setActive(pre); bindCtas(); }
    }, 250);
  }

  var run = function(){ loadOffers().then(start); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
`;
