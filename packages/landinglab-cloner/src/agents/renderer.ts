// Renderer — Playwright-based page renderer.
//
// Squad 0 Fase 5.A. Renderiza JS, aguarda lazy load, retorna HTML final
// + lista de URLs de assets (imgs, styles, fonts). Design pragmático:
// - Chromium headless (mais compatibilidade que Firefox/Webkit pra sites Shopify)
// - User-agent real do Chrome (evita detectores triviais)
// - Viewport 1440x900 (comum, não desperta bot detection)
// - Referer google.com (~80% dos sites tratam bem)
// - Timeout hard 60s (páginas dropship pesadas mas nunca deveriam demorar mais)
// - Scroll até bottom pra disparar lazy-load
// - Bloqueia trackers/analytics no fetch pra acelerar (ads, meta pixel, GA)

import { chromium, type Browser, type Page } from 'playwright';

export interface RenderInput {
  url: string;
  /** Bloqueia scripts de tracking/analytics (default: true) — reduz peso e evita ruído. */
  blockTrackers?: boolean;
  /** Timeout total em ms (default: 60_000). */
  timeoutMs?: number;
}

export interface RenderOutput {
  finalUrl: string;
  html: string;
  /** Lista deduplicada de URLs de imagens usadas na página (from <img>, <source>, background-image). */
  imageUrls: string[];
  /** Stylesheets externas (<link rel="stylesheet">). */
  stylesheetUrls: string[];
  /** Fontes externas (@font-face src ou <link>). */
  fontUrls: string[];
  /** Scripts externos (<script src>) — preservados pra manter interatividade
   * (galeria, FAQ accordion, tabs, bundles). Filtrados por sanitizeHtml no
   * orchestrator (trackers/pixel/analytics são excluídos). */
  scriptUrls: string[];
  /** Título da página. */
  title: string;
  /** Content-language ou lang do <html>. */
  detectedLanguage: string | null;
  /** Tamanho do body renderizado em bytes. */
  bytes: number;
  latencyMs: number;
}

/**
 * Absolutiza uma URL relativa contra uma base. Preserva URLs já absolutas
 * (`https:`, `http:`), esquemas especiais (`data:`, `blob:`, `mailto:`, `tel:`),
 * âncoras (`#hash`) e protocol-relative (`//host/path`). Retorna a input
 * inalterada quando a URL é malformada. Usado tanto no Node (rewriter) quanto
 * dentro de `page.evaluate` (renderer browser context — copiado inline lá pra
 * respeitar isolamento de execução).
 */
