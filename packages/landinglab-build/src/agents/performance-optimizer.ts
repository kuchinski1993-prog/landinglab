// Performance Optimizer — string-manipulation HTML transforms.
//
// Story 13.6 AC14. Deterministic. Zero LLM. Uses regex + minimal string ops
// (NOT a full DOM parser) to keep the transform fast + zero-dep beyond stdlib.
//
// Transforms:
//   1. Preconnect: <link rel="preconnect"> for each unique image CDN domain
//   2. Hero image: fetchpriority=high + srcset (mobile 600w / og 1200w /
//      desktop 1920w) + sizes attribute
//   3. Other <img>: loading=lazy (if not already present)

import type { VisualAssets } from '@blackshop/landinglab-visual';

export interface PerformanceInput {
  html: string;
  visualAssets: VisualAssets;
}

export interface PerformanceOutput {
  html: string;
  optimizations: string[];
}

const HERO_SIZES = '(max-width: 640px) 375px, (max-width: 1200px) 1200px, 1920px';

/** Extracts unique origin (protocol+host) from a URL. Returns null on invalid. */
function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** Collects all image URLs in the visual bundle to derive CDN origins. */
function collectAllUrls(assets: VisualAssets): string[] {
  const urls: string[] = [];
  const h = assets.assets.hero.urls_by_size;
  urls.push(h.desktop, h.og, h.mobile);
  urls.push(...assets.assets.lifestyle);
  urls.push(...assets.assets.icons.map((i) => i.url));
  urls.push(...assets.assets.trust_badges);
  if (assets.assets.before_after) urls.push(...assets.assets.before_after);
  if (assets.assets.backgrounds) urls.push(...assets.assets.backgrounds);
  urls.push(assets.brand.logo_urls.full, assets.brand.logo_urls.mark, assets.brand.logo_urls.wordmark);
  return urls.filter((u): u is string => !!u);
}

export function optimizePerformance(input: PerformanceInput): PerformanceOutput {
  let html = input.html;
  const optimizations: string[] = [];

  // ─── 1. Preconnect for unique CDN origins ──────────────────────────────
  const origins = new Set<string>();
  for (const u of collectAllUrls(input.visualAssets)) {
    const o = originOf(u);
    if (o) origins.add(o);
  }
  if (origins.size > 0) {
    const preconnectTags = Array.from(origins)
      .map((o) => `<link rel="preconnect" href="${o}" crossorigin>`)
      .join('');
    // Insert just before </head> — safe location that survives minification.
    if (html.includes('</head>')) {
      html = html.replace('</head>', `${preconnectTags}</head>`);
      optimizations.push('preconnect');
    }
  }

  // ─── 2. Hero image: fetchpriority + srcset + sizes ─────────────────────
  const heroDesktop = input.visualAssets.assets.hero.urls_by_size.desktop;
  const heroOg = input.visualAssets.assets.hero.urls_by_size.og;
  const heroMobile = input.visualAssets.assets.hero.urls_by_size.mobile;

  // We identify the hero <img> by matching src equal to the desktop URL (chosen
  // by content-composer.ts as the primary hero image). Escape special regex chars.
  const heroSrc = heroDesktop || heroOg || heroMobile;
  if (heroSrc) {
    const escaped = heroSrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match <img ... src="heroSrc" ... > (self-closing or open) — permissive.
    const heroImgRe = new RegExp(`<img([^>]*?)src=["']${escaped}["']([^>]*?)/?>`, 'i');
    const srcset = [
      heroMobile ? `${heroMobile} 375w` : null,
      heroOg ? `${heroOg} 1200w` : null,
      heroDesktop ? `${heroDesktop} 1920w` : null,
    ]
      .filter(Boolean)
      .join(', ');

    html = html.replace(heroImgRe, (_match, pre: string, post: string) => {
      let attrs = `${pre}src="${heroSrc}"${post}`;
      // Remove any existing loading="lazy" for hero (bad for LCP).
      attrs = attrs.replace(/\sloading=["']lazy["']/gi, '');
      // Inject fetchpriority (React SSR emits fetchPriority — cover both).
      if (!/fetchpriority=/i.test(attrs) && !/fetchPriority=/.test(attrs)) {
        attrs += ' fetchpriority="high"';
      }
      // Inject srcset if not already present.
      if (srcset && !/srcset=/i.test(attrs) && !/srcSet=/.test(attrs)) {
        attrs += ` srcset="${srcset}"`;
      }
      if (!/\bsizes=/i.test(attrs)) {
        attrs += ` sizes="${HERO_SIZES}"`;
      }
      return `<img${attrs}>`;
    });
    optimizations.push('hero-fetchpriority', 'srcset');
  }

  // ─── 3. Lazy-load all other <img> without loading attr ─────────────────
  const heroImgMarkerSrc = heroSrc ?? '';
  html = html.replace(/<img([^>]*?)>/gi, (match, attrs: string) => {
    // Skip images that already have any loading attr.
    if (/\bloading=/i.test(attrs)) return match;
    // Skip the hero image itself.
    if (heroImgMarkerSrc && attrs.includes(heroImgMarkerSrc)) return match;
    return `<img${attrs} loading="lazy">`;
  });
  optimizations.push('lazy-loading');

  return { html, optimizations };
}
