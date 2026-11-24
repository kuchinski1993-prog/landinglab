// Cloner Orchestrator — Squad 0 Fase 5.A.
//
// Pipeline:
//   1. renderPage(url) — Playwright renderiza + coleta URLs de assets
//   2. Baixa CSS externo pra também extrair url(...) referenciados (fontes,
//      backgrounds definidos em CSS puro).
//   3. downloadAssets(all urls) — baixa imgs/css/fonts em paralelo
//   4. Reescreve HTML e cada CSS baixado apontando pros nossos assets
//   5. Sanitiza HTML (remove scripts de tracking residuais)
//   6. Retorna { html final, assets, metadata } — chamador (backoffice
//      server action ou worker) persiste em landing_pages.
//
// Escopo Fase 5.A: NÃO traduz nada. Fase 5.B e 5.C entram depois.

import * as cheerio from 'cheerio';

import { downloadAssets, rewriteUrls, type DownloadedAsset } from './agents/asset-downloader.js';
import { applyBundleAdapters, type DetectedBundleOffer } from './agents/bundle-adapters/index.js';
import { injectBundleRuntime } from './agents/bundle-runtime-injector.js';
import { injectCheckoutHandler } from './agents/checkout-handler-injector.js';
import { detectSourceCurrency } from './agents/currency-detector.js';
import { injectLandingLabFixes } from './agents/landinglab-fixes-injector.js';
import { injectMetaPixel, type PixelConfig } from './agents/pixel-injector.js';
import { absolutize, renderPage, type RenderOutput } from './agents/renderer.js';

export interface CloneInput {
  landingId: string;
  url: string;
  storageRoot: string;
  publicPathPrefix: string;
  /**
   * FR-30 / html-only mode: HTML já renderizado pelo browser do usuário,
   * bypassa Playwright completamente. Elimina anti-bot, timeout e
   * diferenças de fingerprint. `url` continua obrigatório e serve como
   * base para absolutizar URLs relativas de imagens/CSS/fontes.
   *
   * Quando fornecido, `renderPage()` é pulado e extração de URLs é feita
   * via cheerio pura (sem browser).
   */
  htmlOverride?: string;
  /**
   * Callback opcional de progresso — chamado em cada transição de fase.
   * Usado pelo endpoint SSE pra fazer streaming de updates ao cliente.
   * Nunca throw — errors no callback são silenciados pra não abortar clone.
   */
  onProgress?: (event: CloneProgressEvent) => void;
  /**
   * Sinal opcional para abortar o clone entre fases (render → css → download
   * → rewrite → sanitize). Ativado quando o cliente SSE desconecta e não faz
   * mais sentido gastar CPU/rede em resultado que ninguém vai consumir.
   *
   * Semântica: checagem cooperativa ENTRE FASES — nunca cancela uma
   * operação HTTP/render em andamento. Se abortado, retorna resultado
   * parcial com `aborted: true` sem lançar exceção.
   */
  signal?: AbortSignal;
  /**
   * Configuração opcional do Meta Pixel — se presente, injeta snippet
   * antes de </head> após sanitize + checkout handler. Vindo do worker
   * que resolve landing_pixels do DB. Null/undefined = pula injeção
   * (útil pra advertorial sem pixel, ou pra debug de HTML puro).
   */
  pixelConfig?: PixelConfig | null;
  /**
   * ISO currency code (EUR, USD, GBP, BRL...) — usado por
   * injectLandingLabFixes pra reescrever preços no <script product-json>
   * do tema. Se null/undefined, mantém currency que veio do HTML origem.
   */
  currency?: string | null;
  /**
   * Story 16.3 — provedor de checkout da landing. `external` = checkout do produtor
   * (sem POST /api/landing-checkout): o script legado não é injetado e o storefront
   * serve a navegação direta com o mapa kit->URL atual. Ausente = comportamento atual.
   */
  checkoutProvider?: 'shopify' | 'stripe' | 'external' | null;
  /**
   * Story 16.3 — `cta_config.externalCheckout.allowSphereTracker`. `true` preserva (e injeta
   * no <head>) exatamente o tracker do Sphere; default false = removido.
   */
  allowSphereTracker?: boolean;
}

export type CloneProgressEvent =
  | { phase: 'start'; url: string }
  | { phase: 'render:started' }
  | { phase: 'render:done'; imageUrls: number; stylesheets: number; fonts: number; latencyMs: number }
  | { phase: 'css:started'; count: number }
  | { phase: 'css:done'; downloaded: number; internalUrls: number }
  | { phase: 'download:started'; total: number }
  | { phase: 'download:progress'; done: number; total: number; failed: number }
  | { phase: 'download:done'; ok: number; failed: number; latencyMs: number }
  | { phase: 'rewrite:started' }
  | { phase: 'rewrite:done' }
  | { phase: 'sanitize:done' }
  | { phase: 'aborted'; reason: 'client_disconnected' | 'external_abort'; stage: string }
  | { phase: 'complete'; bytes: number; latencyMs: number; images: number }
  | { phase: 'error'; message: string };

function safeEmit(cb: CloneInput['onProgress'], event: CloneProgressEvent): void {
  if (!cb) return;
  try {
    cb(event);
  } catch {
    // Silêncio: SSE stream desconectou ou callback quebrou; clone continua.
  }
}

