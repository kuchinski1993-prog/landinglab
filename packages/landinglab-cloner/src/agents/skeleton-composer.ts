// skeleton-composer — SM-2.4
//
// Passo (e) do pipeline `POST /api/skeleton/create`: recebe `ExtractedSourceJson`
// + `BrandExtractResult` + skeleton alvo e retorna `ComposeResult` com os
// 12 slots fixos populados, até 3 slots dinâmicos com veredicto de aprovação,
// contagem de reviews IA gerados (se FR-10 disparou) e decisão de logo.
//
// Puro determinístico — a única chamada de rede é o Gemini text call quando
// `extracted.commerce.reviews.length === 0` (FR-10). Se reviews não é vazio,
// a função é síncrona no comportamento (async apenas por assinatura).
//
// Mapeamento §7 (12 slots fixos):
//   1  brand.logo          ← brand.logo_url                   (default: null; UI oferece regen)
//   2  brand.palette       ← brand.{primary,secondary,accent,bg,text} (default: paleta Bepurex)
//   3  brand.typography    ← brand.{headline_font, body_font}         (default: Playfair+Inter)
//   4  hero.headline       ← copyDeck.hero_headline ?? extracted.copy.hero_headline
//   5  hero.subhead        ← copyDeck.hero_subhead ?? extracted.copy.hero_subhead
//   6  hero.image_url      ← visualAssets.hero_url ?? extracted.imagery.hero_url ?? gallery[0]
//   7  benefit_bullets     ← copyDeck.benefit_bullets ?? extracted.copy.benefit_bullets
//   8  bundle_slots        ← extracted.commerce.bundles → BundleDisplaySlot (min 1 fallback)
//   9  testimonials        ← extracted.copy.testimonials
//  10  faq                 ← copyDeck.faq ?? extracted.copy.faq
//  11  guarantee           ← copyDeck.guarantee ?? extracted.copy.guarantee_text ?? i18n default
//  12  sticky_cta          ← auto: text=CTA primary, price_hint=cheapest bundle price
//
// Slots dinâmicos (§7 Nível 2.5): filtra por llm_verdict='recommended' first,
// limita a 3, ordena por posição de descoberta. approved=(verdict==='recommended').
//
// SM-5.5 absorvida: params opcionais `copyDeck?` e `visualAssets?` permitem
// enrichment pós-hoc (copy-chief re-audit, visual-director augmentation).
// Sem esses params, o comportamento é idêntico ao especificado em SM-2.4 puro.

// Import direto do `types.ts` — barrel exporta componentes .tsx que quebram
// o typecheck do cloner (sem jsx habilitado). Types são type-only, zero runtime.
import type {
  BepurexSlots,
  BodySection,
  BulletSlot,
  BundleDisplaySlot,
  CtaSlot,
  FaqSlot,
  TestimonialSlot,
} from '@blackshop/landinglab-render/templates/landinglab/types.js';

import { callGemini } from '../providers/gemini-text.js';

import type {
  BrandLike,
  ComposeInput,
  ComposeResult,
  CopyDeckOverride,
  DynamicExtraStatus,
  ExtractedBundle,
  ExtractedDynamicExtra,
  ExtractedSourceJson,
  LogoDecision,
  SkeletonLanguage,
  VisualAssetsOverride,
} from './skeleton-composer.types.js';

// Re-export public types pra caller conveniente.
export type {
  BrandLike,
  ComposeInput,
  ComposeResult,
  CopyDeckOverride,
  DynamicExtraStatus,
  ExtractedSourceJson,
  LogoDecision,
  SkeletonId,
  SkeletonLanguage,
  VisualAssetsOverride,
} from './skeleton-composer.types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** FR-11 default G2: threshold "imagens lifestyle insuficientes". Composer
 *  não gera imagens — apenas expõe o flag pra caller decidir se dispara
 *  visual-director. */
export const LIFESTYLE_MIN_THRESHOLD = 3;

/** Máximo de slots dinâmicos (Nível 2.5 — §7). */
export const MAX_DYNAMIC_EXTRAS = 3;