export function absolutize(rel: string | null | undefined, baseUrl: string): string | null {
  if (rel == null) return null;
  if (rel === '') return rel;
  if (/^(https?:|data:|blob:|mailto:|tel:|#)/i.test(rel)) return rel;
  // Protocol-relative: //host/path → herda scheme do base.
  if (rel.startsWith('//')) {
    try {
      const baseScheme = new URL(baseUrl).protocol;
      return `${baseScheme}${rel}`;
    } catch {
      return rel;
    }
  }
  try {
    return new URL(rel, baseUrl).toString();
  } catch {
    return rel;
  }
}

/**
 * Absolutiza um atributo `srcset` inteiro, preservando descriptors (`1x`, `2x`,
 * `100w`, etc.) intactos após cada URL. Entradas separadas por vírgula,
 * espaçadas por whitespace. Retorna input inalterada quando `srcset` é falsy.
 */
export function absolutizeSrcset(srcset: string | null | undefined, baseUrl: string): string | null {
  if (srcset == null || srcset === '') return srcset ?? null;
  return srcset
    .split(',')
    .map((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) return '';
      const parts = trimmed.split(/\s+/);
      const url = parts[0] ?? '';
      const rest = parts.slice(1).join(' ');
      const abs = absolutize(url, baseUrl) ?? url;
      return rest ? `${abs} ${rest}` : abs;
    })
    .filter((s) => s.length > 0)
    .join(', ');
}

const TRACKER_HOST_PATTERNS = [
  /google-analytics\.com/,
  /googletagmanager\.com/,
  /facebook\.com\/tr/,
  /fbcdn\.net\/tr/,
  /doubleclick\.net/,
  /hotjar\.com/,
  /segment\.io/,
  /amplitude\.com/,
  /mixpanel\.com/,
  /clarity\.ms/,
  /criteo\.com/,
  /tiktok\.com\/pixel/,
  /snap\.licdn\.com/,
];

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export async function renderPage(input: RenderInput): Promise<RenderOutput> {
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? 60_000;
  const blockTrackers = input.blockTrackers ?? true;

  const browser: Browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  try {
    const context = await browser.newContext({
      userAgent: DEFAULT_USER_AGENT,
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      extraHTTPHeaders: {
        'accept-language': 'en-US,en;q=0.9',
        referer: 'https://www.google.com/',
      },
    });

    if (blockTrackers) {
      await context.route('**/*', (route) => {
        const url = route.request().url();
        if (TRACKER_HOST_PATTERNS.some((re) => re.test(url))) {
          return route.abort();
        }
        return route.continue();
      });
    }

    const page: Page = await context.newPage();
    await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // Wait pra a maior parte do JS rodar. `networkidle` é muito estrito
    // pra sites com trackers rodando pra sempre; `load` é mais confiável.
    await page.waitForLoadState('load', { timeout: timeoutMs / 2 }).catch(() => {
      // Silêncio: alguns sites nunca disparam 'load' completo, seguimos com o que temos.
    });

    // Scroll até bottom em passos pra disparar IntersectionObserver de lazy-load.
    await autoScroll(page);

    // Após scroll, aguarda 1s pra imagens lazy carregarem.
    await page.waitForTimeout(1500);

    // Coleta metadados + URLs de assets do DOM.
    // IMPORTANT: passamos como STRING literal (não function) porque esbuild/tsx
    // transforma arrow/function callbacks em declarações nomeadas usando helper
    // `__name` que não existe no browser Chromium. String literal skipa esbuild
    // completamente. Ver: https://github.com/privatenumber/tsx/issues/439
    const collected = await page.evaluate<{
      html: string;
      imageUrls: string[];
      stylesheetUrls: string[];
      fontUrls: string[];
      scriptUrls: string[];
      title: string;
      detectedLanguage: string | null;
      finalUrl: string;
    }>(PAGE_EVALUATE_SCRIPT);

    const bytes = Buffer.byteLength(collected.html, 'utf8');
    return {
      ...collected,
      bytes,
      latencyMs: Date.now() - started,
    };
  } finally {
    await browser.close();
  }
}

// Rola até o bottom em passos pra disparar lazy-load. Playwright melhor
// suporte: `.evaluate` roda um loop no browser, mais rápido que múltiplos
// scroll.into_view do Node.
async function autoScroll(page: Page): Promise<void> {
  // String literal (não function) — ver comentário do PAGE_EVALUATE_SCRIPT.
  await page.evaluate(AUTOSCROLL_SCRIPT);
}

// Script executado no browser via page.evaluate. STRING LITERAL pra escapar
// do esbuild/tsx que injeta helper `__name` em function/arrow declarations
// (que não existe no browser Chromium → crash com ReferenceError).
// Ver: https://github.com/privatenumber/tsx/issues/439
const AUTOSCROLL_SCRIPT = `
new Promise((resolve) => {
  var totalHeight = 0;
  var distance = 400;
  var timer = setInterval(function () {
    var scrollHeight = document.body.scrollHeight;
    window.scrollBy(0, distance);
    totalHeight += distance;
    if (totalHeight >= scrollHeight) {
      clearInterval(timer);
      window.scrollTo(0, 0);
      resolve();
    }
  }, 150);
});
`;

// Script principal de coleta de assets + reescrita de URLs relativas → absolutas.
// STRING LITERAL: ES5 puro pra rodar direto no browser sem transformação.
// Retorna o payload { html, imageUrls, stylesheetUrls, fontUrls, title, detectedLanguage, finalUrl }.
const PAGE_EVALUATE_SCRIPT = `
(function () {
  var imgs = new Set();
  document.querySelectorAll('img').forEach(function (el) {
    var src = el.currentSrc || el.src;
    if (src) imgs.add(src);
    var srcset = el.getAttribute('srcset');
    if (srcset) {
      srcset.split(',').forEach(function (entry) {
        var url = entry.trim().split(/\\s+/)[0];
        if (url) imgs.add(url);
      });
    }
  });
  document.querySelectorAll('source[srcset]').forEach(function (el) {
    var srcset = el.getAttribute('srcset');
    if (srcset) {
      srcset.split(',').forEach(function (entry) {
        var url = entry.trim().split(/\\s+/)[0];
        if (url) imgs.add(url);
      });
    }
  });

  document.querySelectorAll('[style*="background"]').forEach(function (el) {
    var bg = el.style.backgroundImage;
    var match = bg && bg.match(/url\\(["']?([^"')]+)["']?\\)/);
    if (match && match[1]) imgs.add(match[1]);
  });

  var stylesheets = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
    .map(function (el) { return el.href; })
    .filter(Boolean);

  var fonts = Array.from(document.querySelectorAll('link[as="font"], link[type*="font"]'))
    .map(function (el) { return el.href; })
    .filter(Boolean);

  // Scripts externos — preserva URLs de <script src> pra baixar e reescrever.
  // Filtragem final (trackers) acontece no sanitize downstream.
  var scripts = Array.from(document.querySelectorAll('script[src]'))
    .map(function (el) { return el.src; })
    .filter(Boolean);

  var detectedLang =
    document.documentElement.getAttribute('lang') ||
    (document.querySelector('meta[http-equiv="content-language"]') || {}).content ||
    null;

  var baseUrl = window.location.href;

  var absolutize = function (rel) {
    if (!rel) return rel;
    if (/^(https?:|data:|blob:|mailto:|tel:|#)/i.test(rel)) return rel;
    try {
      return new URL(rel, baseUrl).toString();
    } catch (e) {
      return rel;
    }
  };
  var absolutizeSrcset = function (srcset) {
    if (!srcset) return srcset;
    return srcset
      .split(',')
      .map(function (entry) {
        var parts = entry.trim().split(/\\s+/);
        var url = parts[0];
        var rest = parts.slice(1).join(' ');
        var abs = absolutize(url || null);
        return rest ? abs + ' ' + rest : abs;
      })
      .join(', ');
  };

  document.querySelectorAll('img').forEach(function (el) {
    var src = el.getAttribute('src');
    var abs = absolutize(src);
    if (abs && abs !== src) el.setAttribute('src', abs);
    var srcset = el.getAttribute('srcset');
    var absSrcset = absolutizeSrcset(srcset);
    if (absSrcset && absSrcset !== srcset) el.setAttribute('srcset', absSrcset);
  });
  document.querySelectorAll('source').forEach(function (el) {
    var src = el.getAttribute('src');
    var abs = absolutize(src);
    if (abs && abs !== src) el.setAttribute('src', abs);
    var srcset = el.getAttribute('srcset');
    var absSrcset = absolutizeSrcset(srcset);
    if (absSrcset && absSrcset !== srcset) el.setAttribute('srcset', absSrcset);
  });
  document.querySelectorAll('link[href]').forEach(function (el) {
    var href = el.getAttribute('href');
    var abs = absolutize(href);
    if (abs && abs !== href) el.setAttribute('href', abs);
  });
  document.querySelectorAll('script[src]').forEach(function (el) {
    var src = el.getAttribute('src');
    var abs = absolutize(src);
    if (abs && abs !== src) el.setAttribute('src', abs);
  });
  document.querySelectorAll('[style*="url("]').forEach(function (el) {
    var style = el.getAttribute('style');
    if (!style) return;
    var newStyle = style.replace(
      /url\\((["']?)([^"')]+)\\1\\)/gi,
      function (match, quote, u) {
        var abs = absolutize(u);
        return abs ? 'url(' + quote + abs + quote + ')' : match;
      }
    );
    if (newStyle !== style) el.setAttribute('style', newStyle);
  });

  document.querySelectorAll('[style*="url("]').forEach(function (el) {
    var style = el.getAttribute('style') || '';
    var re = /url\\((["']?)([^"')]+)\\1\\)/g;
    var m;
    while ((m = re.exec(style)) !== null) {
      var raw = m[2];
      if (raw && raw.indexOf('data:') !== 0) imgs.add(raw);
    }
  });
  document.querySelectorAll('link[href]').forEach(function (el) {
    var href = el.getAttribute('href') || '';
    var rel = el.getAttribute('rel') || '';
    var as = el.getAttribute('as') || '';
    if (
      /^https?:/i.test(href) &&
      (rel.indexOf('icon') !== -1 || (rel === 'preload' && as === 'image'))
    ) {
      imgs.add(href);
    }
  });

  return {
    html: document.documentElement.outerHTML,
    imageUrls: Array.from(imgs),
    stylesheetUrls: stylesheets,
    fontUrls: fonts,
    scriptUrls: scripts,
    title: document.title,
    detectedLanguage: detectedLang,
    finalUrl: baseUrl,
  };
})();
`;