export interface CloneResult {
  finalUrl: string;
  html: string;
  title: string;
  detectedLanguage: string | null;
  /** Moeda ISO da loja de origem (Shopify.currency.active, og:price:currency,
   * JSON-LD…). null quando não há marcador explícito. Story 15.2. */
  detectedCurrency?: string | null;
  assets: DownloadedAsset[];
  failedAssets: Array<{ url: string; error: string }>;
  imageUrls: string[]; // URLs LOCAIS pós-rewrite, filtradas por content-type image/*
  bytes: number;
  latencyMs: number;
  trace: Array<{ agent: string; latency_ms: number; notes?: string }>;
  /** True quando o clone foi interrompido via `input.signal.aborted` entre
   * fases. Campos podem estar parcialmente populados (ex: render feito, mas
   * download/rewrite pulados). Caller NÃO deve persistir como estado final. */
  aborted?: boolean;
  /** Nome da fase onde o aborto foi detectado (só populado se `aborted:true`). */
  abortedAt?: string;
  /** Bundle Engine V2 (set/2026): resultado do adapter que rodou no clone.
   * Worker persiste em landing_bundle_offers + seta use_new_bundle_engine=true.
   * Se `adapter === 'none'`, worker mantém flag `false` (fluxo antigo). */
  bundleAdapter?: 'kaching' | 'generic' | 'none';
  bundleOffers?: DetectedBundleOffer[];
  bundleAdapterNotes?: string;
  /**
   * Fidelity gate consumer flags (2026-09-28) — populados quando assessCloneFidelity
   * retorna BLOCKED ou DEGRADED. Nunca previnem retorno do cloneLanding; consumers
   * (worker, backoffice) devem logar/alertar mas continuar o fluxo. Schema
   * migration futura pode persistir em landing_pages.clone_metadata.
   */
  fidelityVerdict?: CloneFidelityVerdict;
  fidelityBlocked?: boolean;
  fidelityDegraded?: boolean;
  fidelityFindings?: string[];
  /**
   * Métricas observacionais do HTML final — populadas pelo mesmo pass do
   * fidelity gate. NÃO afetam verdict/consumer flags. Persistidas em
   * clone_metadata.fidelity_metrics pra debug/tuning futuro sem migration.
   */
  fidelityMetrics?: CloneFidelityMetrics;
}

/**
 * Padrões de scripts BLOQUEADOS (allowlist-inversa). Removidos por segurança
 * ou pra evitar poluir a experiência do lojista. Preserva TODO o restante
 * (galeria, FAQ accordion, tabs, bundles, custom UX) — essencial pra que a
 * landing clonada continue interativa depois de deployada.
 *
 * Estratégia: match por conteúdo/src pra pegar scripts que:
 *   - Enviam analytics/pixels pra domínio de terceiro (GA/GTM/Meta/TT)
 *   - Chamam checkout de plataformas conhecidas (Shopify/WooCommerce checkout —
 *     substituído pelo nosso checkout-handler-injector)
 *   - Fazem popup de cookie que iria confundir o dono da landing
 */
