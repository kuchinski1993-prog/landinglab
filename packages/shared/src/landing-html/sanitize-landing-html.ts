// Sanitiza HTML clonado antes de injetar via dangerouslySetInnerHTML.
//
// IMPORTANTE — sobre a estratégia:
//   Antes usávamos isomorphic-dompurify, mas ele puxa jsdom → html-encoding-sniffer
//   → @exodus/bytes (ESM) que causa ERR_REQUIRE_ESM em Vercel serverless.
//
//   Threat model relaxado: o operador do LandingLab escolhe QUAL URL clonar.
//   Não estamos clonando sites arbitrários hostis — o cloner (Squad 0) já
//   sanitiza no clone (remove trackers/frameworks Next.js/analytics/pixels).
//
//   Aqui aplicamos apenas defesas complementares via regex (sem jsdom).
//   Suficiente pra este caso de uso e evita ESM interop em serverless.

// Frameworks JS de site origem que NUNCA funcionam fora do build origem.
// Duplicado do cloner por defense in depth (landings clonadas antes do fix
// do cloner podem ter esses scripts ainda no HTML persistido).
const FRAMEWORK_SCRIPT_PATTERNS: RegExp[] = [
  /self\.__next_f\.push/,
  /self\.__next_f\s*=/,
  /window\.__NEXT_DATA__/,
  /__NEXT_ROUTER_STATE__/,
  /_next\/static\/chunks/,
  /window\.__NUXT__/,
  /_nuxt\/entry\./,
  /ReactDOM\.hydrateRoot/,
  /ReactDOM\.hydrate/,
];

