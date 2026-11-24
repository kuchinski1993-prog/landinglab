// LandingLab Fixes Injector — aplica no HTML clonado TODOS os fixes que
// nasceram no processor apply-bundle:
//
//   1. Remove regra CSS "body { zoom: 90% }" do tema (quebra Swiper)
//   2. Remove regras legacy "swiper max-height: 700-780px" (deixa altura auto)
//   3. Injeta CSS override "html,body { zoom:1 !important }" (belt+suspenders)
//   4. Injeta CSS override reviews compact (max-height:none nos wrappers)
//   5. Remove subtitle "Risparmia il 50%" / "Save X%" dos bundles
//   6. Reescreve script[data-cc-pdp-product-json] pra usar currency EUR/USD
//      correto se page.currency estiver setado
//   7. Reescreve preços em <span> do CTA se currency estiver setado
//   8. Descodifica entities double-escaped: "&amp;nbsp;" → " " (NBSP)
//      e limpa NBSP prefixando texto curto (nome autor de review)
//   9. Adiciona contagem de softgels abaixo dos cards de bundle
//      (parseia "Acquista N e ricevi M GRATIS" do texto do card)
//  10. Injeta CSS/JS pro timeline destroy-Swiper fallback (Cosa Aspettarsi)
//
// Zero DB — trabalha só com HTML in-memory. Idempotente por markers próprios.

import * as cheerio from 'cheerio';

export interface FixesInput {
  html: string;
  /** Currency ISO code — se setado, reescreve preços em <script product-json> + spans CTA. */
  currency?: string | null;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€', USD: '$', GBP: '£', BRL: 'R$', CAD: 'C$', AUD: 'A$',
  CHF: 'CHF ', JPY: '¥', PLN: 'zł', SEK: 'kr', NOK: 'kr', DKK: 'kr',
};

function symbolFor(currency: string | null | undefined): string {
  return CURRENCY_SYMBOLS[(currency ?? 'USD').toUpperCase()] ?? '$';
}

/**
 * Aplica todos os fixes ao HTML. Retorna HTML transformado.
 * Não faz retry, não conecta DB. Se qualquer fase falhar, log via console.warn
 * e continua com HTML parcial (nunca throw).
 */
