import { describe, it, expect } from 'vitest';

import { sanitizeLandingHtml } from '../sanitize-landing-html';

describe('sanitizeLandingHtml — KNOWN_ORIGIN_SHOPS', () => {
  it('preserves inline Shopify config script mentioning origin domain', () => {
    const html = `<script>var Shopify = Shopify || {};\nShopify.shop = "17svvv-zf.myshopify.com";\nShopify.currency = {"active":"EUR"};</script>`;
    const result = sanitizeLandingHtml(html);
    expect(result).toContain('Shopify.shop');
    expect(result).toContain('myshopify.com');
  });

  it('preserves inline window.shopUrl config script', () => {
    const html = `<script>\nwindow.shopUrl = 'https://klensia.com';\nwindow.routes = { cart_add_url: '/cart/add' };\n</script>`;
    const result = sanitizeLandingHtml(html);
    expect(result).toContain('window.shopUrl');
    expect(result).toContain('klensia.com');
  });

  it('preserves theme script with src pointing to origin domain (cdn/shop/t/ is CORS-safe theme asset)', () => {
    const html = `<script src="https://klensia.com/cdn/shop/t/8/assets/theme.js?v=123"></script>`;
    const result = sanitizeLandingHtml(html);
    expect(result).not.toBe('');
    expect(result).toContain('cdn/shop/t/8/assets/theme.js');
  });

  it('preserves theme script with src pointing to myshopify origin (cdn/shop/t/ is CORS-safe theme asset)', () => {
    const html = `<script src="https://17svvv-zf.myshopify.com/cdn/shop/t/8/assets/app.js"></script>`;
    const result = sanitizeLandingHtml(html);
    expect(result).not.toBe('');
    expect(result).toContain('cdn/shop/t/8/assets/app.js');
  });

  it('strips external script pointing to aurivita', () => {
    const html = `<script src="https://aurivita.co/cdn/shop/assets/theme.js"></script>`;
    const result = sanitizeLandingHtml(html);
    expect(result).toBe('');
  });
});

describe('sanitizeLandingHtml — LandingLab whitelist', () => {
  it('preserves data-landinglab-pixel script', () => {
    const html = `<script data-landinglab-pixel="meta">!function(f){f.fbq=function(){}}(window);</script>`;
    const result = sanitizeLandingHtml(html);
    expect(result).toBe(html);
  });

  it('preserves data-landinglab-engine script', () => {
    const html = `<script data-landinglab-engine="v2">window.__LL_ENGINE__=2;</script>`;
    const result = sanitizeLandingHtml(html);
    expect(result).toBe(html);
  });

  it('preserves data-landinglab-faq-handler script', () => {
    const html = `<script data-landinglab-faq-handler>(function(){ document.addEventListener('click', function(){}); })();</script>`;
    const result = sanitizeLandingHtml(html);
    expect(result).toBe(html);
  });

  it('strips data-landinglab-checkout-handler script (Engine V2 exclusivity)', () => {
    const html = `<script data-landinglab-checkout-handler>window.__LL_CHECKOUT_API__="/api/checkout";</script>`;
    const result = sanitizeLandingHtml(html);
    expect(result).toBe('');
  });

  it('strips data-landinglab-bundle-select script', () => {
    const html = `<script data-landinglab-bundle-select>(function(){ var cards = document.querySelectorAll('button.cc-pdp-offer'); })();</script>`;
    const result = sanitizeLandingHtml(html);
    expect(result).toBe('');
  });
});

describe('sanitizeLandingHtml — PSS/Kaching kill', () => {
  it('strips PSS ATC script', () => {
    const html = `<script>window.PssATC = { init: function(){} };</script>`;
    const result = sanitizeLandingHtml(html);
    expect(result).toBe('');
  });

  it('strips Kaching checkout hijack script', () => {
    const html = `<script>kaching-bundles.add-to-cart = function(){ window.location = "https://klensia.com/cart"; };</script>`;
    const result = sanitizeLandingHtml(html);
    expect(result).toBe('');
  });
});

describe('sanitizeLandingHtml — JSON-LD preserved', () => {
  it('preserves JSON-LD script regardless of content', () => {
    const html = `<script type="application/ld+json">{"@type":"Product","name":"Test","url":"https://klensia.com/p"}</script>`;
    const result = sanitizeLandingHtml(html);
    expect(result).toBe(html);
  });
});