/** FR-10 default G3: 5 reviews IA quando fonte tem zero. */
export const AI_REVIEWS_COUNT = 5;

/** Paleta Bepurex default (§7 slot 2). Aplica quando brand vem com hex vazio. */
export const DEFAULT_PALETTE = {
  primary: '#8B4513',
  secondary: '#F5DEB3',
  accent: '#D2691E',
  bg: '#FFFFFF',
  text: '#333333',
} as const;

export const DEFAULT_TYPOGRAPHY = {
  headline_font: 'Playfair Display',
  body_font: 'Inter',
} as const;

/** Placeholder cinza pra hero (§7 slot 6). */
export const HERO_PLACEHOLDER_URL =
  'https://placehold.co/1600x900/e5e5e5/999999?text=Configure+hero+image';

/** i18n guarantee default (§7 slot 11) — cobre as 6 línguas de v1.2. */
const GUARANTEE_I18N: Record<SkeletonLanguage, string> = {
  en: '30-day money-back guarantee',
  de: '30 Tage Geld-zurück-Garantie',
  it: 'Garanzia di rimborso di 30 giorni',
  es: 'Garantía de devolución de 30 días',
  fr: 'Garantie de remboursement de 30 jours',
  'pt-BR': 'Garantia de devolução em 30 dias',
};

/** Fallback pra headline quando nenhum copy source produz nada. */
const HEADLINE_FALLBACK_I18N: Record<SkeletonLanguage, string> = {
  en: 'Configure your hero headline',
  de: 'Konfigurieren Sie Ihre Hero-Überschrift',
  it: 'Configura il titolo principale',
  es: 'Configura tu titular principal',
  fr: 'Configurez votre titre principal',
  'pt-BR': 'Configure a manchete do hero',
};

