// Fase 11.4 — Semantic mapper shadow.
//
// Runtime shadow do semantic-mapper. Feature flag LANDINGLAB_SEMANTIC_SHADOW.
// Zero HTML mutation. Zero autoridade. Log-only.
//
// Como adapter-shadow (10.4): dynamic import do package pra proteção contra
// module unavailable.

import { performance } from 'node:perf_hooks';
import type { CheerioAPI } from 'cheerio';
import type {
  PageFamily,
  PageSemanticModel,
} from '@blackshop/landinglab-adapters';
import { loadAdapterRuntime } from './adapter-runtime.js';

export function isSemanticShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['LANDINGLAB_SEMANTIC_SHADOW'] === 'true';
}

/**
 * Mapeia landingKind → PageFamily. Espelho do mapLandingKindToFamily do
 * adapter-shadow (mantido inline pra evitar cross-lib coupling extra).
 */
function toFamily(landingKind: string | null | undefined): PageFamily {
  if (landingKind === 'sales_page' || landingKind === null || landingKind === undefined) {
    return 'sales_page';
  }
  if (landingKind === 'advertorial') return 'advertorial';
  if (landingKind === 'pdp_derived') return 'pdp_derived';
  return 'unknown';
}

export interface SemanticShadowContext {
  html: string;
  $: CheerioAPI; // presente pra type consistency com adapter-shadow; NÃO usado (mapper carrega o próprio)
  landingPageId: string;
  landingKind: string | null | undefined;
  sourceUrl?: string | null;
}

export interface SemanticShadowLogRecord {
  mode: 'semantic_shadow';
  landingPageId: string;
  family: PageFamily;
  familySource: string;
  familyConfidence: number;
  themeCandidatesCount: number;
  componentsCount: number;
  regionsCount: number;
  regionKinds: string[];
  editableFieldsCount: number;
  unclassifiedCount: number;
  warningsCount: number;
  conflictsCount: number;
  overallConfidence: number;
  criticalRegionsHealthy: boolean;
  latencyMs: number;
  authority: 'legacy'; // sempre — semantic mapper é observador
  moduleError?: string;
  mapperError?: string;
}

/**
 * Executa semantic mapper em modo shadow.
 * NUNCA lança. Retorna record estruturado.
 */
export async function runSemanticShadow(
  ctx: SemanticShadowContext,
): Promise<SemanticShadowLogRecord> {
  const start = performance.now();
  const family = toFamily(ctx.landingKind);

  const baseRecord: SemanticShadowLogRecord = {
    mode: 'semantic_shadow',
    landingPageId: ctx.landingPageId,
    family,
    familySource: 'default_unknown',
    familyConfidence: 0,
    themeCandidatesCount: 0,
    componentsCount: 0,
    regionsCount: 0,
    regionKinds: [],
    editableFieldsCount: 0,
    unclassifiedCount: 0,
    warningsCount: 0,
    conflictsCount: 0,
    overallConfidence: 0,
    criticalRegionsHealthy: false,
    latencyMs: 0,
    authority: 'legacy',
  };

  const bundle = await loadAdapterRuntime();
  if (!bundle) {
    return {
      ...baseRecord,
      moduleError: 'adapters_module_unavailable',
      latencyMs: Math.round(performance.now() - start),
    };
  }

  let modApi: {
    computePageSemanticModel: (input: unknown) => PageSemanticModel;
    createSharedDetectorRegistry: () => unknown;
    accordionDetector?: unknown;
    articleDetector?: unknown;
    footerDetector?: unknown;
    shopifyCtaDetector?: unknown;
  };
  try {
    // Reusa dynamic-imported module — tem tudo que precisamos
    modApi = (await import('@blackshop/landinglab-adapters')) as unknown as typeof modApi;
  } catch (err) {
    return {
      ...baseRecord,
      moduleError: `dynamic_import_failed: ${errStr(err)}`,
      latencyMs: Math.round(performance.now() - start),
    };
  }

  // Constrói shared registry local (sem singleton pra evitar leak entre jobs)
  let sharedRegistry: ReturnType<typeof modApi.createSharedDetectorRegistry>;
  try {
    const reg = modApi.createSharedDetectorRegistry() as {
      register: (d: unknown) => void;
      freeze: () => void;
    };
    if (modApi.shopifyCtaDetector) reg.register(modApi.shopifyCtaDetector);
    if (modApi.articleDetector) reg.register(modApi.articleDetector);
    if (modApi.accordionDetector) reg.register(modApi.accordionDetector);
    if (modApi.footerDetector) reg.register(modApi.footerDetector);
    reg.freeze();
    sharedRegistry = reg;
  } catch (err) {
    return {
      ...baseRecord,
      mapperError: `shared_registry_build_failed: ${errStr(err)}`,
      latencyMs: Math.round(performance.now() - start),
    };
  }

  let model: PageSemanticModel;
  try {
    model = modApi.computePageSemanticModel({
      html: ctx.html,
      landingPageId: ctx.landingPageId,
      userHint: mapLandingKindToPageFamily(ctx.landingKind),
      sourceUrl: ctx.sourceUrl ?? null,
      adapterRegistry: bundle.registry,
      sharedRegistry,
    });
  } catch (err) {
    return {
      ...baseRecord,
      mapperError: `compute_failed: ${errStr(err)}`,
      latencyMs: Math.round(performance.now() - start),
    };
  }

  const latency = Math.round(performance.now() - start);

  return {
    mode: 'semantic_shadow',
    landingPageId: ctx.landingPageId,
    family: model.family,
    familySource: model.familySource,
    familyConfidence: model.familyConfidence,
    themeCandidatesCount: model.themeCandidates.length,
    componentsCount: model.components.length,
    regionsCount: model.regions.length,
    regionKinds: model.regions.map((r) => `${r.source}:${r.kind}`),
    editableFieldsCount: model.editableFields.length,
    unclassifiedCount: model.unclassified.length,
    warningsCount: model.warnings.length,
    conflictsCount: model.conflicts.length,
    overallConfidence: model.overallConfidence,
    criticalRegionsHealthy: model.criticalRegionsHealthy,
    latencyMs: latency,
    authority: 'legacy',
  };
}

function mapLandingKindToPageFamily(
  kind: string | null | undefined,
): PageFamily | null {
  if (kind === 'sales_page') return 'sales_page';
  if (kind === 'advertorial') return 'advertorial';
  if (kind === 'pdp_derived') return 'pdp_derived';
  return null; // classifier auto
}

function errStr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
