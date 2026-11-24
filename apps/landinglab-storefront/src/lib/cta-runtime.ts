// Trechos ES5 da Engine V2 (route.ts da landing) para o texto do CTA em
// landings com checkout Stripe — E2E Stripe B-4 (out/2026).
//
// 1. Rótulo: o apply-bundle (worker) grava em data-landing-cta-labels os
//    rótulos do idioma do mercado (só landings Stripe, mercado não-inglês).
//    A Engine V2 reescreve o texto do botão a cada troca de oferta mantendo o
//    "base" do tema ("Add to cart"); aqui trocamos SÓ a frase em inglês
//    conhecida — mesma regex de apps/worker/src/lib/landing-widget-i18n.ts.
// 2. Preço: com o checkbox Subscribe & Save marcado, o CTA mostra o preço
//    recorrente com desconto, com o MESMO arredondamento do servidor
//    (recurringUnitAmount em @blackshop/payments): round(preço × (100 − %) / 100).
//
// As funções são strings porque vão inline no <script> da Engine V2; o teste
// cta-runtime.test.ts as avalia e confere contra os casos esperados.

/** function(text, labels) → text com "Add to cart"/"Buy now" no idioma do mercado. */
export const RELABEL_CTA_RUNTIME_JS = `function(text, labels){
    if(!labels || !labels.addToCart) return text;
    function keep(o, l){ return (o === o.toUpperCase() && o !== o.toLowerCase()) ? l.toUpperCase() : l; }
    return String(text)
      .replace(/\\badd\\s+to\\s+(?:cart|bag|basket)\\b/i, function(m){ return keep(m, labels.addToCart); })
      .replace(/\\bbuy\\s+(?:it\\s+)?now\\b/i, function(m){ return keep(m, labels.buyNow || labels.addToCart); });
  }`;

/** function(priceCents, pct) → valor recorrente (unidade mínima) exibido no CTA. */
export const SUBSCRIPTION_CENTS_RUNTIME_JS = `function(priceCents, pct){
    if(!(pct > 0 && pct < 100)) return priceCents;
    return Math.round(priceCents * (100 - pct) / 100);
  }`;
