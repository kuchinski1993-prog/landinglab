// Bundle Runtime Injector (set/2026, Engine V2).
//
// Injeta script universal no HTML clonado que:
//   1. Lê window.__LL_BUNDLE_OFFERS__ (injetado pelo storefront do banco)
//   2. Popula elementos com data-ll-price / data-ll-compare / data-ll-save
//      dentro de cada [data-ll-offer="N"]
//   3. Formata valores na moeda configurada
//   4. Click num card [data-ll-offer] ativa (visualmente) + atualiza CTA
//   5. Click no [data-ll-cta="buy"] redireciona pra {shopifyStoreUrl}/cart/{variant_id}:{qty}
//
// Idempotente: script pode rodar múltiplas vezes sem side-effects.
// Zero deps (ES5 puro).

import * as cheerio from 'cheerio';

const BUNDLE_RUNTIME_SCRIPT = `
(function(){
  'use strict';
  if (window.__LL_BUNDLE_RUNTIME_LOADED__) return;
  window.__LL_BUNDLE_RUNTIME_LOADED__ = true;

  var CURRENCY_SYMBOLS = {
    EUR: '€', USD: '$', GBP: '£', BRL: 'R$', CAD: 'C$', AUD: 'A$',
    CHF: 'CHF ', JPY: '¥', PLN: 'zł', SEK: 'kr', NOK: 'kr', DKK: 'kr'
  };
  // fractionDigits injetado pelo servidor via Intl.NumberFormat (0=JPY, 2=USD/EUR/...).
  var FRACTION_DIGITS = __FRACTION_DIGITS__;
  var DIVISOR = Math.pow(10, FRACTION_DIGITS);

  function addThousands(s) {
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function formatPrice(cents, currency) {
    var symbol = CURRENCY_SYMBOLS[String(currency).toUpperCase()] || String(currency);
    var major = cents / DIVISOR;
    var value = FRACTION_DIGITS === 0
      ? addThousands(String(Math.round(major)))
      : addThousands(major.toFixed(FRACTION_DIGITS));
    return symbol + value;
  }

  function populateCards() {
    var data = window.__LL_BUNDLE_OFFERS__;
    if (!data || !Array.isArray(data.offers)) return;
    var currency = data.currency || 'USD';
    var shopifyUrl = data.shopifyStoreUrl || '';

    data.offers.forEach(function(offer, idx) {
      var card = document.querySelector('[data-ll-offer="' + idx + '"]');
      if (!card) return;

      // Preço principal
      var priceEl = card.querySelector('[data-ll-price]');
      if (priceEl) priceEl.textContent = formatPrice(offer.priceCents, currency);

      // Compare-at (riscado)
      var compareEl = card.querySelector('[data-ll-compare]');
      if (compareEl) {
        if (offer.compareAtCents && offer.compareAtCents > offer.priceCents) {
          compareEl.textContent = formatPrice(offer.compareAtCents, currency);
          compareEl.style.display = '';
        } else {
          compareEl.style.display = 'none';
        }
      }

      // Save text
      var saveEl = card.querySelector('[data-ll-save]');
      if (saveEl) {
        saveEl.textContent = offer.saveText || '';
        saveEl.style.display = offer.saveText ? '' : 'none';
      }

      // Marca variant_id no card pro CTA usar
      if (offer.variantId) card.setAttribute('data-ll-variant-id', String(offer.variantId));
      if (offer.qty) card.setAttribute('data-ll-qty', String(offer.qty));

      // Preseleção
      if (offer.isPreselected) {
        card.setAttribute('data-ll-active', 'true');
      }
    });

    // Se nenhum preselected, ativa o primeiro
    if (!document.querySelector('[data-ll-active="true"]')) {
      var first = document.querySelector('[data-ll-offer="0"]');
      if (first) first.setAttribute('data-ll-active', 'true');
    }
  }

  function wireCardClicks() {
    var cards = document.querySelectorAll('[data-ll-offer]');
    cards.forEach(function(card) {
      if (card.__llCardInit) return;
      card.__llCardInit = true;
      card.style.cursor = 'pointer';
      card.style.pointerEvents = 'auto';
      card.addEventListener('click', function(e) {
        // Se click veio de um <a>, [data-ll-cta="buy"], ou input radio,
        // deixa passar pro CTA handler / label default.
        var target = e.target;
        if (target && target.closest && target.closest('[data-ll-cta="buy"]')) return;
        // Desativa todos
        cards.forEach(function(other) {
          other.removeAttribute('data-ll-active');
          // Remove TODAS as classes visuais conhecidas de app bundlers
          other.classList.remove(
            'is-selected','is-highlighted','is-active','selected','active',
            'kaching-bundles__bar--selected','kaching-bundles__bar--focused'
          );
          // Desmarca radio interno (Kaching usa <input type=radio>)
          var radios = other.querySelectorAll('input[type="radio"]');
          for (var i = 0; i < radios.length; i++) radios[i].checked = false;
        });
        // Ativa este — usa TODAS as classes visuais conhecidas (idempotente)
        card.setAttribute('data-ll-active', 'true');
        card.classList.add(
          'is-selected','is-highlighted',
          'kaching-bundles__bar--selected'
        );
        // Marca radio interno (se existe)
        var myRadio = card.querySelector('input[type="radio"]');
        if (myRadio) {
          myRadio.checked = true;
          // Dispara change event pra qualquer listener genérico do tema
          try { myRadio.dispatchEvent(new Event('change', { bubbles: true })); } catch(_){}
        }
      }, true);
    });
  }

  function wireCta() {
    var ctas = document.querySelectorAll('[data-ll-cta="buy"]');
    ctas.forEach(function(cta) {
      if (cta.__llCtaInit) return;
      cta.__llCtaInit = true;
      cta.addEventListener('click', function(e) {
        var data = window.__LL_BUNDLE_OFFERS__;
        if (!data) return; // sem config, deixa comportamento default
        var shopifyUrl = data.shopifyStoreUrl || '';
        if (!shopifyUrl) return;

        var active = document.querySelector('[data-ll-active="true"]') ||
                     document.querySelector('[data-ll-offer="0"]');
        if (!active) return;

        var variantId = active.getAttribute('data-ll-variant-id');
        var qty = parseInt(active.getAttribute('data-ll-qty') || '1', 10);
        if (!variantId) return; // sem variant, não redireciona

        e.preventDefault();
        e.stopPropagation();
        // Shopify /cart/{variant}:{qty} adiciona e redireciona pro cart
        var target = shopifyUrl.replace(/\\/$/, '') + '/cart/' + encodeURIComponent(variantId) + ':' + qty;
        window.location.href = target;
      }, true);
    });
  }

  function init() {
    populateCards();
    wireCardClicks();
    wireCta();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  // Re-run em MutationObserver leve pra pegar cards que aparecem via JS (Bundler apps)
  var attempts = 0;
  var timer = setInterval(function() {
    init();
    attempts++;
    if (attempts > 10) clearInterval(timer);
  }, 500);
})();
`;

