// Build Chief — per-language orchestration of the 5 build agents.
//
// Story 13.6 AC15. Deterministic conductor. Zero LLM at this layer (the sole
// optional LLM call happens inside seo-optimizer via Claude Haiku).
//
// Flow per language:
//   1. selectTemplate(pir)                        → { templateName, reasoning }
//   2. composeSlots({ copyDeck, visual, tpl })    → TemplateSlots
//   3. buildHtml({ tpl, slots, language })        → { html, size_bytes }
//   4. generateSeoTags({ ... })                   → { headContent, seoScores }
//   5. Inject headContent into <head>             → htmlWithSeo
//   6. optimizePerformance({ html, visual })      → { html, optimizations }
//   7. Return html + audit trail (generation_notes ~ Article IV).

import type { Pir } from '@blackshop/landinglab-research';
import type { CopyDeck } from '@blackshop/landinglab-copy';
import type { VisualAssets } from '@blackshop/landinglab-visual';

import type { ClaudeHaikuClient } from '../providers/claude-haiku.js';
import type { TemplateName } from '../schema/build-output.js';

import type { BuildAgentTrace } from './types.js';
import { selectTemplate } from './template-selector.js';
import { composeSlots } from './content-composer.js';
import { buildHtml } from './html-builder.js';
import { planLayout } from './layout-planner.js';
import { generateSeoTags } from './seo-optimizer.js';
import { optimizePerformance } from './performance-optimizer.js';

export interface BuildChiefInput {
  pir: Pir;
  copyDeck: CopyDeck;
  visualAssets: VisualAssets;
  language: string;
  variantLangs: string[];
  parentSlug?: string;
  baseUrl?: string;
  haiku: ClaudeHaikuClient | null;
  /**
   * Fase 3: gallery block usa mediaUrls do Firecrawl scrape (AliExpress).
   * Se vazio, gallery é skipped pelo layout-planner.
   */
  mediaUrls?: string[];
  /** Fase 3: preço + moeda formatam sticky_cta price_hint. */
  priceDisplay?: string;
  /**
   * Fase 3: usar dynamic-blocks template (recomendado). Se false, cai no
   * template-selector antigo (short-form-direct/story-driven/long-form).
   * Default: true (nova arquitetura).
   */
  useDynamicBlocks?: boolean;
}

export interface BuildChiefOutput {
  html: string;
  template_used: TemplateName;
  generation_notes: string;
  cost_usd: number;
  trace: BuildAgentTrace[];
  /** Whether the SEO optimizer used the LLM path (true) or fallback (false). */
  seo_used_llm: boolean;
  /** SEO scores object (for build_metadata.seo_scores). */
  seo_scores: { meta_length: number; jsonld_present: boolean; hreflang_count: number };
  size_bytes: number;
}

/** Injects head content just after <head ...> opening tag (before other tags). */
function injectHead(html: string, headContent: string): string {
  // The html-builder places <!-- SEO_HEAD_PLACEHOLDER --> right after <head>.
  if (html.includes('<!-- SEO_HEAD_PLACEHOLDER -->')) {
    return html.replace('<!-- SEO_HEAD_PLACEHOLDER -->', headContent);
  }
  // After minification the comment is stripped — fall back to inserting right
  // after the opening <head> tag.
  return html.replace(/<head>/i, `<head>${headContent}`);
}