describe('sanitizeLandingHtml — tracking not reintroduced (C)', () => {
  // GTM inline snippet sem URL (apenas ID 'GTM-XXXX') não é coberto pelos
  // TRACKER_PATTERNS atuais — gap pré-existente no sanitizer. O cloner (Squad 0)
  // é a primeira linha de defesa e já remove GTM. Este teste documenta o comportamento
  // atual (preservado) e NÃO representa uma regressão deste PR.
  it('GTM inline without URL is not blocked by TRACKER_PATTERNS (pre-existing gap, cloner is first defense)', () => {
    const html = `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime()});})(window,document,'script','dataLayer','GTM-XXXX');</script>`;
    const result = sanitizeLandingHtml(html);
    // Documents current behavior — not a regression of this PR
    expect(result).toBe(html);
  });

  it('strips inline gtag() function script', () => {
    const html = `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-XXXXX');</script>`;
    const result = sanitizeLandingHtml(html);
    expect(result).toBe('');
  });

  it('strips inline fbevents pixel script via connect.facebook.net', () => {
    const html = `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){};n.callMethod=n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments);f._fbq=n;}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','123456');</script>`;
    const result = sanitizeLandingHtml(html);
    expect(result).toBe('');
  });

  it('strips Shopify Web Pixels Manager loader (wpmLoader) carrying origin facebook_pixel config', () => {
    // Padrão real observado em clones Shopify: wpmLoader inline com JSON de
    // pixels da loja origem — inclusive um "pixel_type":"facebook_pixel"
    // configurado no admin Shopify do concorrente. Dispara /tr pra conta
    // deles a partir da nossa landing.
    const html = `<script>(function(){var wpmLoader=function(){};var cfg={"pixels":[{"id":"X","configuration":"{\\"pixel_id\\":\\"1674545963552583\\",\\"pixel_type\\":\\"facebook_pixel\\"}"}]};})();</script>`;
    const result = sanitizeLandingHtml(html);
    expect(result).toBe('');
  });

  it('strips inline webPixelsManager.init call', () => {
    const html = `<script>window.webPixelsManager.init({pixels:[]});</script>`;
    const result = sanitizeLandingHtml(html);
    expect(result).toBe('');
  });

  it('preserves LandingLab pixel loader script even with webPixels-like keywords in surrounding HTML', () => {
    // Garante que o whitelist LandingLab tem precedência sobre o novo bloqueio.
    const html = `<script data-landinglab-pixel="loader">fbq('init','1741152926934827');fbq('track','PageView');</script>`;
    const result = sanitizeLandingHtml(html);
    expect(result).toContain('1741152926934827');
    expect(result).toContain('data-landinglab-pixel');
  });
});

describe('sanitizeLandingHtml — faq-handler whitelist idempotence (D/E)', () => {
  it('preserves faq-handler even when combined with innocuous content', () => {
    const html = `<script data-landinglab-faq-handler>(function(){ document.addEventListener('click', function(e){ if(e.target.classList.contains('cc-faq__toggle')){ e.preventDefault(); } }); })();</script>`;
    const result = sanitizeLandingHtml(html);
    expect(result).toContain('data-landinglab-faq-handler');
    expect(result).toContain('cc-faq__toggle');
  });

  it('details/summary native behavior not blocked — no handler selectorfor summary', () => {
    const html = `<details><summary>Pergunta</summary><p>Resposta</p></details>`;
    const result = sanitizeLandingHtml(html);
    expect(result).toBe(html);
  });
});

describe('sanitizeLandingHtml — source canonical removal', () => {
  it('strips <link rel="canonical"> from cloned HTML', () => {
    const html = `<head><link rel="canonical" href="https://klensia.com/products/wormwood"><title>Test</title></head>`;
    const result = sanitizeLandingHtml(html);
    expect(result).not.toContain('rel="canonical"');
    expect(result).toContain('<title>Test</title>');
  });

  it('strips <link rel="canonical"> with self-closing slash', () => {
    const html = `<link rel="canonical" href="https://source.com/product" /><p>Body</p>`;
    const result = sanitizeLandingHtml(html);
    expect(result).not.toContain('canonical');
    expect(result).toContain('<p>Body</p>');
  });

  it('strips <meta property="og:url"> from cloned HTML', () => {
    const html = `<meta property="og:url" content="https://klensia.com/products/wormwood"><p>Body</p>`;
    const result = sanitizeLandingHtml(html);
    expect(result).not.toContain('og:url');
    expect(result).toContain('<p>Body</p>');
  });

  it('preserves other <link> tags (stylesheet, preconnect)', () => {
    const html = `<link rel="stylesheet" href="/styles.css"><link rel="preconnect" href="https://fonts.gstatic.com">`;
    const result = sanitizeLandingHtml(html);
    expect(result).toContain('stylesheet');
    expect(result).toContain('preconnect');
  });

  it('preserves other <meta> tags (og:title, og:image)', () => {
    const html = `<meta property="og:title" content="Test"><meta property="og:image" content="https://cdn.example.com/img.jpg">`;
    const result = sanitizeLandingHtml(html);
    expect(result).toContain('og:title');
    expect(result).toContain('og:image');
  });
});

describe('sanitizeLandingHtml — trackers da loja origem (Spicy Cubes)', () => {
  it('remove Google Ads, Trackbee e analytics do Shopify, mantendo o tema e os dados do produto', () => {
    const html = [
      '<script type="text/javascript" async="" src="https://googleads.g.doubleclick.net/pagead/viewthroughconversion/18340030408/?hn=www.googleadservices.com"></script>',
      '<script>window.trackbeeBoosterConfig = "{}";</script>',
      '<script async="" src="https://cdn.shopify.com/extensions/x/trackbee-1-124/assets/e5d2160fc704.min.js"></script>',
      '<script class="analytics">(function(){ var trekkie = window.ShopifyAnalytics.lib = {}; /* monorail */ })();</script>',
      '<script async="" src="//www.chemistry-club.com/cdn/shopifycloud/storefront/assets/shop_events_listener-4e26a9ce.js"></script>',
      '<script src="//www.chemistry-club.com/cdn/shop/t/29/assets/theme.js" defer="defer"></script>',
      '<script id="__st">var __st={"p":"product"};</script>',
    ].join('\n');
    const result = sanitizeLandingHtml(html);
    expect(result).not.toMatch(/doubleclick|trackbee|trekkie|shop_events_listener/);
    expect(result).toContain('cdn/shop/t/29/assets/theme.js');
    expect(result).toContain('var __st=');
  });
});
