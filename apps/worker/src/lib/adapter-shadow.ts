// Fase 10.4 — Adapter shadow mode helper.
//
// Executa o Kaching Bundles Component Adapter em paralelo ao pipeline
// legado, EXCLUSIVAMENTE PARA TELEMETRIA. Não muta HTML. Não influencia
// render. Não substitui detectBundleCardsLegacy.
//
// Contrato:
//   - Feature flag LANDINGLAB_ADAPTER_SHADOW=true habilita.
//   - Quando OFF: função retorna null (caller trata como no-op).
//   - Quando ON: retorna log record estruturado (caller emite log).
//   - Erros do adapter são capturados e retornados como shadowError.
//     Nunca lança pra fora.
//
// HOTFIX (10.4): imports runtime de @blackshop/landinglab-adapters são
// DINÂMICOS (`await import()`) dentro do gate — assim o worker NUNCA
// tenta resolver o pacote quando a flag está OFF. Isso protege contra
// crash de startup se o package não estiver disponível no ambiente.
// Type-only imports permanecem estáticos (zero runtime cost).
//
// Ver: docs/architecture/adr-001-theme-adapter-contract.md §8 (shadow mode)

import { createHash } from 'node:crypto';
import type { CheerioAPI, Cheerio } from 'cheerio';
// TYPE-ONLY imports (compile-time only, sem impacto runtime):
import type {
  AdapterCandidate,
  DetectionResult,
  ExtractionResult,
  PageFamily,
} from '@blackshop/landinglab-adapters';
import {
  __resetAdapterRuntimeCache,
  loadAdapterRuntime,
} from './adapter-runtime.js';

/**
 * Env flag. Default OFF. Só true literal habilita — evita ativação
 * acidental por env não-string.
 */
export function isShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['LANDINGLAB_ADAPTER_SHADOW'] === 'true';
}

/**
 * Mapeia landing_pages.landing_kind (text) → PageFamily do adapter.
 * ADR-001 D2: sales_page | advertorial | pdp_derived | unknown.
 */
export function mapLandingKindToFamily(landingKind: string | null | undefined): PageFamily {
  if (landingKind === 'sales_page' || landingKind === null || landingKind === undefined) {
    return 'sales_page';
  }
  if (landingKind === 'advertorial') return 'advertorial';
  return 'unknown';
}

// ────────────────────────────────────────────────────────────────
// Fingerprint (ADR-001 §6 + A2)
// ────────────────────────────────────────────────────────────────

/**
 * Fingerprint estrutural determinístico do HTML de entrada.
 *
 * Reflete: tag counts, class counts (top-K), attribute markers relevantes
 * pra adapters de bundle, text length buckets.
 *
 * Ignora: text values, timestamps, IDs, ordem de atributos, whitespace.
 *
 * Objetivo (A2): distinguir "20 jobs da mesma Klensia" vs "20 clones
 * estruturalmente diferentes". Fingerprint estável entre re-clones do
 * mesmo layout; muda quando estrutura muda materialmente.
 */