export async function runBuildChief(input: BuildChiefInput): Promise<BuildChiefOutput> {
  const { pir, copyDeck, visualAssets, language, variantLangs, parentSlug, baseUrl, haiku } = input;
  const useDynamic = input.useDynamicBlocks !== false;
  const trace: BuildAgentTrace[] = [];

  // ── 1. Template selection ─────────────────────────────────────────────
  const tStart1 = Date.now();
  // Fase 3: default = dynamic-blocks. Fallback pra template fixo se
  // useDynamicBlocks === false (retro-compat, testes).
  const templateName: TemplateName = useDynamic ? 'dynamic-blocks' : selectTemplate(pir).templateName;
  const selectorReasoning = useDynamic
    ? 'dynamic-blocks (Fase 3 default — layout-planner monta ordem por PIR)'
    : selectTemplate(pir).reasoning;
  trace.push({
    agent: 'template-selector',
    language,
    cost_usd: 0,
    latency_ms: Date.now() - tStart1,
    provider: 'none',
    notes: selectorReasoning,
  });

  // ── 2. Content composition ────────────────────────────────────────────
  const tStart2 = Date.now();
  const slots = composeSlots({ copyDeck, visualAssets, templateName, language });
  trace.push({
    agent: 'content-composer',
    language,
    cost_usd: 0,
    latency_ms: Date.now() - tStart2,
    provider: 'none',
  });

  // ── 2b. Layout planner (Fase 3) — só quando dynamic-blocks ativo ─────
  // Reescreve slots.body_sections com sequência arbitrária (planner regras
  // heurísticas) e adiciona sticky_cta. Zero LLM.
  if (useDynamic) {
    const tStartPlan = Date.now();
    const plan = planLayout({
      benefit_bullets: slots.body_sections
        .filter((s): s is Extract<typeof s, { kind: 'bullets' }> => s.kind === 'bullets')
        .flatMap((s) => s.items),
      faq: slots.body_sections
        .filter((s): s is Extract<typeof s, { kind: 'faq' }> => s.kind === 'faq')
        .flatMap((s) => s.items),
      top_pain_verbatim: copyDeck.voc_verbatim_used?.[0] ?? null,
      subheadlines: copyDeck.subheadlines,
      testimonials: slots.social_proof.testimonials_content,
      guarantee: copyDeck.guarantee ?? null,
      urgency: copyDeck.urgency_copy ?? null,
      before_after_urls: slots.social_proof.before_after_urls,
      media_urls: input.mediaUrls ?? [],
      pir,
      cta_primary_text: slots.ctas.primary.text,
      price_display: input.priceDisplay ?? null,
    });
    slots.body_sections = plan.body_sections;
    if (plan.sticky_cta) slots.sticky_cta = plan.sticky_cta;
    trace.push({
      agent: 'layout-planner',
      language,
      cost_usd: 0,
      latency_ms: Date.now() - tStartPlan,
      provider: 'none',
      notes: plan.reasoning,
    });
  }

  // ── 3. HTML build (React SSR + minify) ────────────────────────────────
  const tStart3 = Date.now();
  const built = await buildHtml({ templateName, slots, language });
  trace.push({
    agent: 'html-builder',
    language,
    cost_usd: 0,
    latency_ms: Date.now() - tStart3,
    provider: 'none',
    notes: `size_bytes=${built.size_bytes}`,
  });

  // ── 4. SEO tags ───────────────────────────────────────────────────────
  const seo = await generateSeoTags({
    pir,
    copyDeck,
    visualAssets,
    language,
    parentSlug,
    variantLangs,
    haiku,
    baseUrl,
  });
  trace.push({
    agent: 'seo-optimizer',
    language,
    cost_usd: seo.cost_usd,
    latency_ms: seo.latency_ms,
    provider: seo.usedLlm ? 'claude-haiku' : 'none',
    tokens_in: seo.tokens_in,
    tokens_out: seo.tokens_out,
    notes: `usedLlm=${seo.usedLlm} meta_length=${seo.seoScores.meta_length}`,
  });

  const htmlWithSeo = injectHead(built.html, seo.headContent);

  // ── 5. Performance transforms ─────────────────────────────────────────
  const tStart5 = Date.now();
  const perf = optimizePerformance({ html: htmlWithSeo, visualAssets });
  trace.push({
    agent: 'performance-optimizer',
    language,
    cost_usd: 0,
    latency_ms: Date.now() - tStart5,
    provider: 'none',
    notes: perf.optimizations.join(','),
  });

  // ── 6. Assemble generation_notes (Article IV audit trail) ─────────────
  const generation_notes = [
    `template=${templateName}`,
    `reason="${selectorReasoning}"`,
    `seoScores=${JSON.stringify(seo.seoScores)}`,
    `optimizations=${perf.optimizations.join(',')}`,
    `htmlSize=${Buffer.byteLength(perf.html, 'utf8')}`,
    `seoUsedLlm=${seo.usedLlm}`,
    `language=${language}`,
  ].join(' ');

  const cost_usd = trace.reduce((s, t) => s + (t.cost_usd ?? 0), 0);

  return {
    html: perf.html,
    template_used: templateName,
    generation_notes,
    cost_usd,
    trace,
    seo_used_llm: seo.usedLlm,
    seo_scores: seo.seoScores,
    size_bytes: Buffer.byteLength(perf.html, 'utf8'),
  };
}