export function injectLandingLabFixes(input: FixesInput): string {
  const $ = cheerio.load(input.html);
  const currencySymbol = symbolFor(input.currency);

  // 1. Remove regras "body { zoom: 90% }" que quebram Swiper
  $('style').each((_, el) => {
    const raw = $(el).html() || '';
    if (!/body\s*\{[^}]*zoom\s*:/i.test(raw)) return;
    const cleaned = raw
      .replace(/body\s*\{[^}]*zoom\s*:\s*[^;}]+;?[^}]*\}/gi, '')
      .replace(/@media[^{]+\{\s*\}/g, '');
    if (cleaned !== raw) $(el).html(cleaned);
  });
  $('style[data-landinglab-nozoom]').remove();
  $('head').append('<style data-landinglab-nozoom>html,body{zoom:1!important}</style>');

  // 1.4. iOS Safari bg universal — meta theme-color + CSS não-media pra
  // eliminar TODA aparência de bg preto default do webview iOS.
  $('meta[name="theme-color"]').remove();
  $('head').prepend('<meta name="theme-color" content="#f8f2f2">');
  $('style[data-landinglab-ios-safari-bg]').remove();
  $('head').append(`<style data-landinglab-ios-safari-bg>
/* iOS Safari: bg universal bege (não @media) pra nunca aparecer preto. */
html { background: #f8f2f2 !important; background-color: #f8f2f2 !important; }
body { background: #f8f2f2 !important; background-color: #f8f2f2 !important; }
main, main.content-for-layout {
  background: #f8f2f2 !important; background-color: #f8f2f2 !important;
}
.shopify-section, div.shopify-section, section.shopify-section {
  background-color: transparent !important;
}
html, body {
  overscroll-behavior-y: none !important; overscroll-behavior-x: none !important;
}
body {
  padding-top: 0 !important;
  padding-bottom: env(safe-area-inset-bottom, 0) !important;
}
/* BUG-IPHONE-BLACK-BAND v6: image wraps com bg escuro #f1e7e3 aparecem como
 * retângulo PRETO gigante no iPhone real quando imagem lazy demora carregar. */
.cc-cis__image-wrap, [class*="cc-cis__image-wrap"],
.cc-pdp__main-video, [class*="__image-wrap"], [class*="__media-wrap"] {
  background: transparent !important; background-color: transparent !important;
}
.cc-cis__image, .cc-cis__image-placeholder, [class*="cc-cis__image"] {
  height: auto !important; max-height: 400px !important;
  aspect-ratio: 16 / 9 !important; object-fit: cover !important; width: 100% !important;
}
</style>`);

  // BUG-SCROLL (commit c1223c8): double-scroll (html+body ambos overflow-y:auto)
  // + Klaviyo body lock trava o scroll no desktop e mobile (tela preta iOS).
  // Fix: só html scrolla, body visible; body.klaviyo-prevent forçado a static.
  $('style#ll-popup-kill, style[id="ll-popup-kill"]').each((_, el) => {
    const txt = $(el).html() || '';
    if (!/html\s*,\s*body\s*\{[^}]*overflow\s*:\s*auto/i.test(txt)) return;
    const cleaned = txt.replace(
      /html\s*,\s*body\s*\{[^}]*overflow[^}]*\}/gi,
      'html { overflow-x: hidden !important; overflow-y: visible !important; } body { overflow-x: hidden !important; overflow-y: auto !important; }'
    );
    if (cleaned !== txt) $(el).html(cleaned);
  });
  $('style[data-landinglab-scroll-fix]').remove();
  $('head').append(`<style data-landinglab-scroll-fix>
html {
  overflow-y: visible !important;
  overflow-x: visible !important;
  overscroll-behavior-y: contain !important;
  overscroll-behavior-x: contain !important;
}
body {
  overflow-y: auto !important;
  overflow-x: hidden !important;
  overscroll-behavior: auto !important;
  -webkit-overflow-scrolling: touch !important;
  position: static !important;
}
body.klaviyo-prevent-body-scrolling,
body[class*="klaviyo-prevent"] {
  overflow-y: auto !important;
  overflow-x: hidden !important;
  position: static !important;
  padding-right: 0 !important;
  height: auto !important;
}
</style>`);

  // BUG-IPHONE-BLACK-BAND v6: eager loading em imagens hero de cc-cis + expert-quote + faq
  // pra evitar o placeholder escuro gigante que aparece no 4G iPhone real.
  $('.cc-cis__image, [class*="cc-cis__image"], .cc-expert-quote__image, .cc-faq__image').each((_, el) => {
    const $el = $(el);
    if ($el.attr('loading') === 'lazy') {
      $el.attr('loading', 'eager');
      $el.attr('fetchpriority', 'high');
    }
  });

  // PERF-LCP: imagem hero do tema Shopify padrão (galeria principal do produto)
  // é o LCP candidate mais comum em landings clonadas de Shopify. Está lazy por
  // padrão no tema — isso atrasa LCP desnecessariamente pois está above-the-fold.
  // Seletores cobrem: Shopify default theme (.image-magnify-none), media gallery
  // (.product__media img:first-child), e Kaching-based layouts.
  $('body').find('img.image-magnify-none').first().each((_, el) => {
    const $img = $(el);
    if ($img.attr('loading') !== 'eager') {
      $img.attr('loading', 'eager');
      $img.attr('fetchpriority', 'high');
      $img.removeAttr('decoding'); // eager implica high priority; decoding=sync não adiciona nada
    }
  });
  // Fallback: primeira imagem da galeria de produto Shopify quando classe não existe
  $('[class*="product__media"] img, [class*="media-gallery"] img, [class*="product-media"] img')
    .first().each((_, el) => {
      const $img = $(el);
      if ($img.attr('loading') !== 'eager' && !$img.hasClass('image-magnify-none')) {
        $img.attr('loading', 'eager');
        $img.attr('fetchpriority', 'high');
      }
    });

  // 1.5. Mobile fixes cirúrgicos — bugs específicos identificados em audit.
  $('style[data-landinglab-mobile-fix]').remove();
  $('head').append(`<style data-landinglab-mobile-fix>
@media (max-width: 768px){
  html, body {
    overflow-x: hidden !important; max-width: 100vw !important;
    /* BUG-BLACKGAP: tema Shopify seta html+body height:100% + overflow:auto,
     * criando double-scrollbar + área preta gigante entre conteúdo e footer no iPhone. */
    height: auto !important; min-height: 100% !important; overflow-y: visible !important;
  }
  /* BUG-BLACKGAP v5: kill bg problems em MOBILE @media (v5 nuclear já injeta
   * FORA de @media pra cobrir todos viewports iOS). */
  html, body {
    background: #f8f2f2 !important; background-color: #f8f2f2 !important;
  }
  .aurivita-stats, .avs__mobile-track, .cc-benefits-marquee, [class*="__marquee"]{
    max-width: 100vw !important; overflow-x: hidden !important;
  }
  .cc-pdp-progress__button{ white-space: normal !important; max-width: 100% !important; }
  /* BUG-05: hero mobile — sem badges laterais, imagem full width */
  .cc-pdp__main-column .cc-pdp__badges,
  .cc-pdp__gallery-layout .cc-pdp__extra-column{ display: none !important; }
  .cc-pdp__gallery-layout{ grid-template-columns: 1fr !important; }
  /* BUG-11: reviews slider padding */
  .cc-customer-notice__swiper{ padding-right: 24px !important; box-sizing: border-box; }
  /* BUG-ADV-01: GP-ROW 4-col não quebra palavras */
  gp-row.gp-grid p, gp-row.gp-grid span, gp-row.gp-grid strong{
    overflow-wrap: normal !important; word-break: normal !important; hyphens: none !important;
  }
  /* BUG-ADV-MOBILE (audit iPhone prints 19:56): gp-row com background-image cover
   * cria seções gigantes 900-1200px + imagens distorcidas em 2-col. Sales-page style. */
  gp-row[style*="background-image"], gp-row.gp-grid[style*="background-image"], gp-row[class*="gp-grid"]{
    background-size: cover !important; background-repeat: no-repeat !important; background-position: center !important;
  }
  gp-row.gp-grid{ min-height: auto !important; }
  gp-container[class*="grid-cols-2"], gp-container[class*="grid-cols-3"], gp-container[class*="grid-cols-4"]{
    grid-template-columns: 1fr !important; display: block !important;
  }
  gp-container > *{ width: 100% !important; }
  /* BUG-ADV-MOBILE v2: seletores CORRETOS pra GemPages advertorial.
   * <img> tem gp-inline-block.gp-w-full (não gp-image). Wrapper é .gp-group/image. */
  img.gp-inline-block, img.gp-w-full, img[class*="gp-w-full"], img[class*="gp-inline-block"],
  picture > img, .gp-group\\/image img, [class*="gp-group"] img{
    max-height: 320px !important; height: auto !important; width: 100% !important;
    object-fit: cover !important; object-position: center !important;
  }
  .gp-group\\/image, [class*="gp-group"][class*="image"], div.gp-h-full.gp-w-full.gp-flex{
    max-height: 320px !important; height: auto !important; overflow: hidden !important;
  }
  gp-image, gp-container, [class*="gp-image"], gp-row *{
    --h-mobile: auto !important; --h-tablet: auto !important; --h: auto !important;
  }
  gp-row.gp-grid > div[class*="gp-relative"], gp-row.gp-grid > div[class*="gp-flex-col"]{
    max-height: none !important; min-height: auto !important;
  }
  img[width="100%"]{ width: 100% !important; height: auto !important; }
  picture.gp-contents{ display: block !important; }
  gp-row.gp-grid p strong, gp-row.gp-grid div strong, gp-container p strong{
    margin-right: 0.15em !important; margin-left: 0.15em !important;
  }
  gp-heading, [class*="gp-heading"], gp-container h1, gp-container h2, gp-container h3{
    line-height: 1.15 !important; padding-top: 4px !important; padding-bottom: 4px !important;
    overflow: visible !important;
  }
  footer img[src*="logo"], footer [class*="logo"] img, .cc-footer__logo img{
    max-height: 60px !important; width: auto !important; max-width: 200px !important;
    position: relative !important; z-index: 1 !important;
  }
  footer a, footer nav, .cc-footer__menu-list{ position: relative !important; z-index: 2 !important; }
  /* BUG-08: AVS swipe suave com snap */
  .avs__mobile-track{
    scroll-snap-type: x mandatory !important; scroll-behavior: smooth !important;
    padding-left: 16px !important; padding-right: 16px !important;
  }
  .avs__card--mobile{ scroll-snap-align: center !important; flex-shrink: 0 !important; }
  /* BUG-P4 (iPhone real): .cc-how-to-take__card usa grid 126px 225px que espreme
     imagem em faixa vertical de 126px. Em mobile: 1-col vertical (imagem cima, texto embaixo). */
  .cc-how-to-take__card{ display: block !important; grid-template-columns: none !important; }
  .cc-how-to-take__media{
    width: 100% !important; height: auto !important;
    aspect-ratio: 16/9 !important; max-height: 240px !important; overflow: hidden !important;
  }
  .cc-how-to-take__media img, .cc-how-to-take__media picture{
    width: 100% !important; height: 100% !important;
    object-fit: cover !important; object-position: center !important;
  }
  .cc-how-to-take__content{ padding: 16px !important; }
  /* BUG-P1 (iPhone real): CTA "Aggiungi al Carrello €39.98€135.00" com white-space:nowrap
     sai da tela em iPhone real. Força wrap + shrink. */
  button[class*="cc-pdp-cta"], button[class*="atc-button"],
  .main-atc, button.product-form__submit{
    white-space: normal !important; flex-wrap: wrap !important;
    padding: 12px 16px !important; font-size: 15px !important;
  }
  button[class*="cc-pdp-cta"] span, button[class*="atc-button"] span, .main-atc span{
    white-space: normal !important; word-break: normal !important;
  }
  [data-cc-atc-append]{ flex-wrap: wrap !important; justify-content: center !important; }
  /* BUG-CTA-LAYOUT (print 20:24): CTA quebra feio no mobile — texto+preços brigam por width.
     Fix: label flex-direction column empilha vertical + centraliza. */
  .main-atc__label, .button__label {
    flex-direction: column !important; gap: 6px !important;
    align-items: center !important; justify-content: center !important;
    width: 100% !important; text-align: center !important;
  }
  .main-atc__label__text, .buybtn1 {
    font-size: 16px !important; font-weight: 700 !important; line-height: 1.2 !important;
    text-align: center !important;
  }
  [data-cc-atc-append] {
    display: inline-flex !important; align-items: center !important; justify-content: center !important;
    gap: 8px !important; margin-left: 0 !important; font-size: 18px !important;
  }
  [data-cc-atc-append] span { font-size: 16px !important; }
  [data-cc-atc-append] > span[aria-hidden="true"]:first-child { display: none !important; }
  [data-cc-atc-guarantee], .cc-pdp-atc-guarantee {
    display: flex !important; align-items: center !important; justify-content: center !important;
    gap: 6px !important; width: 100% !important; margin-top: 8px !important;
    padding: 6px 0 !important; font-size: 13px !important; text-align: center !important;
  }
  /* BUG-M1 (audit full mobile): stats number 44px quebra ("Piccoli vas i sanguigni"). */
  .aurivita-stats__number, [class*="aurivita-stats__number"],
  .aurivita-stats h1, .aurivita-stats h2, .aurivita-stats h3{
    font-size: 28px !important; line-height: 1.15 !important;
    word-break: normal !important; hyphens: none !important;
  }
  .aurivita-stats__label, .aurivita-stats p{ font-size: 14px !important; line-height: 1.4 !important; }
  /* BUG-M3 (audit full mobile): AVS mobile grid label 86px comprime "Via metabolica". */
  .avs__mobile-grid{ grid-template-columns: 110px 1fr !important; gap: 8px !important; }
  .avs__mobile-grid > *:nth-child(odd), .avs__label{
    font-size: 12px !important; line-height: 1.25 !important; word-break: normal !important;
  }
  .avs__mobile-grid > *:nth-child(even), .avs__value{
    font-size: 13px !important; line-height: 1.35 !important;
  }
}
/* BUG-01: WRAPPER dos details NUNCA display:none — apenas filhos individuais */
.cc-timeline__details, .cc-doctors-see__panels{ display: block !important; }
</style>`);

  // 2. Remove regras legacy 700/780px do review swiper
  $('style').each((_, el) => {
    const raw = $(el).html() || '';
    if (!/\.swiper[^{]*\{[^}]*max-height:\s*7\d\dpx/i.test(raw) &&
        !/cc-customer-notice__swiper[^{]*\{[^}]*(?:max-)?height:\s*7\d\dpx/i.test(raw)) return;
    const cleaned = raw
      .replace(/\.swiper\s+\.swiper-wrapper\s*\{[^}]*max-height:\s*7\d\dpx[^}]*\}/gi, '')
      .replace(/\.swiper\s+\.swiper-slide\s*\{[^}]*max-height:\s*7\d\dpx[^}]*\}/gi, '')
      .replace(/\.cc-customer-notice__swiper[^{]*\{[^}]*(?:max-)?height:\s*7\d\dpx[^}]*\}/gi, '');
    if (cleaned !== raw) $(el).html(cleaned);
  });

  // 3. CSS override reviews compact
  $('style[data-landinglab-reviews-fix]').remove();
  $('head').append(`<style data-landinglab-reviews-fix>
.cc-customer-notice__swiper,
.cc-customer-notice__swiper .swiper-wrapper,
.cc-customer-notice__swiper .swiper-slide,
.cc-customer-notice__card{
  height:auto!important; max-height:none!important;
}
/* Bundle cards SEMPRE clicaveis (tema pode ter overlay ou pointer-events:none) */
button.cc-pdp-offer,
.kaching-bundles__bar,
[class*="__bundle"],
[class*="bundle-selector"] > *{
  pointer-events:auto!important;
  cursor:pointer!important;
}
/* BUG-REVIEWS-SWIPER-MOBILE: Swiper.js quebra transform no mobile — converter pra scroll-snap CSS. */
@media (max-width: 768px){
  .cc-customer-notice__swiper{
    overflow-x: auto !important; overflow-y: visible !important;
    scroll-snap-type: x mandatory !important;
    -webkit-overflow-scrolling: touch !important;
    scroll-behavior: smooth !important;
    scrollbar-width: none !important;
    padding-right: 0 !important;
  }
  .cc-customer-notice__swiper::-webkit-scrollbar{ display: none !important; }
  .cc-customer-notice__swiper .swiper-wrapper{
    display: flex !important; flex-wrap: nowrap !important;
    transform: none !important; transition: none !important;
    overflow: visible !important; width: auto !important;
    gap: 12px !important;
  }
  .cc-customer-notice__swiper .swiper-slide{
    flex: 0 0 88% !important; width: 88% !important; max-width: 88% !important;
    scroll-snap-align: center !important; scroll-snap-stop: always !important;
    margin: 0 !important; transform: none !important;
  }
}
</style>`);

  // BUG-REVIEWS-SWIPER-MOBILE: killswitch Swiper reviews (destroy instance +
  // reset transform inline pra scroll-snap CSS funcionar sem interferência)
  $('script[data-landinglab-reviews-killswitch]').remove();
  $('body').append(`<script data-landinglab-reviews-killswitch>
(function(){
  function killReviewsSwiper(){
    if (window.innerWidth > 768) return;
    var sw = document.querySelector('.cc-customer-notice__swiper');
    if (!sw) return;
    if (sw.swiper && typeof sw.swiper.destroy === 'function') {
      try { sw.swiper.destroy(true, true); } catch(_) {}
    }
    var wrapper = sw.querySelector('.swiper-wrapper');
    if (wrapper) { wrapper.style.transform = ''; wrapper.style.transition = ''; }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', killReviewsSwiper);
  else killReviewsSwiper();
  setTimeout(killReviewsSwiper, 500);
  setTimeout(killReviewsSwiper, 1500);
})();
</script>`);

  // 4. Remove subtitle "Risparmia il 50%" / "Save X%" dos bundles
  $('.cc-pdp-offer__subtitle, .cc-pdp-offer__savings, .cc-pdp-offer [class*="__subtitle"], .cc-pdp-offer [class*="__savings"]').remove();

  // 5. Adiciona contagem de softgels em cada card cc-pdp-offer
  const softgelsPerBottle = 60;
  $('button.cc-pdp-offer').each((_, el) => {
    const $card = $(el);
    const titleEl = $card.find('.cc-pdp-offer__title, [class*="__title"]').first();
    const titleText = titleEl.text().trim();
    // Parse "Acquista N" ou "(Acquista|Compra) N e (ricevi|prendi) M GRATIS"
    const buyMatch = titleText.match(/(?:Acquista|Compra|Buy)\s*(\d+)/i);
    const freeMatch = titleText.match(/(?:ricevi|prendi|get)\s*(\d+)\s*GRAT/i);
    if (!buyMatch) return;
    const buyN = parseInt(buyMatch[1] ?? '1', 10);
    const freeN = freeMatch ? parseInt(freeMatch[1] ?? '0', 10) : 0;
    const totalBottles = buyN + freeN;
    const totalSoftgels = totalBottles * softgelsPerBottle;
    $card.find('.ll-softs-count').remove();
    const softsHtml = `<p class="ll-softs-count" style="margin:2px 0 0;font-size:12px;line-height:14px;font-weight:400;color:rgba(0,0,0,0.5);">${totalSoftgels} softgel</p>`;
    if (titleEl.length > 0) titleEl.after(softsHtml);
  });

  // 6. Reescreve currency + moneyFormat no product JSON (se currency setado)
  if (input.currency) {
    $('script[data-cc-pdp-product-json], script[type="application/json"][data-cc-pdp-product-json]').each((_, el) => {
      const raw = $(el).html() || '';
      if (!raw.trim()) return;
      try {
        const data = JSON.parse(raw);
        data.currency = input.currency!.toUpperCase();
        data.moneyFormat = `${currencySymbol}{{amount}}`;
        $(el).html(JSON.stringify(data));
      } catch { /* ignore */ }
    });
  }

  // 7. Descodifica entities double-escaped (&amp;nbsp; → space) e NBSP prefix
  const ENTITY_MAP: Record<string, string> = {
    '&amp;nbsp;': ' ', '&amp;quot;': '"', '&amp;#39;': "'", '&amp;apos;': "'",
    '&nbsp;': ' ', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  };
  const walk = (el: any): void => {
    const $el = $(el);
    const contents = $el.contents();
    contents.each((_: number, node: any) => {
      if (node.type === 'text') {
        const orig = (node as { data: string }).data;
        let cleaned = orig;
        for (const [entity, replacement] of Object.entries(ENTITY_MAP)) {
          if (cleaned.includes(entity)) cleaned = cleaned.split(entity).join(replacement);
        }
        // NBSP prefixando texto curto (nome autor de review)
        if (cleaned.length < 50 && /^[ \s]+\S|\S[ \s]+$/.test(cleaned)) {
          const trimmed = cleaned.replace(/^[ \s]+/, '').replace(/[ \s]+$/, '');
          if (trimmed !== cleaned && trimmed.length > 0) cleaned = trimmed;
        }
        if (cleaned !== orig) (node as { data: string }).data = cleaned;
      } else if (node.type === 'tag') {
        walk(node);
      }
    });
  };
  $('body').each((_, el) => walk(el));
  // Também alt/title/aria-label
  $('[alt], [title], [aria-label]').each((_, el) => {
    const $el = $(el);
    for (const attr of ['alt', 'title', 'aria-label']) {
      const v = $el.attr(attr);
      if (!v) continue;
      let clean = v;
      for (const [entity, replacement] of Object.entries(ENTITY_MAP)) {
        clean = clean.split(entity).join(replacement);
      }
      if (clean !== v) $el.attr(attr, clean);
    }
  });

  // 7.4. FIX INSTAFEED — faixa/carrossel de fotos do Instagram.
  //      O instafeed-shopify (nfcube.com) usa um padrão de lazy-swap:
  //        src = placeholder genérico (mesmo arquivo pra todos os slots)
  //        data-instafeed-src = URL real do CDN do Instagram (scontent.cdninstagram.com)
  //      O JS externo do instafeed faz o swap em runtime, mas não é clonado.
  //      Resultado: todos os slots ficam com o mesmo placeholder genérico (cinza/vazio).
  //      Fix: promove data-instafeed-src → src pra cada item da faixa.
  //      Genérico: cobre qualquer img com data-instafeed-src (não só Spicy).
  $('img[data-instafeed-src]').each((_, el) => {
    const $img = $(el);
    const realSrc = $img.attr('data-instafeed-src');
    if (!realSrc || realSrc.startsWith('data:')) return;
    $img.attr('src', realSrc);
    $img.attr('loading', 'eager');
    $img.removeAttr('data-instafeed-src');
  });

  // 7.5. FIX IMAGENS BRANCAS DOS CARROSSEIS (root cause definitiva):
  //      Imagens dentro de swiper-slide off-screen (x negativo) + loading="lazy"
  //      + srcset com múltiplas URLs = browser NUNCA baixa. Quando o usuário
  //      clica na tab da Semana/Passo, o slide entra na viewport MAS o browser
  //      não busca a img porque:
  //        1) loading="lazy" ainda está esperando IntersectionObserver
  //        2) srcset tem 5 URLs de tamanhos diferentes — browser espera decidir
  //      Solução drástica: remove loading="lazy" e srcset/data-srcset E <source>
  //      dessas seções críticas. Força eager + só uma URL (src). Browser baixa
  //      TUDO no primeiro parse do HTML, independente de posição no DOM.
  const CRITICAL_SELECTORS = [
    '.cc-timeline img',
    '.cc-doctors-see img',
    '.cc-pdp__main img',
    '.cc-pdp__thumbs img',
    '.cc-pdp__gallery-layout img',
    '.cc-customer-notice img',
  ].join(', ');
  $(CRITICAL_SELECTORS).each((_, img) => {
    const $img = $(img);
    $img.attr('loading', 'eager');
    $img.removeAttr('srcset');
    $img.removeAttr('data-srcset');
    $img.removeAttr('sizes');
    $img.removeAttr('data-src');
  });
  // Também remove <source> siblings dentro de <picture> nas mesmas seções
  $('.cc-timeline picture source, .cc-doctors-see picture source, .cc-pdp__main picture source, .cc-pdp__thumbs picture source, .cc-customer-notice picture source').remove();

  // 7.9. Bundle selection toggle — funciona MESMO sem data-landing-variant-id
  //      (importante pra preview de clone antes de wizard rodar). O tema aurivita
  //      pre-seleciona o 2º bundle (is-selected + is-highlighted). Antes do
  //      wizard NÃO tem landing_variants, então nosso handleBundleClick do
  //      checkout-handler ignora — cards ficam "mortos".
  //      Este script SEMPRE funciona (só toggle visual). O click de compra
  //      real (checkout) só ativa depois do apply-bundle anotar data-vid.
  $('script[data-landinglab-bundle-select]').remove();
  $('body').append(`<script data-landinglab-bundle-select>(function(){
  function initBundleSelect(){
    var cards = document.querySelectorAll('button.cc-pdp-offer, .kaching-bundles__bar[data-deal-bar-id]');
    if(cards.length === 0) return;
    // Se algum ja tem data-landing-variant-active, respeita. Senao, ativa o
    // que ja tem is-selected pre-set do tema (default do vendedor).
    var hasActive = document.querySelector('[data-landing-variant-active="true"]');
    if(!hasActive){
      var preSel = document.querySelector('button.cc-pdp-offer.is-selected, .kaching-bundles__bar.is-selected, .kaching-bundles__bar--selected');
      if(preSel && preSel.getAttribute('data-landing-variant-id')){
        preSel.setAttribute('data-landing-variant-active', 'true');
      }
    }
    cards.forEach(function(card){
      if(card.dataset.llBundleSelectInit) return;
      card.dataset.llBundleSelectInit = '1';
      card.style.cursor = 'pointer';
      card.addEventListener('click', function(e){
        // Se este eh o CTA de compra (data-landing-cta="buy"), NAO troca
        // seleção — deixa o click passar pra checkout handler.
        if(card.getAttribute('data-landing-cta') === 'buy') return;
        // Desactiva TODOS os outros cards
        cards.forEach(function(other){
          if(other === card) return;
          other.classList.remove('is-selected','is-highlighted','is-active','active','kaching-bundles__bar--selected');
          other.setAttribute('aria-selected','false');
          other.removeAttribute('data-landing-variant-active');
        });
        // Activa este — inclui kaching-bundles__bar--selected para que
        // o applyPrices nativo do Kaching leia a classe e atualize o CTA.
        card.classList.add('is-selected','is-highlighted','kaching-bundles__bar--selected');
        card.setAttribute('aria-selected','true');
        var vid = card.getAttribute('data-landing-variant-id');
        if(vid){
          // Handler real de checkout vai atuar em cima disso
          card.setAttribute('data-landing-variant-active', 'true');
        }
        // Sincroniza radio nativo e dispara deal-bar-selected para o
        // applyPrices do Kaching atualizar o button-text ("Add to cart - $XX").
        var radio = card.querySelector('input[type="radio"]');
        if(radio){ radio.checked = true; }
        document.dispatchEvent(new CustomEvent('deal-bar-selected', { bubbles: true, detail: { barId: card.getAttribute('data-deal-bar-id') } }));
      }, true); // capture: roda ANTES de qualquer outro handler
    });
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initBundleSelect);
  else initBundleSelect();
  var attempts = 0;
  var timer = setInterval(function(){ initBundleSelect(); attempts++; if(attempts > 10) clearInterval(timer); }, 500);
})();</script>`);

  // 8. Injeta CSS/JS pro destroy-Swiper fallback em seções com tabs.
  //    Cobre: .cc-timeline (Semana), .cc-doctors-see (Fase/Passo/Step).
  //    Ambas têm mesmo padrão: swiper interno + tabs [role="tab"] fora.
  //    Swiper.js falha por transform+overflow → destrói e usa toggle absolute.
  if ($('.cc-timeline, .cc-doctors-see').length > 0) {
    $('style[data-landinglab-timeline-fix]').remove();
    $('script[data-landinglab-timeline-fix]').remove();
    $('head').append(`<style data-landinglab-timeline-fix>
.cc-timeline__swiper, .cc-doctors-see__swiper{overflow:visible!important}
.cc-timeline__swiper .swiper-slide img,
.cc-timeline__swiper .swiper-slide picture,
.cc-timeline__swiper .swiper-slide .cc-timeline__media,
.cc-doctors-see__swiper .swiper-slide img,
.cc-doctors-see__swiper .swiper-slide picture,
.cc-doctors-see__swiper .swiper-slide .cc-doctors-see__media{
  display:block!important; opacity:1!important; visibility:visible!important;
  max-width:100%!important; height:auto!important;
}
</style>`);
    $('body').append(`<script data-landinglab-timeline-fix>(function(){
  // Generic init: qualquer .cc-timeline OU .cc-doctors-see com swiper interno.
  // Padrao: root section > .cc-<name>__swiper > .swiper-wrapper > .swiper-slide.
  // Tabs [role="tab"] estao no mesmo root.
  var SECTIONS = ['.cc-timeline', '.cc-doctors-see'];
  function findSwiperIn(root){
    // Procura swiper que casa com o padrao __swiper (variavel por section)
    return root.querySelector('.cc-timeline__swiper, .cc-doctors-see__swiper, .swiper');
  }
  function initSection(root){
    if(root.dataset.llSectionInit) return;
    root.dataset.llSectionInit='1';
    var swEl=findSwiperIn(root);
    if(!swEl) return;
    if(swEl.swiper && typeof swEl.swiper.destroy==='function'){ try{swEl.swiper.destroy(true,false);}catch(_){} }
    var wrap=swEl.querySelector(':scope > .swiper-wrapper');
    if(wrap){wrap.style.cssText='display:block;transform:none;position:relative;width:100%;height:auto;';}
    // Determina slide inicial: se algum tab [aria-selected="true"] existe, usa esse idx
    var tabs=Array.from(root.querySelectorAll('[role="tab"][aria-controls]'));
    var initialIdx=0;
    for(var i=0;i<tabs.length;i++){
      if(tabs[i].getAttribute('aria-selected')==='true' || tabs[i].classList.contains('is-active')){ initialIdx=i; break; }
    }
    swEl.querySelectorAll(':scope > .swiper-wrapper > .swiper-slide').forEach(function(sl,i){
      sl.style.cssText=i===initialIdx
        ?'position:relative;inset:0;width:100%;height:auto;opacity:1;visibility:visible;'
        :'position:absolute;inset:0;width:100%;height:auto;opacity:0;visibility:hidden;';
    });
    swEl.style.setProperty('overflow','visible','important');
    tabs.forEach(function(tab){
      if(tab.dataset.llTabInit) return;
      tab.dataset.llTabInit='1';
      tab.style.cursor='pointer';
      tab.addEventListener('click', function(e){
        e.preventDefault(); e.stopPropagation();
        var allTabs=Array.from(root.querySelectorAll('[role="tab"][aria-controls]'));
        var idx=allTabs.indexOf(tab);
        allTabs.forEach(function(t){t.classList.remove('is-active','active');t.setAttribute('aria-selected','false');});
        tab.classList.add('is-active'); tab.setAttribute('aria-selected','true');
        var sw=findSwiperIn(root);
        if(!sw) return;
        sw.querySelectorAll(':scope > .swiper-wrapper > .swiper-slide').forEach(function(sl,i){
          sl.style.cssText=i===idx
            ?'position:relative;inset:0;width:100%;height:auto;opacity:1;visibility:visible;'
            :'position:absolute;inset:0;width:100%;height:auto;opacity:0;visibility:hidden;';
        });
      }, true);
    });
  }
  function initAll(){
    SECTIONS.forEach(function(sel){
      document.querySelectorAll(sel).forEach(initSection);
    });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', initAll);
  else initAll();
  var attempts=0;
  var timer=setInterval(function(){ initAll(); attempts++; if(attempts>10) clearInterval(timer); },500);
})();</script>`);
  }

  // BUG-SCROLL (commit c1223c8): observer que remove Klaviyo body lock em tempo real.
  // Sem observer, mesmo com CSS override, JS do Klaviyo re-aplica classes dinamicamente.
  $('script[data-landinglab-scroll-fix]').remove();
  $('body').append(`<script data-landinglab-scroll-fix>
(function(){
  var observer;
  function observeScrollLocks(){
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  }
  function unlockScroll(){
    var body = document.body;
    if (!body) return;
    var html = document.documentElement;
    var locked = body.classList.contains('klaviyo-prevent-body-scrolling') ||
      body.classList.contains('kl_reviews__modal_open') ||
      body.style.overflow === 'hidden' || body.style.position === 'fixed' ||
      !!body.style.paddingRight || !!body.style.top || html.style.overflow === 'hidden';
    if (!locked) return;
    observer.disconnect();
    if (body.classList.contains('klaviyo-prevent-body-scrolling')) body.classList.remove('klaviyo-prevent-body-scrolling');
    if (body.classList.contains('kl_reviews__modal_open')) body.classList.remove('kl_reviews__modal_open');
    if (body.style.overflow === 'hidden') body.style.overflow = '';
    if (body.style.position === 'fixed') body.style.position = '';
    if (body.style.paddingRight) body.style.paddingRight = '';
    if (body.style.top) body.style.top = '';
    if (html.style.overflow === 'hidden') html.style.overflow = '';
    observeScrollLocks();
  }
  observer = new MutationObserver(unlockScroll);
  unlockScroll();
  observeScrollLocks();
})();
</script>`);

  // PERF-DEDUP: remove scripts duplicados (mesmo src aparecendo 2+ vezes).
  // Causa: pipeline de enriquecimento de scripts estáticos + DOM serializado
  // pode inserir o mesmo script via dois caminhos diferentes. Duplicatas custam
  // rede extra e podem causar erros de "identifier already declared" (detectado
  // na Vanttore: 4 scripts duplicados incluindo pagefly-htmlvideo2.js).
  const seenScriptSrcs = new Set<string>();
  $('script[src]').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('src') ?? '';
    if (!src) return;
    if (seenScriptSrcs.has(src)) {
      $el.remove();
    } else {
      seenScriptSrcs.add(src);
    }
  });

  // PERF-DEDUP-RUNTIME: remove tags <script src> estáticas cujo recurso também
  // será carregado por um loader/injector dinâmico já presente no HTML.
  // Regra de segurança: SÓ remove a tag estática quando o HTML contém prova
  // explícita de que a mesma URL será carregada dinamicamente (string literal
  // da URL dentro de um <script> inline). Se o loader não existir → preserva.
  //
  // Padrões cobertos (identificados por análise de initiator via CDP na Vanttore):
  //
  //  A) shop_events_listener — tema Shrine PRO inclui TANTO <script async src=X>
  //     QUANTO um inline script que faz createElement('script')+appendChild(X).
  //     A tag estática é redundante; o inline injector já carrega o recurso.
  //
  //  B) webmcp (Shopify Storefront webmcp module) — presente como
  //     <script type="module" src=X> E como argumento de s("X", sha256=...)
  //     no Shopify loadFeatures() inline. O ESM module registry deduplica
  //     funcionalmente, mas o segundo download de rede ocorre mesmo assim.
  //     Remove a tag <script type="module"> estática; loadFeatures() carrega.
  //
  //  C) pagefly-htmlvideo2 — presente como <script defer src=X> no <head> E
  //     registrado no PageFly config JSON como "HTML.Video2": "url" para
  //     injeção lazy. O lazy-loader injeta quando necessário; a tag defer é
  //     redundante e causa race condition (script executa 2x).
  //
  // NÃO cobre WPM (b5982071) — segunda injeção é arquitetura intencional do
  // Shopify WPM bootstrap; remoção quebraria pixel tracking do cliente.
  {
    // Extrai URLs presentes no conteúdo de scripts inline (strings literais)
    // que indicam injeção dinâmica. Normaliza proto-relative (//host) → sem proto.
    const inlineLoaderUrls = new Set<string>();
    $('script:not([src])').each((_, el) => {
      const content = $(el).html() ?? '';
      // Match de strings que parecem URLs de scripts dentro de JS inline
      // Cobre: 'url', "url", template literal `url`, e concatenações simples
      const re = /["'`]((?:https?:)?\/\/[^"'`\s,)]+\.js[^"'`\s,)]*)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        // Normaliza: remove proto (http: ou https:) para comparar com proto-relative
        inlineLoaderUrls.add(m[1].replace(/^https?:/, ''));
      }
    });

    // Remove tag estática se e somente se a mesma URL aparece como string
    // literal em algum script inline (= loader dinâmico comprovado).
    $('script[src]').each((_, el) => {
      const $el = $(el);
      const src = $el.attr('src') ?? '';
      if (!src) return;
      // Normaliza src para comparar: remove proto se presente
      const srcNorm = src.replace(/^https?:/, '');
      if (inlineLoaderUrls.has(srcNorm)) {
        $el.remove();
      }
    });
  }

  // PERF-PRECONNECT: adiciona preconnect para a CDN da source origin se não
  // existir. Scripts e imagens servidos por CDN shopify (vanttore.com/cdn,
  // cdn.shopify.com) precisam de preconnect pra reduzir RTT.
  // Extrai origins únicas de <script src> e <img src> e adiciona preconnect
  // apenas para as que ainda não têm (evita duplicação dos existentes).
  const existingPreconnects = new Set(
    $('link[rel="preconnect"]').map((_, el) => {
      try { return new URL($(el).attr('href') ?? '').origin; } catch { return ''; }
    }).toArray().filter(Boolean)
  );
  const criticalOrigins = new Set<string>();
  $('script[src], link[rel="stylesheet"][href]').each((_, el) => {
    const $el = $(el);
    const url = $el.attr('src') ?? $el.attr('href') ?? '';
    try {
      const origin = new URL(url).origin;
      // Só adiciona preconnect para CDNs de assets (não para tracking/analytics)
      if (/cdn\.(shopify|shopifycdn|shopifysvc)\.com|\.cdn\.|\/cdn\//i.test(url) && !existingPreconnects.has(origin)) {
        criticalOrigins.add(origin);
      }
    } catch { /* URL inválida, ignora */ }
  });
  if (criticalOrigins.size > 0) {
    const preconnectTags = [...criticalOrigins].slice(0, 3) // máx 3 pra não inflar o <head>
      .map(origin => `<link rel="preconnect" href="${origin}" crossorigin>`)
      .join('\n');
    $('head').append(preconnectTags);
  }

  return $.html();
}