/**
 * CSS scoped que garante que cards do runtime sejam clicáveis mesmo com
 * pointer-events:none herdado de sub-elementos. Adiciona indicador visual
 * pro card ativo além das classes de tema.
 */
const BUNDLE_RUNTIME_CSS = `
  [data-ll-offer]{cursor:pointer!important;pointer-events:auto!important}
  [data-ll-offer] *{pointer-events:auto}
  [data-ll-offer][data-ll-active="true"]{outline:2px solid #10b981;outline-offset:2px}
`;

/**
 * Injeta o runtime script no HTML clonado. Idempotente — remove versão
 * anterior antes de injetar (via marker).
 *
 * `fractionDigits` vem do servidor via Intl.NumberFormat (0=JPY, 2=USD/EUR...).
 * Padrão 2 garante backwards-compat para clones sem currency configurada.
 */
export function injectBundleRuntime(html: string, fractionDigits = 2): string {
  const script = BUNDLE_RUNTIME_SCRIPT.replace('__FRACTION_DIGITS__', String(fractionDigits));
  const $ = cheerio.load(html);
  $('style[data-landinglab-bundle-runtime]').remove();
  $('script[data-landinglab-bundle-runtime]').remove();
  $('head').append(
    `<style data-landinglab-bundle-runtime>${BUNDLE_RUNTIME_CSS}</style>`,
  );
  $('body').append(
    `<script data-landinglab-bundle-runtime>${script}</script>`,
  );
  return $.html();
}