/** Fallback pra CTA quando nenhum copy source produz. */
const CTA_FALLBACK_I18N: Record<SkeletonLanguage, string> = {
  en: 'Order now',
  de: 'Jetzt bestellen',
  it: 'Ordina ora',
  es: 'Pide ahora',
  fr: 'Commander maintenant',
  'pt-BR': 'Comprar agora',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function nonEmptyString(v: string | undefined | null): string | undefined {
  if (!v) return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Retorna a hex se não-vazia e válida-ish (#RRGGBB ou #RGB), senão fallback. */
function hexOrFallback(hex: string | undefined | null, fallback: string): string {
  if (!hex) return fallback;
  const trimmed = hex.trim();
  if (!/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(trimmed)) return fallback;
  return trimmed;
}

function formatPriceEuros(cents: number, currency: string | null): string {
  const value = (cents / 100).toFixed(2);
  const cur = currency ?? 'EUR';
  return `${cur} ${value.replace('.', ',')}`;
}

// ─── Brand slot (§7 slots 1-3) ──────────────────────────────────────────────

function composeBrandSlot(
  brand: BrandLike,
  extracted: ExtractedSourceJson,
): { brandSlot: BepurexSlots['brand']; logoDecision: LogoDecision } {
  const logoUrl = brand.logo_url ?? extracted.imagery.logo_url ?? null;
  const logoSource: LogoDecision['source'] = logoUrl ? 'extracted_from_fonte' : 'none';

  const brandSlot: BepurexSlots['brand'] = {
    // Composer não recebe brand name — deriva de metadados do produto ou fica em branco.
    // Caller (`POST /api/skeleton/create`) preenche `landing_pages.title` de outra fonte.
    name: '',
    tagline: nonEmptyString(extracted.copy.hero_subhead) ?? '',
    logo_url: logoUrl ?? '',
    palette: {
      primary: hexOrFallback(brand.primary, DEFAULT_PALETTE.primary),
      secondary: hexOrFallback(brand.secondary, DEFAULT_PALETTE.secondary),
      accent: hexOrFallback(brand.accent, DEFAULT_PALETTE.accent),
      bg: hexOrFallback(brand.bg, DEFAULT_PALETTE.bg),
      text: hexOrFallback(brand.text, DEFAULT_PALETTE.text),
    },
    typography: {
      headline_font: nonEmptyString(brand.headline_font) ?? DEFAULT_TYPOGRAPHY.headline_font,
      body_font: nonEmptyString(brand.body_font) ?? DEFAULT_TYPOGRAPHY.body_font,
    },
  };

  return {
    brandSlot,
    logoDecision: { used_logo_url: logoUrl, source: logoSource },
  };
}

// ─── Hero slot (§7 slots 4-6) ───────────────────────────────────────────────

function composeHeroSlot(
  extracted: ExtractedSourceJson,
  copyDeck: CopyDeckOverride | undefined,
  visualAssets: VisualAssetsOverride | undefined,
  language: SkeletonLanguage,
  ctaPrimary: CtaSlot,
): BepurexSlots['hero'] {
  const headline =
    nonEmptyString(copyDeck?.hero_headline) ??
    nonEmptyString(extracted.copy.hero_headline) ??
    HEADLINE_FALLBACK_I18N[language];

  const subhead =
    nonEmptyString(copyDeck?.hero_subhead) ??
    nonEmptyString(extracted.copy.hero_subhead) ??
    '';

  const heroUrl =
    nonEmptyString(visualAssets?.hero_url) ??
    nonEmptyString(extracted.imagery.hero_url) ??
    extracted.imagery.gallery_urls.find((u) => nonEmptyString(u)) ??
    HERO_PLACEHOLDER_URL;

  const hero: BepurexSlots['hero'] = {
    headline,
    subhead,
    image_url: heroUrl,
    cta_primary: ctaPrimary,
  };

  if (visualAssets?.hero_srcset) {
    hero.image_srcset = visualAssets.hero_srcset;
  }

  return hero;
}

// ─── CTAs (§7 slot 12 — sticky_cta derivado) ────────────────────────────────

function composeCtaPrimary(
  extracted: ExtractedSourceJson,
  copyDeck: CopyDeckOverride | undefined,
  language: SkeletonLanguage,
): CtaSlot {
  const text =
    nonEmptyString(copyDeck?.cta_primary_text) ??
    nonEmptyString(extracted.commerce.badges[0]) ??
    CTA_FALLBACK_I18N[language];
  return { text, variant: 'a', urgency_type: 'time_limited' };
}

function composeStickyCta(
  ctaPrimary: CtaSlot,
  bundles: ExtractedBundle[],
  currency: string | null,
): BepurexSlots['sticky_cta'] {
  const cheapest = bundles
    .filter((b) => Number.isFinite(b.price_cents) && b.price_cents > 0)
    .sort((a, b) => a.price_cents - b.price_cents)[0];
  const sticky: NonNullable<BepurexSlots['sticky_cta']> = {
    text: ctaPrimary.text,
  };
  if (cheapest) sticky.price_hint = formatPriceEuros(cheapest.price_cents, currency);
  return sticky;
}

// ─── Bundles (§7 slot 8) ────────────────────────────────────────────────────

function composeBundleSlots(
  extracted: ExtractedSourceJson,
): BundleDisplaySlot[] {
  const { bundles } = extracted.commerce;
  if (bundles.length === 0) {
    // Fallback: single "1 unit / preço extraído" — se nem preço temos, 0 cents.
    return [
      {
        name: '1 unit',
        priceCents: 0,
        compareAtPriceCents: null,
        quantityUnits: 1,
        highlight: null,
      },
    ];
  }

  // Ordena por preço; middle = 'popular'; maior compareAt savings = 'best'.
  const sortedByPrice = [...bundles].sort((a, b) => a.price_cents - b.price_cents);

  const slots: BundleDisplaySlot[] = sortedByPrice.map((b) => ({
    name: b.name,
    priceCents: b.price_cents,
    compareAtPriceCents: b.compare_at_cents ?? null,
    quantityUnits: b.qty,
    highlight: null,
  }));

  // Highlight 'popular' = bundle do meio (se ≥ 3).
  if (slots.length >= 3) {
    const middleIdx = Math.floor(slots.length / 2);
    const middle = slots[middleIdx];
    if (middle) middle.highlight = 'popular';
  }

  // Highlight 'best' = maior desconto absoluto (compareAt - price).
  let bestIdx = -1;
  let bestSavings = 0;
  slots.forEach((s, i) => {
    if (s.compareAtPriceCents == null) return;
    const savings = s.compareAtPriceCents - s.priceCents;
    if (savings > bestSavings) {
      bestSavings = savings;
      bestIdx = i;
    }
  });
  if (bestIdx >= 0) {
    const bestSlot = slots[bestIdx];
    // Não sobrescreve 'popular' — se coincidem, 'best' ganha (maior desconto).
    if (bestSlot) bestSlot.highlight = 'best';
  }

  return slots;
}

// ─── Body sections (§7 slots 7, 9-11) ───────────────────────────────────────

function composeBodySections(
  extracted: ExtractedSourceJson,
  copyDeck: CopyDeckOverride | undefined,
  language: SkeletonLanguage,
  reviews: TestimonialSlot[],
): BodySection[] {
  const sections: BodySection[] = [];

  // Slot 7: benefit_bullets
  const bullets =
    (copyDeck?.benefit_bullets && copyDeck.benefit_bullets.length > 0
      ? copyDeck.benefit_bullets
      : extracted.copy.benefit_bullets) ?? [];
  if (bullets.length > 0) {
    sections.push({
      kind: 'bullets',
      heading: 'What you get',
      items: bullets.map<BulletSlot>((text) => ({ text })),
    });
  }

  // Slot 9: testimonials (usa reviews compostos — extracted OR IA-generated)
  if (reviews.length > 0) {
    sections.push({
      kind: 'testimonials',
      heading: 'What customers say',
      items: reviews,
    });
  }

  // Slot 10: faq
  const faqSource =
    copyDeck?.faq && copyDeck.faq.length > 0 ? copyDeck.faq : extracted.copy.faq;
  if (faqSource.length > 0) {
    const items: FaqSlot[] = faqSource.map((f) => ({ question: f.q, answer: f.a }));
    sections.push({
      kind: 'faq',
      heading: 'Frequently asked',
      items,
    });
  }

  // Slot 11: guarantee (sempre presente com i18n fallback — §7)
  const guaranteeBody =
    nonEmptyString(copyDeck?.guarantee) ??
    nonEmptyString(extracted.copy.guarantee_text) ??
    GUARANTEE_I18N[language];
  sections.push({
    kind: 'guarantee',
    heading: 'Our guarantee',
    body: guaranteeBody,
  });

  // Urgency (opcional — só se copy source produz)
  const urgencyBody =
    nonEmptyString(copyDeck?.urgency) ?? nonEmptyString(extracted.copy.urgency_text);
  if (urgencyBody) {
    sections.push({ kind: 'urgency', heading: 'Act now', body: urgencyBody });
  }

  return sections;
}

// ─── Dynamic extras (§7 Nível 2.5) ──────────────────────────────────────────

/** Constrói uma BodySection tipada a partir de um `ExtractedDynamicExtra`.
 *  Retorna null se o payload não bate com o kind esperado (safe fallback).
 *  Composer ignora o extra em vez de crashar. */
function buildDynamicSection(extra: ExtractedDynamicExtra): BodySection | null {
  const payload = extra.payload as Record<string, unknown> | null | undefined;
  switch (extra.kind) {
    case 'bullets': {
      const items = Array.isArray(payload?.['items']) ? (payload['items'] as unknown[]) : [];
      const bulletItems: BulletSlot[] = items
        .map((i) => {
          if (typeof i === 'string') return { text: i };
          if (i && typeof i === 'object' && 'text' in i && typeof (i as { text: unknown }).text === 'string') {
            return { text: (i as { text: string }).text };
          }
          return null;
        })
        .filter((x): x is BulletSlot => x !== null);
      if (bulletItems.length === 0) return null;
      return { kind: 'bullets', heading: extra.heading, items: bulletItems };
    }
    case 'story': {
      const paragraphs = Array.isArray(payload?.['paragraphs'])
        ? (payload['paragraphs'] as unknown[]).filter((p): p is string => typeof p === 'string')
        : [];
      if (paragraphs.length === 0) return null;
      const image_url = typeof payload?.['image_url'] === 'string' ? (payload['image_url'] as string) : undefined;
      return image_url
        ? { kind: 'story', heading: extra.heading, paragraphs, image_url }
        : { kind: 'story', heading: extra.heading, paragraphs };
    }
    case 'stats': {
      const items = Array.isArray(payload?.['items']) ? (payload['items'] as unknown[]) : [];
      const statItems = items
        .map((i) => {
          if (i && typeof i === 'object' && 'label' in i && 'value' in i) {
            const rec = i as { label: unknown; value: unknown };
            if (typeof rec.label === 'string' && typeof rec.value === 'string') {
              return { label: rec.label, value: rec.value };
            }
          }
          return null;
        })
        .filter((x): x is { label: string; value: string } => x !== null);
      if (statItems.length === 0) return null;
      return { kind: 'stats', heading: extra.heading, items: statItems };
    }
    case 'gallery': {
      const urls = Array.isArray(payload?.['image_urls'])
        ? (payload['image_urls'] as unknown[]).filter((u): u is string => typeof u === 'string')
        : [];
      if (urls.length === 0) return null;
      return { kind: 'gallery', heading: extra.heading, image_urls: urls };
    }
    case 'problem_agitation': {
      const paragraphs = Array.isArray(payload?.['paragraphs'])
        ? (payload['paragraphs'] as unknown[]).filter((p): p is string => typeof p === 'string')
        : [];
      if (paragraphs.length === 0) return null;
      return { kind: 'problem_agitation', heading: extra.heading, paragraphs };
    }
    case 'solution_benefits': {
      const benefits = Array.isArray(payload?.['benefits']) ? (payload['benefits'] as unknown[]) : [];
      const benefitItems: BulletSlot[] = benefits
        .map((b) => {
          if (typeof b === 'string') return { text: b };
          if (b && typeof b === 'object' && 'text' in b && typeof (b as { text: unknown }).text === 'string') {
            return { text: (b as { text: string }).text };
          }
          return null;
        })
        .filter((x): x is BulletSlot => x !== null);
      if (benefitItems.length === 0) return null;
      return { kind: 'solution_benefits', heading: extra.heading, benefits: benefitItems };
    }
    case 'before_after': {
      const before = payload?.['before'];
      const after = payload?.['after'];
      if (
        before &&
        after &&
        typeof before === 'object' &&
        typeof after === 'object' &&
        'image_url' in before &&
        'label' in before &&
        'image_url' in after &&
        'label' in after &&
        typeof (before as { image_url: unknown }).image_url === 'string' &&
        typeof (before as { label: unknown }).label === 'string' &&
        typeof (after as { image_url: unknown }).image_url === 'string' &&
        typeof (after as { label: unknown }).label === 'string'
      ) {
        return {
          kind: 'before_after',
          heading: extra.heading,
          before: {
            image_url: (before as { image_url: string }).image_url,
            label: (before as { label: string }).label,
          },
          after: {
            image_url: (after as { image_url: string }).image_url,
            label: (after as { label: string }).label,
          },
        };
      }
      return null;
    }
    case 'comparison': {
      const rows = Array.isArray(payload?.['rows']) ? (payload['rows'] as unknown[]) : [];
      const compRows = rows
        .map((r) => {
          if (r && typeof r === 'object' && 'feature' in r && 'ours' in r && 'theirs' in r) {
            const rec = r as { feature: unknown; ours: unknown; theirs: unknown };
            if (
              typeof rec.feature === 'string' &&
              typeof rec.ours === 'string' &&
              typeof rec.theirs === 'string'
            ) {
              return { feature: rec.feature, ours: rec.ours, theirs: rec.theirs };
            }
          }
          return null;
        })
        .filter((x): x is { feature: string; ours: string; theirs: string } => x !== null);
      if (compRows.length === 0) return null;
      return { kind: 'comparison', heading: extra.heading, rows: compRows };
    }
    default:
      return null;
  }
}

function composeDynamicExtras(
  extracted: ExtractedSourceJson,
): { extras: BodySection[]; status: DynamicExtraStatus[] } {
  // Filtra fora skip; recommended primeiro, depois optional; limita a 3.
  const eligible = extracted.dynamic_extras.filter((e) => e.llm_verdict !== 'skip');
  const recommended = eligible.filter((e) => e.llm_verdict === 'recommended');
  const optional = eligible.filter((e) => e.llm_verdict === 'optional');
  const ordered = [...recommended, ...optional].slice(0, MAX_DYNAMIC_EXTRAS);

  const extras: BodySection[] = [];
  const status: DynamicExtraStatus[] = [];

  ordered.forEach((extra, idx) => {
    const section = buildDynamicSection(extra);
    if (!section) return;
    const slot_index = idx as 0 | 1 | 2;
    extras.push(section);
    status.push({
      kind: section.kind,
      heading: extra.heading,
      slot_index,
      llm_verdict: extra.llm_verdict,
      approved: extra.llm_verdict === 'recommended',
    });
  });

  return { extras, status };
}

// ─── Reviews IA (FR-10) ─────────────────────────────────────────────────────

interface AIReview {
  content: string;
  source: string;
}

/** Prompt tuned pra output JSON estável: 5 reviews, cada um com content
 *  (2-3 sentenças, sem hype, sem promessas médicas) e source (nome + inicial
 *  do sobrenome, sem cidade/país pra evitar viés). */
function buildReviewsPrompt(
  productName: string,
  language: SkeletonLanguage,
): { system: string; user: string } {
  const langLabel: Record<SkeletonLanguage, string> = {
    en: 'English',
    de: 'German (Deutsch)',
    it: 'Italian (Italiano)',
    es: 'Spanish (Español)',
    fr: 'French (Français)',
    'pt-BR': 'Brazilian Portuguese (Português do Brasil)',
  };

  const system = [
    'You generate realistic customer reviews for e-commerce products.',
    'Rules:',
    '- Output a JSON object: { "reviews": [ { "content": string, "source": string }, ... ] }.',
    `- Exactly ${AI_REVIEWS_COUNT} reviews, no more, no less.`,
    `- Write in ${langLabel[language]}.`,
    '- Each content: 2 to 3 sentences, first-person, conversational, no marketing hype.',
    '- No medical claims (no "cures", no "heals", no clinical percentages).',
    '- Vary tone across reviews (skeptical-then-convinced, enthusiastic, matter-of-fact, cautious).',
    '- Source: first name + last-initial only (e.g. "Marco B.", "Anna T.").',
    '- Do NOT mention shipping, discounts, or price.',
    '- Do NOT wrap in markdown or code fences. Only JSON.',
  ].join('\n');

  const user = `Product: ${productName}\n\nGenerate ${AI_REVIEWS_COUNT} customer reviews.`;

  return { system, user };
}

interface GenerateReviewsDeps {
  /** Injectable pra testes — default é o `callGemini` real. */
  callGeminiFn?: typeof callGemini;
}

async function generateAIReviews(
  productName: string,
  language: SkeletonLanguage,
  deps: GenerateReviewsDeps = {},
): Promise<TestimonialSlot[]> {
  const geminiFn = deps.callGeminiFn ?? callGemini;
  const { system, user } = buildReviewsPrompt(productName, language);

  try {
    const result = await geminiFn({
      system,
      user,
      // FR-10: task criativa leve — Flash é suficiente (menor custo).
      model: 'gemini-3.6-flash',
      temperature: 0.8,
      maxTokens: 1200,
      jsonMode: true,
    });

    const parsed = parseReviewsResponse(result.content);
    if (parsed.length === 0) return [];
    // Trim ao count exato — modelo às vezes retorna 4 ou 6.
    return parsed.slice(0, AI_REVIEWS_COUNT).map<TestimonialSlot>((r) => ({
      content: r.content,
      source: r.source,
    }));
  } catch {
    // Falha silenciosa (retry+backoff já rolou no gemini-text). Composer
    // devolve zero reviews IA — caller marca como partial.
    return [];
  }
}

function parseReviewsResponse(raw: string): AIReview[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const reviewsField = (parsed as { reviews?: unknown })?.reviews;
  if (!Array.isArray(reviewsField)) return [];

  const clean: AIReview[] = [];
  for (const r of reviewsField) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as { content?: unknown; source?: unknown };
    if (typeof rec.content !== 'string' || typeof rec.source !== 'string') continue;
    const content = rec.content.trim();
    const source = rec.source.trim();
    if (!content || !source) continue;
    clean.push({ content, source });
  }
  return clean;
}

// ─── Reviews composition (mescla extracted + IA quando needed) ──────────────

function extractedReviewsToTestimonials(
  extracted: ExtractedSourceJson,
): TestimonialSlot[] {
  const fromCommerce = extracted.commerce.reviews.map<TestimonialSlot>((r) => ({
    content: r.content,
    source: r.author,
  }));
  const fromCopy = extracted.copy.testimonials.map<TestimonialSlot>((t) => ({
    content: t.content,
    source: t.author,
  }));
  return [...fromCommerce, ...fromCopy];
}

// ─── Trust badges (visual) ──────────────────────────────────────────────────

function composeTrustBadges(
  extracted: ExtractedSourceJson,
  visualAssets: VisualAssetsOverride | undefined,
): Array<{ url: string; alt: string }> {
  const urls = visualAssets?.trust_badge_urls ?? [];
  if (urls.length > 0) {
    return urls.map((url, i) => ({ url, alt: `Trust badge ${i + 1}` }));
  }
  // Fallback: badges de texto do commerce viram alt sem URL — templates ignoram
  // items sem URL válida. Retorna vazio quando não há assets visuais.
  return extracted.commerce.badges.length > 0 && urls.length > 0
    ? extracted.commerce.badges.map((alt, i) => ({ url: urls[i] ?? '', alt }))
    : [];
}

// ─── Offer stack (§7 slot 11 relacionado + slot 8) ──────────────────────────

function composeOfferStack(
  extracted: ExtractedSourceJson,
  language: SkeletonLanguage,
  copyDeck: CopyDeckOverride | undefined,
): BepurexSlots['offer_stack'] {
  const cheapest = [...extracted.commerce.bundles]
    .filter((b) => Number.isFinite(b.price_cents) && b.price_cents > 0)
    .sort((a, b) => a.price_cents - b.price_cents)[0];
  const best = [...extracted.commerce.bundles]
    .filter((b) => Number.isFinite(b.price_cents) && b.price_cents > 0)
    .sort((a, b) => b.price_cents - a.price_cents)[0];

  const currency = extracted.commerce.currency;
  const actual_price = cheapest ? formatPriceEuros(cheapest.price_cents, currency) : '';
  const total_value =
    best?.compare_at_cents !== undefined
      ? formatPriceEuros(best.compare_at_cents, currency)
      : actual_price;
  const savings =
    best?.compare_at_cents !== undefined && cheapest
      ? formatPriceEuros(best.compare_at_cents - cheapest.price_cents, currency)
      : '';

  return {
    core: cheapest?.name ?? '',
    bonuses: [],
    total_value,
    actual_price,
    savings,
    guarantee:
      nonEmptyString(copyDeck?.guarantee) ??
      nonEmptyString(extracted.copy.guarantee_text) ??
      GUARANTEE_I18N[language],
  };
}

// ─── Social proof (§7 slot 9 aggregate) ─────────────────────────────────────

function composeSocialProof(
  reviews: TestimonialSlot[],
  visualAssets: VisualAssetsOverride | undefined,
): BepurexSlots['social_proof'] {
  return {
    testimonials_content: reviews,
    badges_urls: visualAssets?.trust_badge_urls ?? [],
    before_after_urls: visualAssets?.before_after_urls ?? [],
  };
}

// ─── Gallery visual assets → BodySection quando enrichment traz extras ──────

function maybePushGallerySection(
  sections: BodySection[],
  extracted: ExtractedSourceJson,
  visualAssets: VisualAssetsOverride | undefined,
): void {
  const combined = [
    ...extracted.imagery.gallery_urls,
    ...(visualAssets?.extra_gallery_urls ?? []),
  ].filter((u) => nonEmptyString(u));
  if (combined.length === 0) return;
  sections.push({ kind: 'gallery', heading: 'Gallery', image_urls: combined });
}

// ─── Main entry ─────────────────────────────────────────────────────────────

/** Compõe `BepurexSlots` a partir de extração + brand + enrichment opcional.
 *
 *  Assinatura async apenas por causa da chamada Gemini pra reviews IA (FR-10)
 *  — quando `extracted.commerce.reviews.length > 0` E `copy.testimonials.length > 0`,
 *  nenhuma chamada de rede é feita. */
export async function composeBepurexSlots(
  input: ComposeInput,
  deps: GenerateReviewsDeps = {},
): Promise<ComposeResult> {
  const { extracted, brand, targetSkeleton, language, productName, copyDeck, visualAssets } = input;

  // ─── Brand (slots 1-3) ───────────────────────────────────────────────
  const { brandSlot, logoDecision } = composeBrandSlot(brand, extracted);

  // ─── CTA primary (usado por hero + sticky) ───────────────────────────
  const ctaPrimary = composeCtaPrimary(extracted, copyDeck, language);

  // ─── Reviews (FR-10: IA fallback se fonte tem zero) ─────────────────
  const extractedReviews = extractedReviewsToTestimonials(extracted);
  let aiGeneratedReviewsCount = 0;
  let reviews: TestimonialSlot[] = extractedReviews;

  if (extractedReviews.length === 0) {
    const productLabel =
      nonEmptyString(productName) ??
      nonEmptyString(extracted.copy.hero_headline) ??
      'this product';
    const aiReviews = await generateAIReviews(productLabel, language, deps);
    aiGeneratedReviewsCount = aiReviews.length;
    reviews = aiReviews;
  }

  // ─── Hero (slots 4-6) ────────────────────────────────────────────────
  const hero = composeHeroSlot(extracted, copyDeck, visualAssets, language, ctaPrimary);

  // ─── Body sections (slots 7, 9-11) ───────────────────────────────────
  const bodySections = composeBodySections(extracted, copyDeck, language, reviews);
  // Gallery secundário (não-hero) quando enrichment agrega imagens.
  maybePushGallerySection(bodySections, extracted, visualAssets);

  // ─── Dynamic extras (Nível 2.5) ──────────────────────────────────────
  const { extras: dynamic_extras, status: dynamicExtrasStatus } = composeDynamicExtras(extracted);

  // ─── Bundles (slot 8) ────────────────────────────────────────────────
  const bundle_slots = composeBundleSlots(extracted);

  // ─── Sticky CTA (slot 12) ────────────────────────────────────────────
  const sticky_cta = composeStickyCta(ctaPrimary, extracted.commerce.bundles, extracted.commerce.currency);

  // ─── Offer stack ─────────────────────────────────────────────────────
  const offer_stack = composeOfferStack(extracted, language, copyDeck);

  // ─── Trust badges + social proof ─────────────────────────────────────
  const trust_badges = composeTrustBadges(extracted, visualAssets);
  const social_proof = composeSocialProof(reviews, visualAssets);

  // ─── Timeline / doctors_endorsement (opcionais, específicos landing) ─
  // Ambos são exclusivos do `bepurex-landing-v1`. Sem input direto do
  // extractor pra estes por enquanto (composers futuros podem popular).
  // No skeleton advertorial, ficam undefined intencionalmente.
  //
  // TODO(SM-2.1+): quando extractor detectar timeline/doctors semanticamente,
  // popular estes slots com dados reais. Por ora, undefined = template usa
  // seus defaults (§5.4).
  const timelineAndDoctors: Partial<Pick<BepurexSlots, 'timeline' | 'doctors_endorsement'>> = {};
  void targetSkeleton; // Reservado pra branching futuro (per-skeleton logic)

  const slots: BepurexSlots = {
    language,
    brand: brandSlot,
    hero,
    body_sections: bodySections,
    dynamic_extras,
    offer_stack,
    ctas: { primary: ctaPrimary },
    trust_badges,
    social_proof,
    sticky_cta,
    bundle_slots,
    ...timelineAndDoctors,
  };

  return {
    slots,
    dynamicExtrasStatus,
    aiGeneratedReviewsCount,
    logoDecision,
  };
}