export function computeAdapterInputFingerprint($: CheerioAPI): string {
  const tagCounts = new Map<string, number>();
  $('*').each((_, el) => {
    const anyEl = el as { tagName?: string; type?: string };
    if (anyEl.type !== 'tag') return;
    const tag = anyEl.tagName?.toLowerCase() ?? '';
    if (!tag) return;
    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  });

  const classCounts = new Map<string, number>();
  $('[class]').each((_, el) => {
    const clsAttr = ($(el).attr('class') ?? '').trim();
    if (!clsAttr) return;
    for (const cls of clsAttr.split(/\s+/)) {
      if (!cls) continue;
      classCounts.set(cls, (classCounts.get(cls) ?? 0) + 1);
    }
  });

  const attrMarkers: Record<string, number> = {
    'data-deal-bar-id': $('[data-deal-bar-id]').length,
    'data-cc-pdp-product-json': $('[data-cc-pdp-product-json]').length,
    'data-cc-pdp-offer': $('[data-cc-pdp-offer]').length,
    'data-landing-variant-id': $('[data-landing-variant-id]').length,
    'button-name-add': $('button[name="add"]').length,
    'form-action-cart': $('form[action*="/cart"]').length,
  };

  const totalTextLen = $('body').text().length;
  const textBucket = totalTextLen === 0 ? 0 : Math.floor(Math.log10(totalTextLen));

  const canonical = JSON.stringify({
    tags: [...tagCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    classes: [...classCounts.entries()]
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .slice(0, 40),
    attrs: Object.fromEntries(Object.entries(attrMarkers).sort()),
    textBucket,
  });

  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// ────────────────────────────────────────────────────────────────
// Legacy vs adapter comparison
// ────────────────────────────────────────────────────────────────

export interface LegacyBundleSample {
  count: number;
  identifiers: string[];
}

export function sampleLegacyBundles(
  $: CheerioAPI,
  cards: Cheerio<never>,
): LegacyBundleSample {
  const identifiers: string[] = [];
  cards.each((_, el) => {
    const id = ($(el).attr('data-deal-bar-id') ?? '').trim();
    if (id) identifiers.push(id);
  });
  return { count: cards.length, identifiers };
}

export interface AdapterBundleSample {
  count: number;
  identifiers: string[];
  regionSelector: string | null;
}

export function sampleAdapterBundles(extraction: ExtractionResult): AdapterBundleSample {
  const bundleRegion = extraction.regions.find((r) => r.kind === 'bundles');
  if (!bundleRegion || !bundleRegion.children) {
    return { count: 0, identifiers: [], regionSelector: null };
  }

  const identifiers: string[] = [];
  for (const child of bundleRegion.children) {
    const match = child.selector.match(/data-deal-bar-id="([^"]+)"/);
    if (match) identifiers.push(match[1]!);
  }
  return {
    count: bundleRegion.children.length,
    identifiers,
    regionSelector: bundleRegion.selector,
  };
}

export interface BundleComparison {
  legacyCount: number;
  adapterCount: number;
  countMatch: boolean;
  orderMatch: boolean;
  comparisonMatch: boolean;
  legacyIdentifiers: string[];
  adapterIdentifiers: string[];
  divergenceReason?: string;
}

export function compareBundles(
  legacy: LegacyBundleSample,
  adapter: AdapterBundleSample,
): BundleComparison {
  const countMatch = legacy.count === adapter.count;
  const bothHaveIds = legacy.identifiers.length > 0 && adapter.identifiers.length > 0;
  let orderMatch = false;
  if (bothHaveIds && legacy.identifiers.length === adapter.identifiers.length) {
    orderMatch = legacy.identifiers.every((id, i) => id === adapter.identifiers[i]);
  }

  const comparisonMatch = bothHaveIds
    ? countMatch && orderMatch
    : countMatch && legacy.count > 0;

  let divergenceReason: string | undefined;
  if (!countMatch) {
    divergenceReason = `count_diverged: legacy=${legacy.count} adapter=${adapter.count}`;
  } else if (bothHaveIds && !orderMatch) {
    divergenceReason = `order_diverged: legacy=[${legacy.identifiers.join(',')}] adapter=[${adapter.identifiers.join(',')}]`;
  } else if (!bothHaveIds && legacy.count > 0) {
    divergenceReason = 'identifiers_unavailable_for_verification';
  }

  return {
    legacyCount: legacy.count,
    adapterCount: adapter.count,
    countMatch,
    orderMatch,
    comparisonMatch,
    legacyIdentifiers: legacy.identifiers,
    adapterIdentifiers: adapter.identifiers,
    ...(divergenceReason ? { divergenceReason } : {}),
  };
}

// ────────────────────────────────────────────────────────────────
// Shadow orchestration
// ────────────────────────────────────────────────────────────────

export interface ShadowContext {
  html: string;
  $: CheerioAPI;
  landingPageId: string;
  landingKind: string | null | undefined;
  bundleAdapterHint: string | null | undefined;
  legacyCards: Cheerio<never>;
}

export interface ShadowLogRecord {
  mode: 'shadow';
  landingPageId: string;
  adapterId: string;
  adapterScope: 'bundle_component';
  pageFamily: PageFamily;
  adapterResolution: DetectionResult['resolution'];
  chosenAdapterId: string | null;
  candidates: Array<{ adapterId: string; score: number }>;
  overallConfidence: number | null;
  regionsFound: Array<{
    kind: string;
    selector: string;
    confidence: number;
    criticality: string;
  }>;
  unclassifiedCount: number;
  unclassifiedReasons: string[];
  adapterInputFingerprint: string;
  authority: 'legacy';
  fallbackReason?: string;
  comparison: BundleComparison | null;
  warnings: Array<{ severity: string; code: string; message: string }>;
  shadowError?: string;
  resolverReasons: string[];
  extractionEvidenceReasons: string[];
}

/** Test-only: reset compartilhado cache pra testar múltiplos cenários. */
export function __resetAdapterCache(): void {
  __resetAdapterRuntimeCache();
}

/**
 * Executa shadow mode. NUNCA lança. NUNCA muta HTML.
 * Retorna record estruturado pra caller emitir como log.
 *
 * ASYNC (hotfix 10.4): usa dynamic import do package de adapters
 * pra que a resolução de módulo só aconteça em runtime, sob a flag.
 */
export async function runAdapterShadow(ctx: ShadowContext): Promise<ShadowLogRecord> {
  const family = mapLandingKindToFamily(ctx.landingKind);
  const fingerprint = safelyComputeFingerprint(ctx.$);

  const baseRecord: ShadowLogRecord = {
    mode: 'shadow',
    landingPageId: ctx.landingPageId,
    adapterId: 'kaching',
    adapterScope: 'bundle_component',
    pageFamily: family,
    adapterResolution: 'no_match',
    chosenAdapterId: null,
    candidates: [],
    overallConfidence: null,
    regionsFound: [],
    unclassifiedCount: 0,
    unclassifiedReasons: [],
    adapterInputFingerprint: fingerprint,
    authority: 'legacy',
    comparison: null,
    warnings: [],
    resolverReasons: [],
    extractionEvidenceReasons: [],
  };

  const bundle = await loadAdapterRuntime();
  if (!bundle) {
    return {
      ...baseRecord,
      shadowError: `adapters_module_unavailable`,
      fallbackReason: 'adapters_module_unavailable',
    };
  }

  const legacySample = sampleLegacyBundles(ctx.$, ctx.legacyCards);

  let detection: DetectionResult;
  try {
    detection = bundle.mod.resolve(
      {
        html: ctx.html,
        hintedFamily: family,
        hintedAdapterId: ctx.bundleAdapterHint ?? undefined,
        landingPageId: ctx.landingPageId,
      },
      bundle.registry.list(),
    );
  } catch (err) {
    return {
      ...baseRecord,
      shadowError: `resolve threw: ${errorMessage(err)}`,
      fallbackReason: 'adapter_resolver_error',
      comparison: compareBundles(legacySample, { count: 0, identifiers: [], regionSelector: null }),
    };
  }

  const candidates = detection.candidates.map((c: AdapterCandidate) => ({
    adapterId: c.adapterId,
    score: c.score,
  }));
  const chosen = detection.chosen;

  if (!chosen) {
    return {
      ...baseRecord,
      adapterResolution: detection.resolution,
      candidates,
      resolverReasons: detection.reasons,
      fallbackReason:
        detection.resolution === 'ambiguous'
          ? 'ambiguous_candidates'
          : 'no_matching_adapter',
      comparison: compareBundles(legacySample, { count: 0, identifiers: [], regionSelector: null }),
    };
  }

  const adapter = bundle.registry.get(chosen.adapterId);
  if (!adapter) {
    return {
      ...baseRecord,
      adapterResolution: detection.resolution,
      candidates,
      resolverReasons: detection.reasons,
      shadowError: `adapter not in registry: ${chosen.adapterId}`,
      fallbackReason: 'adapter_missing_in_registry',
    };
  }

  let extraction: ExtractionResult;
  try {
    extraction = adapter.extract({
      html: ctx.html,
      hintedFamily: family,
      hintedAdapterId: ctx.bundleAdapterHint ?? undefined,
      landingPageId: ctx.landingPageId,
    });
  } catch (err) {
    return {
      ...baseRecord,
      adapterResolution: detection.resolution,
      chosenAdapterId: chosen.adapterId,
      candidates,
      resolverReasons: detection.reasons,
      shadowError: `extract threw: ${errorMessage(err)}`,
      fallbackReason: 'adapter_extract_error',
    };
  }

  const adapterSample = sampleAdapterBundles(extraction);
  const comparison = compareBundles(legacySample, adapterSample);

  return {
    ...baseRecord,
    adapterResolution: detection.resolution,
    chosenAdapterId: chosen.adapterId,
    candidates,
    resolverReasons: detection.reasons,
    overallConfidence: extraction.overallConfidence,
    regionsFound: extraction.regions.map((r) => ({
      kind: r.kind,
      selector: r.selector,
      confidence: r.confidence,
      criticality: r.criticality,
    })),
    unclassifiedCount: extraction.unclassified.length,
    unclassifiedReasons: extraction.unclassified.map((u) => u.reason),
    comparison,
    warnings: extraction.warnings.map((w) => ({
      severity: w.severity,
      code: w.code,
      message: w.message,
    })),
    extractionEvidenceReasons: extraction.regions.flatMap((r) => r.evidence.reasons),
  };
}

function safelyComputeFingerprint($: CheerioAPI): string {
  try {
    return computeAdapterInputFingerprint($);
  } catch {
    return 'fingerprint_error';
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
