// SEO Optimizer — meta_description via Claude Haiku (optional) + head tags.
//
// Story 13.6 AC13. LLM path is OPTIONAL — falls back to deterministic
// truncation of copyDeck.subheadlines[0] when the Haiku client returns null
// (missing key OR HTTP failure). Never throws.

import type { Pir } from '@blackshop/landinglab-research';
import type { CopyDeck } from '@blackshop/landinglab-copy';
import type { VisualAssets } from '@blackshop/landinglab-visual';

import type { ClaudeHaikuClient } from '../providers/claude-haiku.js';
import {
  SeoTagsSchema,
  type SeoTags,
  type SeoScores,
} from '../schema/build-output.js';

export interface SeoOptimizerInput {
  pir: Pir;
  copyDeck: CopyDeck;
  visualAssets: VisualAssets;
  language: string;
  parentSlug?: string;
  variantLangs: string[];
  haiku: ClaudeHaikuClient | null;
  /** Base URL used to compose canonical + hreflang alternates. */
  baseUrl?: string;
}

export interface SeoOptimizerOutput {
  /** String to inject between <head> and </head>. */
  headContent: string;
  seoScores: SeoScores;
  cost_usd: number;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  /** True if Haiku succeeded, false if fallback used. */
  usedLlm: boolean;
  /** Structured tags (for callers that want to persist/inspect). */
  tags: SeoTags;
}

const DEFAULT_BASE_URL = 'https://example.com';

/** Escapes HTML-attribute unsafe characters. Small helper — no dependency. */
function attr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + '…';
}

function ensureLength(text: string, min: number, max: number, seed: string): string {
  let out = text.trim();
  if (out.length > max) out = truncate(out, max);
  // Zod requires >= 50 chars on meta_description. Pad with brand tagline / seed
  // if the truncated content is too short.
  if (out.length < min) {
    const padded = `${out}${out.endsWith('.') ? '' : '.'} ${seed}`.trim();
    out = padded.slice(0, max);
  }
  // Guarantee minimum by repeating seed if still short (edge case: empty inputs).
  while (out.length < min) {
    out = `${out} ${seed}`.slice(0, max).trim();
    if (out === seed) break; // avoid infinite loop
  }
  return out;
}