const BLOCKED_SCRIPT_PATTERNS: RegExp[] = [
  // Analytics/pixels de terceiros
  /googletagmanager\.com/i,
  /google-analytics\.com/i,
  /gtag\(/i,
  /fbevents\.js/i,
  /facebook\.com\/tr/i,
  /connect\.facebook\.net/i,
  /analytics\.tiktok\.com/i,
  /clarity\.ms/i,
  /hotjar\.com/i,
  /segment\.io/i,
  /amplitude\.com/i,
  /mixpanel\.com/i,
  /snap\.licdn\.com/i,
  // Shopify Web Pixels Manager — carrega pixels configurados no admin
  // da loja origem (pixel_type:facebook_pixel do CONCORRENTE). Mesmo não
  // carregando fbevents.js direto, o wpmLoader faz
  // /web-pixels/web-pixel-{id}@{hash}/pixel.modern.js que emite /tr pra
  // conta do concorrente a partir da nossa landing. Dupla contaminação
  // quando combinado com o nosso Pixel LandingLab injetado.
  /wpmLoader\s*=\s*function/i,
  /webPixelsManager\.(init|publish)/i,
  /"pixel_type"\s*:\s*"facebook_pixel"/i,
  /window\.Shopify\.analytics\s*=/i,
  /\/web-pixels@[^\s"']*\/app\/web-pixel-/i,
  // Cookie banners populares (UX ruído)
  /cookieconsent/i,
  /onetrust/i,
  /cookiebot/i,
  // Campanhas de marketing capturadas já abertas no HTML renderizado
  /sc-subscribe-popup/i,
  /backend\.alia-prod\.com/i,
  /ALIA_SHOPIFY_EXTENSION/i,
  // Story 16.3 — tracker do Sphere Affiliates (terceiro, opcional). Removido por padrão;
  // só o tracker exato sobrevive com `allowSphereTracker` (ver isAllowedSphereTracker).
  /sphereaffiliate\.com/i,
  // Checkout de plataforma origem (substituído pelo nosso)
  /shopify\.com\/checkouts/i,
  /woocommerce\.checkout/i,
  // Artifacts de browser capture — extensões Chrome/Firefox injetadas durante
  // a captura do HTML. Nunca são assets do tema; executar fora do contexto da
  // extensão lança SecurityError ou silenciosamente quebra globals do tema.
  /chrome-extension:\/\//i,
  /moz-extension:\/\//i,
  // Frameworks React/Next.js chunks — payloads de hydration NUNCA funcionam
  // fora do site origem (referenciam chunks compilados por build ID especifico).
  // Preservar quebra a página inteira com "Application error client-side".
  // A UX de galeria/FAQ/bundles em sites Next.js e feita pelo hydration payload,
  // então clonando um Next.js site NAO da pra preservar interatividade origem —
  // precisa injetar UX generico. Mas ao menos bloqueando aqui a pagina NAO CRASHA.
  /self\.__next_f\.push/,
  /self\.__next_f\s*=/,
  /window\.__NEXT_DATA__/,
  /__NEXT_ROUTER_STATE__/,
  /_next\/static\/chunks/,
  // Nuxt.js (Vue SSR) — mesmo problema
  /window\.__NUXT__/,
  /_nuxt\/entry\./,
  // React root direct render
  /ReactDOM\.hydrateRoot/,
  /ReactDOM\.hydrate/,
];

/**
 * Story 16.3 — tracker opcional do Sphere (espelho de `SPHERE_TRACKER_URL` em
 * `@blackshop/shared/external-checkout`; paridade em teste). Host e path fixos, https only.
 */
export const SPHERE_TRACKER_URL = 'https://sphereaffiliate.com/api/public/tracker.js';
const SPHERE_TRACKER_TAG = `<script src="${SPHERE_TRACKER_URL}" defer data-landinglab-sphere-tracker="1"></script>`;

export interface SanitizeOptions {
  /** Default false: qualquer script de sphereaffiliate.com é removido. */
  allowSphereTracker?: boolean;
}

/** URL de script (absoluta) ou tag <script ...> que carrega EXATAMENTE o tracker do Sphere. */
function isAllowedSphereTracker(scriptOrUrl: string): boolean {
  if (!scriptOrUrl.startsWith('<')) return scriptOrUrl === SPHERE_TRACKER_URL;
  const open = /^<script\b[^>]*>/i.exec(scriptOrUrl)?.[0] ?? '';
  const src = /\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(open)?.[1]?.replace(/&amp;/g, '&');
  const body = scriptOrUrl.slice(open.length).replace(/<\/script>\s*$/i, '');
  return src === SPHERE_TRACKER_URL && !body.trim();
}

function isBlockedScript(scriptOrUrl: string, opts?: SanitizeOptions): boolean {
  if (opts?.allowSphereTracker && isAllowedSphereTracker(scriptOrUrl)) return false;
  return BLOCKED_SCRIPT_PATTERNS.some((re) => re.test(scriptOrUrl));
}

function hasSphereTrackerTag(html: string): boolean {
  return (html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? []).some((tag) => isAllowedSphereTracker(tag));
}

const CAPTURED_MARKETING_POPUP_SELECTORS = [
  '#sc-subscribe-popup',
  '.sc-popup-overlay',
  '[id^="alia-root-"]',
  '[id^="alia-popup-root-"]',
].join(',');

// ─── Static Script Enricher ────────────────────────────────────────────────

/**
 * Dado o HTML do DOM capturado (pode ter perdido <script src defer>) e o
 * HTML estático da URL de origem, retorna os scriptUrls presentes no estático
 * mas ausentes no capturado, excluindo padrões bloqueados.
 *
 * Regras (formalizadas em CLONE ASSET RELINK spec):
 *   1. Obtém scripts do HTML estático via parseHtmlOverride
 *   2. Remove scripts já presentes no DOM capturado (sem duplicação)
 *   3. Aplica BLOCKED_SCRIPT_PATTERNS (trackers/analytics/commerce)
 *   4. Preserva ordem relativa dos scripts no HTML estático
 *   5. Nunca lança — retorna [] em caso de falha
 */
export function extractMissingStaticScripts(
  domScriptUrls: string[],
  staticHtml: string,
  baseUrl: string,
  opts?: SanitizeOptions,
): string[] {
  const staticParsed = parseHtmlOverride(staticHtml, baseUrl);
  const existing = new Set(domScriptUrls);
  return staticParsed.scriptUrls.filter((u) => !existing.has(u) && !isBlockedScript(u, opts));
}

// ─── Clone Fidelity Gate ───────────────────────────────────────────────────

export type CloneFidelityVerdict = 'HEALTHY' | 'DEGRADED' | 'BLOCKED';

/**
 * Métricas observacionais de tamanho/estrutura do HTML clonado. Puramente
 * pra debug e tuning — NÃO influencia o verdict do gate. Adicionadas em
 * 2026-09-29 (observability sem mudar comportamento).
 */
export interface CloneFidelityMetrics {
  /** Soma de Buffer.byteLength(utf8) do conteúdo de TODOS os <style>...</style>. */
  totalCssBytes: number;
  /** Contagem de blocos <style>...</style> inline. */
  inlineStyleBlocks: number;
  /** Contagem de <link rel="stylesheet"> (URL externa ou local). */
  externalStylesheetLinks: number;
  /** Tamanho total do HTML final em bytes UTF-8. */
  totalHtmlBytes: number;
  /** Contagem de tags <script (com ou sem src). */
  scriptTagCount: number;
}

export interface CloneFidelityResult {
  verdict: CloneFidelityVerdict;
  findings: string[];
  metrics: CloneFidelityMetrics;
}

/**
 * Avalia o HTML clonado final e retorna um veredicto de fidelidade.
 *
 * HEALTHY  — zero critical losses
 * DEGRADED — perda não-crítica ou warning de runtime externo opcional
 * BLOCKED  — perda de script crítico ou CSS missing ou browser-extension artifact
 */
export function assessCloneFidelity(html: string): CloneFidelityResult {
  const findings: string[] = [];

  // BLOCKED: browser-extension artifacts que escaparam do sanitize
  if (/src=["'](?:chrome|moz)-extension:\/\//i.test(html)) {
    findings.push('BLOCKED:browser-extension-artifact');
  }

  // BLOCKED: critical CSS missing — nenhum <style> ou <link rel="stylesheet">
  const hasCss =
    /<style[\s>]/i.test(html) || /<link[^>]+rel=["']stylesheet["']/i.test(html);
  if (!hasCss) {
    findings.push('BLOCKED:critical-css-missing');
  }

  // BLOCKED: script com imports relativos não-resolvidos (entry point quebrado)
  // Padrão: <script src="..."> cujo conteúdo começa com import"./
  // Não podemos verificar conteúdo aqui, mas podemos detectar o padrão do Loop
  // Subscriptions que sabidamente quebra (entry point com imports relativos).
  // Heurística: scripts < 2KB de CDN de extensão Shopify que não são do tema.
  // (Verificação de conteúdo fica no download pipeline — aqui só HTML.)

  // DEGRADED: referências externas não-frozen (URLs de domínio de origem)
  const originRefs = html.match(/src=["'](?:https?:)?\/\/(?!(?:cdn\.shopify\.com|supabase\.co))[^\s"']+\.js["']/g) ?? [];
  // Filtrar URLs que são do Shopify CDN shopifycloud (aceitas como externas)
  const nonCdnOriginRefs = originRefs.filter(r =>
    !r.includes('cdn.shopify.com') &&
    !r.includes('shopifycloud') &&
    !r.includes('supabase.co')
  );
  if (nonCdnOriginRefs.length > 0) {
    findings.push(`DEGRADED:non-frozen-script-refs(${nonCdnOriginRefs.length})`);
  }

  // DEGRADED: scripts recuperados duplicados — sinal de bug no enricher merge.
  // Um mesmo URL aparecendo 2+ vezes como <script src="X"> indica que o
  // enricher (extractMissingStaticScripts) ou o dedupe do combine falhou.
  // Não é BLOCKED porque browsers geralmente toleram (chamam 2x mas seguem),
  // mas é sinal de que a lógica de dedupe precisa investigação.
  const scriptSrcMatches = html.match(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi) ?? [];
  const srcCounts = new Map<string, number>();
  for (const tag of scriptSrcMatches) {
    const m = tag.match(/src=["']([^"']+)["']/i);
    if (!m || !m[1]) continue;
    srcCounts.set(m[1], (srcCounts.get(m[1]) ?? 0) + 1);
  }
  const duplicated = [...srcCounts.entries()].filter(([, c]) => c > 1);
  if (duplicated.length > 0) {
    findings.push(`DEGRADED:duplicate-script-refs(${duplicated.length})`);
  }

  // DEGRADED: evidência de asset rewrite falho — placeholders de template
  // literal não substituídos (ex: `{{ cdn_url }}`, `{{asset_url}}`, `${cdnUrl}`)
  // ou paths /cloned/undefined/ que indicam que urlMap não teve entrada.
  // Bug clássico: static-script-enricher adiciona URL mas download.urlMap não
  // baixou (rede falhou) — url absoluta original fica no HTML.
  const unresolvedTemplates = /\{\{[\s]*(?:cdn_url|asset_url|shop\.url|shop_url)[\s|][^}]*\}\}/i.test(html)
    || /\$\{[\s]*(?:cdnUrl|assetUrl|shopUrl)[\s]*\}/i.test(html)
    || /\/cloned\/undefined\//i.test(html);
  if (unresolvedTemplates) {
    findings.push('DEGRADED:unresolved-asset-placeholders');
  }

  const blocked = findings.some((f) => f.startsWith('BLOCKED'));
  const degraded = !blocked && findings.some((f) => f.startsWith('DEGRADED'));

  // Métricas observacionais — não afetam verdict. Calculadas no MESMO pass pra
  // aproveitar cache de string do HTML e evitar segundo parse.
  let totalCssBytes = 0;
  let inlineStyleBlocks = 0;
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    totalCssBytes += Buffer.byteLength(m[1] ?? '', 'utf8');
    inlineStyleBlocks++;
  }
  const externalStylesheetLinks =
    (html.match(/<link[^>]+rel=["']stylesheet["']/gi) ?? []).length;
  const totalHtmlBytes = Buffer.byteLength(html, 'utf8');
  const scriptTagCount = (html.match(/<script\b/gi) ?? []).length;

  const metrics: CloneFidelityMetrics = {
    totalCssBytes,
    inlineStyleBlocks,
    externalStylesheetLinks,
    totalHtmlBytes,
    scriptTagCount,
  };

  return {
    verdict: blocked ? 'BLOCKED' : degraded ? 'DEGRADED' : 'HEALTHY',
    findings,
    metrics,
  };
}

/**
 * Remove campanhas de marketing que o Playwright pode capturar já abertas.
 * A checagem inicial evita parsear/serializar clones que não têm esses nós.
 */
function removeCapturedMarketingPopups(html: string): string {
  const hasPopupElement =
    /<[^>]+\bid\s*=\s*["'](?:sc-subscribe-popup|alia-(?:popup-)?root-[^"']*)["']/i.test(html) ||
    /<[^>]+\bclass\s*=\s*["'][^"']*\bsc-popup-overlay\b[^"']*["']/i.test(html);

  if (!hasPopupElement) return html;

  const $ = cheerio.load(html);
  $(CAPTURED_MARKETING_POPUP_SELECTORS).remove();
  return $.html();
}

/**
 * Remove <script>s de trackers/analytics/checkout-origem preservando o
 * restante — inline UX scripts (galerias, FAQs, bundles) ficam intactos.
 * Também remove <noscript> (não faz sentido em landing servida por SSR).
 */
export function sanitizeHtml(html: string, opts?: SanitizeOptions): string {
  let out = removeCapturedMarketingPopups(html);

  // Remove <script> individuais que batem com padrões bloqueados.
  // Mantém: JSON-LD, scripts inline de UX (galeria, FAQ, tabs), .js internos.
  out = out.replace(
    /<script\b[^>]*>[\s\S]*?<\/script>/gi,
    (match) => {
      // JSON-LD sempre preservado (SEO structured data).
      if (/type=["']application\/ld\+json["']/i.test(match)) return match;
      // Bloqueia se qualquer padrão bater (por src ou por conteúdo inline).
      if (isBlockedScript(match, opts)) return '';
      // Passa: qualquer outro <script> (interatividade da landing origem).
      return match;
    },
  );

  // Story 16.3 — tracker do Sphere opt-in: injeta no <head> se ausente (idempotente).
  if (opts?.allowSphereTracker && !hasSphereTrackerTag(out) && /<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (match) => `${match}${SPHERE_TRACKER_TAG}`);
  }

  // <noscript> não faz sentido em landing sempre-JS (SSR + JS habilitado).
  out = out.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');

  // Event handlers inline (onclick, onload, etc) FICAM preservados — muitos
  // sites Shopify/WooCommerce usam onclick pra abrir bundle/lightbox.
  // DOMPurify no storefront ainda vai filtrar handlers perigosos (javascript:).

  // Task #21 — opacity:0 inline: scroll-reveal via IntersectionObserver
  // geralmente vem com class .animate-on-scroll que o site aciona via JS.
  // Como AGORA preservamos os scripts, deixa animation rodar normal — mas
  // se opacity:0 persistir por causa de CSS sem JS observer, força visível.
  // Heurística: só reverte opacity:0 quando NÃO temos IntersectionObserver
  // no HTML. Como scripts ficam, na maioria dos casos vai animar corretamente.
  const hasIntersectionObs = /IntersectionObserver/.test(out);
  if (!hasIntersectionObs) {
    out = out.replace(/(\s|;)opacity\s*:\s*0(?:\.0+)?\s*(?=[;"'])/gi, '$1opacity:1');
  }

  // Task #25 — força color-scheme light (landing de vendas ≠ dark mode).
  if (/<head[^>]*>/i.test(out) && !/name=["']color-scheme["']/i.test(out)) {
    out = out.replace(
      /<head[^>]*>/i,
      (match) => `${match}<meta name="color-scheme" content="light only">`,
    );
  }

  return out;
}

/**
 * Extrai URLs referenciadas via `url(...)` de dentro de um CSS.
 * Cobre @font-face src, background-image, cursor, list-style-image, etc.
 */
export function extractCssUrls(css: string, baseUrl: string): string[] {
  const urls: string[] = [];
  const re = /url\(\s*["']?([^"')\s]+)["']?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const raw = m[1];
    if (!raw || raw.startsWith('data:')) continue;
    try {
      urls.push(new URL(raw, baseUrl).toString());
    } catch {
      // URL malformada, skip.
    }
  }
  return urls;
}

/** Substitui inline as URLs no CSS baseado no urlMap. */
function rewriteCssUrls(css: string, urlMap: Map<string, string>): string {
  return rewriteUrls(css, urlMap); // mesma lógica string-replace do HTML rewriter
}

/**
 * Absolutiza url(...) dentro do body de um CSS baseado na URL do próprio CSS.
 * Necessário pra que rewriteCssUrls encontre matches — urlMap tem chaves absolutas
 * mas o CSS original tem paths relativos ao stylesheet.
 */
export function absolutizeCssUrls(css: string, cssBaseUrl: string): string {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (match, quote, u) => {
    if (!u || u.startsWith('data:') || /^https?:/i.test(u)) return match;
    try {
      const abs = new URL(u, cssBaseUrl).toString();
      return `url(${quote}${abs}${quote})`;
    } catch {
      return match;
    }
  });
}

/** Helper interno — retorna resultado parcial marcado com aborted:true.
 * Usado quando input.signal fica aborted entre fases (cliente SSE desconectou).
 * Nunca lança exceção — caller decide se persiste ou descarta o resultado. */
function buildAbortedResult(
  input: CloneInput,
  stage: string,
  partial: Partial<CloneResult>,
  started: number,
  trace: CloneResult['trace'],
): CloneResult {
  safeEmit(input.onProgress, {
    phase: 'aborted',
    reason: 'client_disconnected',
    stage,
  });
  return {
    finalUrl: partial.finalUrl ?? input.url,
    html: partial.html ?? '',
    title: partial.title ?? '',
    detectedLanguage: partial.detectedLanguage ?? null,
    assets: partial.assets ?? [],
    failedAssets: partial.failedAssets ?? [],
    imageUrls: partial.imageUrls ?? [],
    bytes: partial.bytes ?? 0,
    latencyMs: Date.now() - started,
    trace,
    aborted: true,
    abortedAt: stage,
  };
}

/**
 * Extrai URLs e metadados de um HTML colado usando cheerio (sem browser).
 * Réplica funcional do que renderer.ts faz via page.evaluate, mas 100%
 * server-side. Usado quando input.htmlOverride está presente (html-only mode).
 *
 * Diferenças vs renderer real:
 *   - Sem execução de JS (imagens/CSS injetados dinamicamente NÃO aparecem)
 *   - Sem lazy-load resolution (URLs em `data-src` são recuperadas se possível)
 *   - Sem coleta de background-image de CSS externo (o CSS ainda é baixado
 *     depois no fluxo normal, ali as urls são extraídas)
 */
function parseHtmlOverride(html: string, baseUrl: string): RenderOutput {
  const $ = cheerio.load(html);

  const dedupe = (arr: string[]): string[] => Array.from(new Set(arr.filter((x) => x)));

  const imageUrls: string[] = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src') ?? $(el).attr('data-src') ?? $(el).attr('data-lazy-src');
    const abs = absolutize(src, baseUrl);
    if (abs) imageUrls.push(abs);
    const srcset = $(el).attr('srcset') ?? $(el).attr('data-srcset');
    if (srcset) {
      srcset.split(',').forEach((part) => {
        const url = part.trim().split(/\s+/)[0];
        const absUrl = absolutize(url, baseUrl);
        if (absUrl) imageUrls.push(absUrl);
      });
    }
  });
  $('source[srcset]').each((_, el) => {
    const srcset = $(el).attr('srcset');
    if (!srcset) return;
    srcset.split(',').forEach((part) => {
      const url = part.trim().split(/\s+/)[0];
      const abs = absolutize(url, baseUrl);
      if (abs) imageUrls.push(abs);
    });
  });

  const stylesheetUrls: string[] = [];
  $('link[rel="stylesheet"][href]').each((_, el) => {
    const abs = absolutize($(el).attr('href'), baseUrl);
    if (abs) stylesheetUrls.push(abs);
  });

  const fontUrls: string[] = [];
  $('link[rel="preload"][as="font"][href]').each((_, el) => {
    const abs = absolutize($(el).attr('href'), baseUrl);
    if (abs) fontUrls.push(abs);
  });

  const scriptUrls: string[] = [];
  $('script[src]').each((_, el) => {
    const abs = absolutize($(el).attr('src'), baseUrl);
    if (abs) scriptUrls.push(abs);
  });

  const title = $('title').first().text().trim();
  const detectedLanguage = $('html').attr('lang') ?? null;

  return {
    finalUrl: baseUrl,
    html,
    imageUrls: dedupe(imageUrls),
    stylesheetUrls: dedupe(stylesheetUrls),
    fontUrls: dedupe(fontUrls),
    scriptUrls: dedupe(scriptUrls),
    title,
    detectedLanguage,
    bytes: Buffer.byteLength(html, 'utf8'),
    latencyMs: 0,
  };
}

export async function cloneLanding(input: CloneInput): Promise<CloneResult> {
  const trace: CloneResult['trace'] = [];
  const started = Date.now();
  safeEmit(input.onProgress, { phase: 'start', url: input.url });

  // Caller pode ter marcado como abortado antes do primeiro await — checa aqui
  // pra evitar até mesmo o custo do Playwright cold start.
  if (input.signal?.aborted) {
    return buildAbortedResult(input, 'pre-render', {}, started, trace);
  }

  // ─── 1. Render ─────────────────────────────────────────────────────
  // html-only mode: skipa Playwright, extrai tudo via cheerio (rápido, sem
  // anti-bot, sem cold start, sem custo de RAM).
  safeEmit(input.onProgress, { phase: 'render:started' });
  const t1 = Date.now();
  const rendered: RenderOutput = input.htmlOverride
    ? parseHtmlOverride(input.htmlOverride, input.url)
    : await renderPage({ url: input.url });

  // Story 15.2: moeda da origem, lida antes de qualquer reescrita do HTML.
  const detectedCurrency = detectSourceCurrency(rendered.html);
  // currency null = manter a da origem; casas decimais/pixel seguem a detectada.
  const effectiveCurrency = input.currency ?? detectedCurrency;

  // htmlOverride gap: o DOM serializado pelo browser perde <script src defer>
  // do tema porque o Shopify os executa e pode removê-los do DOM antes da
  // captura. Para recuperar esses scripts, fetch o HTML estático da URL de
  // origem e combina os scriptUrls (apenas scripts ausentes são adicionados).
  let recoveredStaticScriptsCount = 0;
  if (input.htmlOverride && input.url) {
    try {
      const staticRes = await fetch(input.url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; LandingLabCloner/1.0)',
          'accept': 'text/html',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (staticRes.ok) {
        const staticHtml = await staticRes.text();
        const newScripts = extractMissingStaticScripts(rendered.scriptUrls, staticHtml, input.url, {
          allowSphereTracker: input.allowSphereTracker === true,
        });
        if (newScripts.length > 0) {
          rendered.scriptUrls = [...rendered.scriptUrls, ...newScripts];
          recoveredStaticScriptsCount = newScripts.length;
          trace.push({
            agent: 'static-script-enricher',
            latency_ms: 0,
            notes: `${newScripts.length} scripts recuperados do HTML estático`,
          });
        }
      }
    } catch {
      // Best-effort — falha silenciosa não bloqueia clone
    }
  }

  const renderLatency = Date.now() - t1;
  trace.push({
    agent: 'renderer',
    latency_ms: renderLatency,
    notes: `${rendered.imageUrls.length} imgs, ${rendered.stylesheetUrls.length} css, ${rendered.fontUrls.length} fonts`,
  });
  safeEmit(input.onProgress, {
    phase: 'render:done',
    imageUrls: rendered.imageUrls.length,
    stylesheets: rendered.stylesheetUrls.length,
    fonts: rendered.fontUrls.length,
    latencyMs: renderLatency,
  });

  // Abort check pós-render — Playwright já foi consumido (não recuperável), mas
  // ainda podemos pular CSS fetch + download batch (parte mais cara em rede).
  if (input.signal?.aborted) {
    return buildAbortedResult(
      input,
      'post-render',
      {
        finalUrl: rendered.finalUrl,
        title: rendered.title,
        detectedLanguage: rendered.detectedLanguage,
      },
      started,
      trace,
    );
  }

  // ─── 2. Baixa CSS pra extrair url(...) interno ─────────────────────
  safeEmit(input.onProgress, { phase: 'css:started', count: rendered.stylesheetUrls.length });
  const cssFetches = await Promise.allSettled(
    rendered.stylesheetUrls.map(async (cssUrl) => {
      const res = await fetch(cssUrl, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; LandingLabCloner/1.0)' },
      });
      if (!res.ok) throw new Error(`css HTTP ${res.status}`);
      return { url: cssUrl, body: await res.text() };
    }),
  );
  const cssBodies = new Map<string, string>();
  const cssInternalUrls: string[] = [];
  for (const settled of cssFetches) {
    if (settled.status === 'fulfilled') {
      cssBodies.set(settled.value.url, settled.value.body);
      cssInternalUrls.push(...extractCssUrls(settled.value.body, settled.value.url));
    }
  }

  // Task #24 — absolutiza + extrai url(...) de dentro de <style> inline.
  // Sites Next.js/React frequentemente inlineiam CSS com @font-face src
  // apontando pra /_next/static/media/{hash}.woff2 (paths relativos). O
  // renderer.ts absolutiza APENAS atributos HTML — conteúdo de <style>
  // permanece com paths relativos, então:
  //   1. Substituímos rendered.html: url(/foo) → url(https://origem/foo)
  //   2. Extraímos as URLs (agora absolutas) pra baixar
  // Consequência: rewriteUrls posterior substitui URLs absolutas pelas locais.
  const inlineStyleUrls: string[] = [];
  rendered.html = rendered.html.replace(
    /<style[^>]*>[\s\S]*?<\/style>/gi,
    (styleBlock) => {
      return styleBlock.replace(
        /url\(\s*(["']?)([^"')]+)\1\s*\)/g,
        (match, quote, u) => {
          if (!u || u.startsWith('data:') || /^https?:/i.test(u)) return match;
          try {
            const abs = new URL(u, rendered.finalUrl).toString();
            inlineStyleUrls.push(abs);
            return `url(${quote}${abs}${quote})`;
          } catch {
            return match;
          }
        },
      );
    },
  );
  // Também extrai URLs absolutas que já estavam em <style> (imgs de CDN).
  const absStyleMatches = rendered.html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi);
  for (const m of absStyleMatches) {
    const css = m[1];
    if (css) inlineStyleUrls.push(...extractCssUrls(css, rendered.finalUrl));
  }

  trace.push({
    agent: 'css-extractor',
    latency_ms: 0,
    notes: `${cssBodies.size}/${rendered.stylesheetUrls.length} css baixados, ${cssInternalUrls.length + inlineStyleUrls.length} URLs internos (${inlineStyleUrls.length} inline)`,
  });
  safeEmit(input.onProgress, {
    phase: 'css:done',
    downloaded: cssBodies.size,
    internalUrls: cssInternalUrls.length + inlineStyleUrls.length,
  });

  // Abort check pós-CSS — antes do download batch (fase mais pesada em rede,
  // frequentemente centenas de assets em paralelo).
  if (input.signal?.aborted) {
    return buildAbortedResult(
      input,
      'post-css',
      {
        finalUrl: rendered.finalUrl,
        title: rendered.title,
        detectedLanguage: rendered.detectedLanguage,
      },
      started,
      trace,
    );
  }

  // ─── 3. Download batch (imgs + css + fonts + scripts + urls internos de CSS) ──
  // Filtra scripts que já sabemos que são trackers/pixel/analytics — não baixa,
  // não reescreve. Preserva scripts de UX (galeria, FAQ, tabs, bundles) do site.
  const TRACKER_HOSTS = [
    'googletagmanager.com',
    'google-analytics.com',
    'googlesyndication.com',
    'facebook.com',
    'connect.facebook.net',
    'fbcdn.net',
    'doubleclick.net',
    'hotjar.com',
    'segment.io',
    'segment.com',
    'amplitude.com',
    'mixpanel.com',
    'clarity.ms',
    'criteo.com',
    'tiktok.com',
    'snap.licdn.com',
    'onetrust.com',
    'cookiebot.com',
  ];
  const isTrackerUrl = (u: string): boolean => {
    try {
      const host = new URL(u).hostname.toLowerCase();
      return TRACKER_HOSTS.some((h) => host === h || host.endsWith('.' + h));
    } catch {
      return false;
    }
  };
  /**
   * Fix set/2026: alguns bundles Shopify (Kaching, PickyStory, etc) usam
   * ES modules com `import` internos. Se baixarmos só o script principal,
   * os chunks referenciados via import ficam 404 e o JS quebra. Solução:
   * PRESERVAR URL original do CDN Shopify pra scripts de extension — browser
   * carrega tudo direto do Shopify, imports internos funcionam.
   *
   * Padrão: `cdn.shopify.com/extensions/{uuid}/{ext-name}-{version}/assets/*.js`
   *
   * Alternativa não escolhida: baixar recursivamente todos chunks — requer
   * parser AST + rewrite dos imports internos. Complexidade alta.
   */
  const isShopifyExtensionScript = (u: string): boolean => {
    try {
      const url = new URL(u);
      const host = url.hostname.toLowerCase();
      return (
        (host === 'cdn.shopify.com' || host.endsWith('.cdn.shopify.com')) &&
        url.pathname.startsWith('/extensions/') &&
        url.pathname.endsWith('.js')
      );
    } catch {
      return false;
    }
  };
  const scriptUrls = (rendered.scriptUrls ?? []).filter(
    (u) => !isTrackerUrl(u) && !isShopifyExtensionScript(u),
  );

  const allUrls = Array.from(
    new Set([
      ...rendered.imageUrls,
      ...rendered.stylesheetUrls,
      ...rendered.fontUrls,
      ...cssInternalUrls,
      ...inlineStyleUrls, // Task #24 — fontes/imagens de <style> inline
      ...scriptUrls, // Fase 5.A.2 — preservação interatividade (galeria/FAQ/bundle)
    ]),
  );
  safeEmit(input.onProgress, { phase: 'download:started', total: allUrls.length });
  const t3 = Date.now();
  const download = await downloadAssets({
    landingId: input.landingId,
    urls: allUrls,
    storageRoot: input.storageRoot,
    publicPathPrefix: input.publicPathPrefix,
    referer: input.url,
  });
  const downloadLatency = Date.now() - t3;
  trace.push({
    agent: 'asset-downloader',
    latency_ms: downloadLatency,
    notes: `${download.assets.length} ok / ${download.failed.length} fail (${allUrls.length} total)`,
  });
  safeEmit(input.onProgress, {
    phase: 'download:done',
    ok: download.assets.length,
    failed: download.failed.length,
    latencyMs: downloadLatency,
  });

  // Abort check pós-download — rewrite/sanitize são baratos (só CPU string),
  // mas se cliente desistiu, ainda economiza serialização + retorno de payload
  // grande via HTTP.
  if (input.signal?.aborted) {
    return buildAbortedResult(
      input,
      'post-download',
      {
        finalUrl: rendered.finalUrl,
        title: rendered.title,
        detectedLanguage: rendered.detectedLanguage,
        assets: download.assets,
        failedAssets: download.failed,
      },
      started,
      trace,
    );
  }

  // ─── 4. Reescreve CSSs e insere inline no HTML ─────────────────────
  // Estratégia: pra cada <link rel="stylesheet" href="X">, se conseguimos
  // baixar X, substituímos por <style>{cssReescrito}</style>. Isso
  // desacopla do CDN original completamente.
  safeEmit(input.onProgress, { phase: 'rewrite:started' });
  let htmlWithInlineCss = rendered.html;
  for (const [cssUrl, cssBody] of cssBodies.entries()) {
    // Passo 1: absolutiza urls relativas do CSS (paths /foo → https://origem/foo)
    // Passo 2: rewrite substitui URLs absolutas pelos paths locais /cloned/{id}/{hash}.
    const cssAbsolute = absolutizeCssUrls(cssBody, cssUrl);
    const rewrittenCss = rewriteCssUrls(cssAbsolute, download.urlMap);
    // Substitui <link rel="stylesheet" href="cssUrl" ...> por <style>...</style>
    const escaped = cssUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const linkRe = new RegExp(
      `<link[^>]*href=["']${escaped}["'][^>]*>`,
      'gi',
    );
    htmlWithInlineCss = htmlWithInlineCss.replace(
      linkRe,
      `<style data-cloned-from="${cssUrl}">${rewrittenCss}</style>`,
    );
  }

  // ─── 5. Reescreve URLs restantes no HTML (imgs, fonts, srcset) ─────
  const htmlRewritten = rewriteUrls(htmlWithInlineCss, download.urlMap);
  safeEmit(input.onProgress, { phase: 'rewrite:done' });

  // ─── 6. Sanitiza (remove <script>, <noscript>, on* handlers) ───────
  const htmlSanitized = sanitizeHtml(htmlRewritten, { allowSphereTracker: input.allowSphereTracker === true });

  // ─── 6.5. Bundle Engine V2 — adapters + runtime script ────────────
  // (set/2026) Detecta bundles do app do concorrente (Kaching, radios, etc),
  // extrai ofertas padronizadas, REMOVE JS do concorrente e marca cards com
  // data-ll-*. Depois injeta script universal que popula os data-ll-* a
  // partir de window.__LL_BUNDLE_OFFERS__ (setado pelo storefront do banco).
  //
  // Se nenhum adapter casar (adapter === 'none'), pula: worker mantém
  // use_new_bundle_engine=false e comportamento antigo continua.
  const bundleResult = applyBundleAdapters(htmlSanitized);
  // fractionDigits via Intl: 0 para JPY/KRW/VND, 2 para USD/EUR/etc.
  // Injetado como literal no ES5 runtime script — sem dep externa no cloner.
  const fractionDigits = (() => {
    if (!effectiveCurrency) return 2;
    try {
      return new Intl.NumberFormat('en', { style: 'currency', currency: effectiveCurrency })
        .resolvedOptions().maximumFractionDigits;
    } catch { return 2; }
  })();
  const htmlAfterBundles = bundleResult.adapter !== 'none'
    ? injectBundleRuntime(bundleResult.html, fractionDigits)
    : bundleResult.html;

  // ─── 7. Injeta checkout handler (script próprio, seguro) ──────────
  // DEPOIS do sanitize pra que o próprio script não seja removido.
  // Detecta cliques em [data-landing-cta="buy"] + [data-landing-variant-id]
  // e dispara POST /api/landing-checkout com attribution auto-coletada.
  // Story 16.3: provider `external` não injeta o POST (o storefront serve a navegação direta).
  const htmlWithCheckout = injectCheckoutHandler(htmlAfterBundles, {
    provider: input.checkoutProvider ?? undefined,
  });

  // ─── 8. Injeta Meta Pixel (se configurado) ────────────────────────
  // DEPOIS do checkout handler porque pixel deve ser o primeiro script
  // no <head> pra capturar todas as interações. Se pixelConfig for null
  // ou pixelId inválido, injectMetaPixel retorna HTML original (no-op).
  const pixelConfig =
    input.pixelConfig && !input.currency && detectedCurrency
      ? { ...input.pixelConfig, currency: detectedCurrency }
      : (input.pixelConfig ?? null);
  const htmlWithPixel = injectMetaPixel(htmlWithCheckout, pixelConfig);

  // ─── 8.5. Injeta fixes de UX/HTML (nasceram em apply-bundle.processor) ─
  // Rodando aqui garante que clone puro (SEM apply-bundle) ja sai com:
  //   - Sem body{zoom:90%} (quebra Swiper)
  //   - Reviews altura auto (sem 700/780px fixed)
  //   - Timeline destroy-Swiper fallback
  //   - Softgels count nos bundles
  //   - Sem "Risparmia il 50%" subtitle
  //   - HTML entities double-escaped decoded
  //   - Product JSON com currency correto (se input.currency setado)
  const htmlClean = injectLandingLabFixes({ html: htmlWithPixel, currency: input.currency ?? null });
  safeEmit(input.onProgress, { phase: 'sanitize:done' });

  const imageLocalUrls = download.assets
    .filter((a) => a.contentType.startsWith('image/'))
    .map((a) => a.publicUrl);

  // ─── 9. Fidelity assessment (observability light) ─────────────────
  // Empurra métricas do gate no trace pra debugar clones ruins pós-fato.
  // Sem tabela nova, sem migration — trace já é persistido pela pipeline.
  // landingPageIdRewritten=true é constante pós-#142 (fix root cause do
  // apply-bundle) e mantido explícito no log pra facilitar filtro histórico.
  const fidelityStart = Date.now();
  const fidelity = assessCloneFidelity(htmlClean);
  const blockedBrowserArtifacts = fidelity.findings.filter((f) =>
    f.includes('browser-extension-artifact'),
  ).length;
  const unresolvedExternalScripts = fidelity.findings.filter((f) =>
    f.includes('non-frozen-script-refs'),
  ).length;
  const criticalCssPresent = !fidelity.findings.some((f) =>
    f.includes('critical-css-missing'),
  );
  trace.push({
    agent: 'fidelity-gate',
    latency_ms: Date.now() - fidelityStart,
    notes: JSON.stringify({
      fidelityStatus: fidelity.verdict,
      recoveredStaticScripts: recoveredStaticScriptsCount,
      blockedBrowserArtifacts,
      unresolvedExternalScripts,
      criticalCssPresent,
      landingPageIdRewritten: true,
    }),
  });

  const totalLatency = Date.now() - started;
  const bytes = Buffer.byteLength(htmlClean, 'utf8');
  safeEmit(input.onProgress, {
    phase: 'complete',
    bytes,
    latencyMs: totalLatency,
    images: imageLocalUrls.length,
  });

  return {
    finalUrl: rendered.finalUrl,
    html: htmlClean,
    bundleAdapter: bundleResult.adapter,
    bundleOffers: bundleResult.offers,
    bundleAdapterNotes: bundleResult.notes,
    title: rendered.title,
    detectedLanguage: rendered.detectedLanguage,
    detectedCurrency,
    assets: download.assets,
    failedAssets: download.failed,
    imageUrls: imageLocalUrls,
    bytes,
    latencyMs: totalLatency,
    trace,
    fidelityVerdict: fidelity.verdict,
    fidelityBlocked: fidelity.verdict === 'BLOCKED',
    fidelityDegraded: fidelity.verdict === 'DEGRADED',
    fidelityFindings: fidelity.findings,
    fidelityMetrics: fidelity.metrics,
  };
}