// Padrões de trackers/analytics que talvez tenham escapado do cloner
// (defense in depth).
const TRACKER_PATTERNS: RegExp[] = [
  /googletagmanager\.com/i,
  /google-analytics\.com/i,
  /gtag\(/i,
  /fbevents\.js/i,
  /connect\.facebook\.net/i,
  /analytics\.tiktok\.com/i,
  /clarity\.ms/i,
  /hotjar\.com/i,
  // Google Ads da loja origem (tags de conversão capturadas já renderizadas no clone).
  /doubleclick\.net/i,
  /googleadservices\.com/i,
  // Trackbee (app Shopify: Google Ads/Meta server-side da loja origem).
  /trackbee/i,
  // Analytics nativo do Shopify da loja origem (trekkie → monorail).
  /trekkie/i,
  /monorail/i,
  /shop_events_listener/i,
];

// Shopify Web Pixels Manager — carrega pixels configurados no painel admin
// da loja origem (ex: pixel Meta da origem). Mesmo quando NÃO carrega
// fbevents.js direto, o wpmLoader faz web-pixel-{id}@{hash}/pixel.modern.js
// → carrega sandbox que emite /tr direto pro pixel origem. Isso vaza eventos
// da nossa landing pro Pixel do concorrente (ou pior: fica como dual-pixel
// quando o nosso é o Pixel BlackShop e o origem é um Pixel Shopify qualquer).
//
// Detecção por conteúdo: scripts que contêm wpmLoader, webPixelsManager.init,
// ou configuração embutida com "pixel_type":"facebook_pixel" / pixel_id JSON.
const SHOPIFY_WEB_PIXELS_PATTERNS: RegExp[] = [
  /wpmLoader\s*=\s*function/i,
  /webPixelsManager\.(init|publish)/i,
  /"pixel_type"\s*:\s*"facebook_pixel"/i,
  /window\.Shopify\.analytics\s*=\s*/i,
];

// Endpoints de collect/analytics da loja origem clonada.
// Padrão: qualquer POST/fetch pra /api/collect, /api/track, /api/analytics,
// /api/beacon, /pixel, /events do próprio domínio da loja origem.
// Removemos pra evitar (a) CORS errors no console, (b) vazamento de eventos
// pra loja concorrente que gerou dados agregados sobre nosso tráfego.
const COLLECT_ENDPOINT_PATTERNS: RegExp[] = [
  /\/api\/collect\b/i,
  /\/api\/track\b/i,
  /\/api\/analytics\b/i,
  /\/api\/beacon\b/i,
  /\/api\/events?\b/i,
  /\/pixel\b/i,
  /\/collect\.gif\b/i,
];

// Scripts externos (src=) que apontam pro domínio da loja origem — residuais
// do clone, devem ser removidos. Só matchamos scripts com src= porque scripts
// inline de configuração do tema (window.shopUrl, Shopify.shop, etc.) mencionam
// o domínio como dado mas são necessários para hydration do tema.
const KNOWN_ORIGIN_SHOPS_SRC: RegExp[] = [
  /<script\b[^>]*\bsrc\s*=\s*["'][^"']*klensia\.com/i,
  /<script\b[^>]*\bsrc\s*=\s*["'][^"']*klensia\.website/i,
  /<script\b[^>]*\bsrc\s*=\s*["'][^"']*aurivita\.co/i,
  /<script\b[^>]*\bsrc\s*=\s*["'][^"']*bepurex\.com/i,
  /<script\b[^>]*\bsrc\s*=\s*["'][^"']*17svvv-zf\.myshopify\.com/i,
];

function stripDangerousScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (match) => {
    // JSON-LD preservado (SEO)
    if (/type=["']application\/ld\+json["']/i.test(match)) return match;
    // Scripts LandingLab (whitelist explícita).
    if (/data-landinglab-pixel=/i.test(match)) return match;
    if (/data-landinglab-engine=/i.test(match)) return match;
    if (/data-landinglab-faq-handler/i.test(match)) return match;
    // Kill scripts antigos do worker (Bundle Engine V1) — a Engine V2 no
    // storefront tem prioridade absoluta e escuta o CTA. Se estes rodam,
    // interceptam antes e chamam /landing-checkout sem landingVariantId
    // (não existe pra landings Engine V2) → alert "não configurado".
    if (/data-landinglab-checkout-handler/i.test(match)) return '';
    if (/data-landinglab-bundle-select/i.test(match)) return '';
    // Kill PSS ATC / Pre-Sale Studio scripts — apps de tema Shopify que
    // interceptam .pss-atc-button e abrem modal do checkout da loja origem
    // (klensia.website etc). Engine V2 precisa controle exclusivo do CTA.
    if (/PssATC|pss-atc-button|pss-atc-modal|preordermanager/i.test(match)) return '';
    // Kill scripts do Kaching Bundles que fazem hijack de submit /cart/add
    // (redirecionam pra loja origem). Engine V2 usa cart permalink direto.
    if (/kaching-bundles.*add-to-cart|kaching-bundles.*checkout/i.test(match)) return '';
    // Bloqueia frameworks (crashariam página)
    if (FRAMEWORK_SCRIPT_PATTERNS.some((re) => re.test(match))) return '';
    // Bloqueia trackers (backup do cloner)
    if (TRACKER_PATTERNS.some((re) => re.test(match))) return '';
    // Bloqueia Shopify Web Pixels Manager — carrega pixels da loja origem
    // (pixel Meta residual, GA, etc) via sandbox /web-pixels/web-pixel-X/pixel.modern.js.
    // Esses pixels disparam /tr pra conta do CONCORRENTE a partir da nossa landing.
    // Defense in depth: cloner idealmente já remove, mas landings persistidas
    // antes desse fix podem ter o loader residual.
    if (SHOPIFY_WEB_PIXELS_PATTERNS.some((re) => re.test(match))) return '';
    // Bloqueia endpoints de collect/analytics da loja origem — evita CORS
    // errors e vazamento de eventos pra loja concorrente.
    if (COLLECT_ENDPOINT_PATTERNS.some((re) => re.test(match))) return '';
    // Bloqueia scripts externos (src=) residuais que apontam pro domínio da loja origem.
    // EXCEÇÃO: scripts do tema Shopify (/cdn/shop/t/N/assets/) são CORS-safe e necessários
    // para header, drawer, FAQ, galeria. O §3.6 do apply-bundle pode injetá-los em clones
    // manual-paste que chegaram sem eles. Nunca remover assets de tema.
    if (KNOWN_ORIGIN_SHOPS_SRC.some((re) => re.test(match)) && !/\/cdn\/shop\/t\/\d+\/assets\//.test(match)) return '';
    return match;
  });
}

// Remove attrs perigosos + javascript: URIs em href/action/src.
// Regex simples suficiente pra threat model relaxado.
function stripDangerousAttrs(html: string): string {
  // 1. onerror/onbeforeunload — vetores XSS clássicos. Bloqueia.
  //    onclick/onload preservados (usados por galeria/FAQ).
  let out = html.replace(/\s(?:onerror|onbeforeunload|onunload)=["'][^"']*["']/gi, '');
  out = out.replace(/\s(?:onerror|onbeforeunload|onunload)=[^\s>]+/gi, '');

  // 2. javascript: URIs em href/action.
  out = out.replace(
    /\s(href|action|src|formaction)\s*=\s*["']?\s*javascript:[^"'>]*["']?/gi,
    ' $1="#"',
  );

  return out;
}

// Remove tags proibidas: object/embed. form fica (algumas landings têm form
// de email próprio — se hostil, cloner já sanitizou action).
function stripForbiddenTags(html: string): string {
  return html
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*\/?>/gi, '');
}

export interface SanitizeOptions {
  /** Se true, mantém <head>/<html>/<body> ao sanitizar documento completo. Default: false. */
  wholeDocument?: boolean;
}

/**
 * Sanitiza um fragmento HTML clonado pra injeção via dangerouslySetInnerHTML.
 *
 * Diferente da versão anterior (isomorphic-dompurify), essa implementação:
 *   - Não usa jsdom (evita ERR_REQUIRE_ESM em Vercel serverless)
 *   - Confia na sanitização de trackers/frameworks feita no cloner (Squad 0)
 *   - Aplica defesas complementares: strip scripts perigosos + attrs perigosos
 *   - Preserva scripts UX (galeria/FAQ/bundle), event handlers safe (onclick/etc)
 */
// Remove canonical/og:url do HTML clonado — o storefront injeta os corretos
// baseados no host real. Manter o original causa dual-canonical (SEO) e
// og:url apontando pro site fonte.
function stripSourceCanonicals(html: string): string {
  return html
    .replace(/<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*\/?>/gi, '')
    .replace(/<meta\b[^>]*\bproperty\s*=\s*["']og:url["'][^>]*\/?>/gi, '');
}

export function sanitizeLandingHtml(html: string, _options: SanitizeOptions = {}): string {
  if (!html) return '';

  let clean = html;
  clean = stripSourceCanonicals(clean);
  clean = stripDangerousScripts(clean);
  clean = stripForbiddenTags(clean);
  clean = stripDangerousAttrs(clean);
  return clean;
}

/** Sanitiza CSS injetado inline. Remove </style ...> que quebraria o container. */
export function sanitizeInlineCss(css: string): string {
  if (!css) return '';
  return css.replace(/<\/\s*style[^>]*>/gi, '');
}