export async function generateSeoTags(
  input: SeoOptimizerInput,
): Promise<SeoOptimizerOutput> {
  const started = Date.now();
  const {
    pir,
    copyDeck,
    visualAssets,
    language,
    parentSlug,
    variantLangs,
    haiku,
    baseUrl = DEFAULT_BASE_URL,
  } = input;

  const brand = visualAssets.brand;
  const hook = copyDeck.hooks[0]?.text ?? brand.tagline;
  const subhead = copyDeck.subheadlines[0] ?? brand.tagline;
  const heroImage =
    visualAssets.assets.hero.urls_by_size.og ||
    visualAssets.assets.hero.urls_by_size.desktop ||
    visualAssets.assets.hero.urls_by_size.mobile ||
    '';

  // ─── Meta description: LLM optional path ─────────────────────────────
  let metaDescription: string | null = null;
  let cost_usd = 0;
  let tokens_in = 0;
  let tokens_out = 0;
  let usedLlm = false;

  if (haiku) {
    const prompt =
      `Write a Google-safe SEO meta description in ${language} for a landing page selling "${pir.identity.name}".\n` +
      `Brand: ${brand.name}. Hook: "${hook}". Subhead: "${subhead}".\n` +
      `Hard rules: 120-155 chars. No emoji. No quotes. Include the brand name once. Active voice.`;
    try {
      const res = await haiku.generateMetaDescription(prompt);
      if (res && res.content) {
        metaDescription = res.content;
        cost_usd = res.cost_usd;
        tokens_in = res.tokens_in;
        tokens_out = res.tokens_out;
        usedLlm = true;
      }
    } catch {
      // Never propagate — deterministic fallback.
      metaDescription = null;
    }
  }

  if (!metaDescription) {
    // Fallback: subheadline truncated. Enforce Zod [50, 160].
    metaDescription = ensureLength(subhead, 50, 155, brand.tagline);
  } else {
    metaDescription = ensureLength(metaDescription, 50, 155, brand.tagline);
  }

  // ─── Title / canonical / hreflang ────────────────────────────────────
  const title = truncate(`${brand.name} — ${hook}`, 70);
  const slug = parentSlug ?? pir.identity.name.toLowerCase().replace(/\s+/g, '-');
  const canonicalUrl = `${baseUrl.replace(/\/$/, '')}/${slug}${language === 'en' ? '' : `-${language}`}`;

  const hreflang = variantLangs.map((lang) => ({
    lang,
    href: `${baseUrl.replace(/\/$/, '')}/${slug}${lang === 'en' ? '' : `-${lang}`}`,
  }));

  // ─── JSON-LD Product schema ──────────────────────────────────────────
  const jsonldProduct: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: pir.identity.name,
    description: metaDescription,
    image: heroImage,
    brand: { '@type': 'Brand', name: brand.name },
    offers: {
      '@type': 'Offer',
      price: pir.identity.price ?? undefined,
      priceCurrency: pir.identity.currency ?? 'USD',
      availability: 'https://schema.org/InStock',
    },
  };

  // ─── Structured tag object (validated via Zod for defense in depth) ──
  const tags: SeoTags = {
    meta_description: metaDescription,
    canonical_url: canonicalUrl,
    open_graph: {
      title,
      description: metaDescription,
      image: heroImage || `${baseUrl.replace(/\/$/, '')}/og-fallback.png`,
      type: 'product',
      locale: `${language}_${language.toUpperCase()}`,
    },
    twitter_card: {
      card: 'summary_large_image',
      title,
      description: metaDescription,
      image: heroImage || `${baseUrl.replace(/\/$/, '')}/og-fallback.png`,
    },
    hreflang,
    jsonld_product: jsonldProduct,
  };

  // Best-effort validation — if it fails we still return, but tags are already
  // clamped to Zod ranges by construction so this shouldn't fire in practice.
  const parsed = SeoTagsSchema.safeParse(tags);
  const finalTags: SeoTags = parsed.success ? parsed.data : tags;

  // ─── Compose head content string ─────────────────────────────────────
  const parts: string[] = [
    `<title>${attr(title)}</title>`,
    `<meta name="description" content="${attr(finalTags.meta_description)}">`,
    `<meta property="og:title" content="${attr(finalTags.open_graph.title)}">`,
    `<meta property="og:description" content="${attr(finalTags.open_graph.description)}">`,
    `<meta property="og:image" content="${attr(finalTags.open_graph.image)}">`,
    `<meta property="og:type" content="${attr(finalTags.open_graph.type)}">`,
    `<meta property="og:locale" content="${attr(finalTags.open_graph.locale)}">`,
    `<meta name="twitter:card" content="${attr(finalTags.twitter_card.card)}">`,
    `<meta name="twitter:title" content="${attr(finalTags.twitter_card.title)}">`,
    `<meta name="twitter:description" content="${attr(finalTags.twitter_card.description)}">`,
    `<meta name="twitter:image" content="${attr(finalTags.twitter_card.image)}">`,
  ];

  if (finalTags.canonical_url) {
    parts.push(`<link rel="canonical" href="${attr(finalTags.canonical_url)}">`);
  }
  for (const alt of finalTags.hreflang) {
    parts.push(`<link rel="alternate" hreflang="${attr(alt.lang)}" href="${attr(alt.href)}">`);
  }
  parts.push(
    `<script type="application/ld+json">${JSON.stringify(jsonldProduct).replace(/</g, '\\u003c')}</script>`,
  );

  const headContent = parts.join('');

  const seoScores: SeoScores = {
    meta_length: finalTags.meta_description.length,
    jsonld_present: true,
    hreflang_count: finalTags.hreflang.length,
  };

  return {
    headContent,
    seoScores,
    cost_usd,
    latency_ms: Date.now() - started,
    tokens_in,
    tokens_out,
    usedLlm,
    tags: finalTags,
  };
}
