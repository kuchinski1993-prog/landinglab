// Fase 10.5 — Bundle target strangler cut.
//
// Substitui APENAS a origem dos cards passados para renderBundleOffers.
// Legacy detectBundleCards permanece intacto e é sempre chamado antes
// (parity guard + fallback). renderBundleOffers é INALTERADO.
//
// Feature flag: LANDINGLAB_ADAPTER_KACHING_ENABLED=true (default OFF).
//
// Decisão de authority (adapter | legacy) segue matriz:
//
//   1. Flag OFF                              → legacy (fallback: adapter_flag_off)
//   2. Module load failure                   → legacy (fallback: adapters_module_unavailable)
//   3. resolver ambiguous                    → legacy (fallback: ambiguous_candidates)
//   4. resolver no_match                     → legacy (fallback: no_matching_adapter)
//   5. chosen !== 'kaching' em 10.5          → legacy (fallback: adapter_not_kaching_in_10_5)
//   6. extract() throws                      → legacy (fallback: adapter_extract_error)
//   7. bundle region ausente                 → legacy (fallback: no_bundle_region)
//   8. bundle confidence < CRITICAL_MIN      → legacy (fallback: critical_region_low_confidence)
//   9. $(bundleRegion.selector) resulta 0    → legacy (fallback: adapter_zero_cards)
//  10. parity !== true (count/order divergem)→ legacy (fallback: parity_mismatch)
//  11. tudo OK                               → adapter (authority='adapter')
//
// Legacy path fica intacto em TODOS os casos exceto 11.
// Em nenhum caso o processor é bloqueado por erro do adapter.

import type { CheerioAPI, Cheerio } from 'cheerio';
import type { PageFamily } from '@blackshop/landinglab-adapters';
import { loadAdapterRuntime } from './adapter-runtime.js';
import {
  compareBundles,
  mapLandingKindToFamily,
  sampleAdapterBundles,
  sampleLegacyBundles,
  type BundleComparison,
} from './adapter-shadow.js';

// Thresholds — mirrored from packages/landinglab-adapters/src/resolver/thresholds.ts.
// Se algum dia divergir, teste vai falhar (ver adapter-bundle-authority.test.ts).
const CRITICAL_MIN_CONFIDENCE = 0.6;

/**
 * Env flag. Default OFF. Só literal 'true' habilita — evita ativação acidental.
 */
export function isKachingAuthorityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['LANDINGLAB_ADAPTER_KACHING_ENABLED'] === 'true';
}

export interface BundleAuthorityContext {
  html: string;
  $: CheerioAPI;
  landingPageId: string;
  landingKind: string | null | undefined;
  bundleAdapterHint: string | null | undefined;
  legacyCards: Cheerio<never>;
}

export type Authority = 'adapter' | 'legacy';

export interface BundleAuthorityDecision {
  authority: Authority;
  /** Cards que vão para renderBundleOffers. Nunca null. */
  cards: Cheerio<never>;

  // Log payload (evidência positiva do caminho escolhido)
  bundleTargetAuthority: Authority; // duplica authority pra reader-friendly log key
  adapterId?: string;
  adapterResolution?: 'confident' | 'ambiguous' | 'no_match';
  overallConfidence?: number;
  bundleRegionSelector?: string;
  bundleRegionConfidence?: number;
  candidates?: Array<{ adapterId: string; score: number }>;
  comparison?: BundleComparison;
  fallbackReason?: string;
  authorityError?: string;
  resolverReasons?: string[];
  pageFamily: PageFamily;
}

/**
 * Decide quem fornece os cards para renderBundleOffers.
 *
 * NUNCA lança. Sempre retorna um objeto válido com `cards` populado.
 * Se retornar authority='adapter', chamador deve usar `decision.cards` diretamente.
 * Se authority='legacy', chamador deve usar seus `legacyCards` originais
 * (mas por conveniência, esta função ecoa `legacyCards` em `decision.cards`).
 */
export async function resolveBundleAuthority(
  ctx: BundleAuthorityContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BundleAuthorityDecision> {
  const pageFamily = mapLandingKindToFamily(ctx.landingKind);

  const legacyDecision: BundleAuthorityDecision = {
    authority: 'legacy',
    bundleTargetAuthority: 'legacy',
    cards: ctx.legacyCards,
    pageFamily,
  };

  // 1. Flag off
  if (!isKachingAuthorityEnabled(env)) {
    return {
      ...legacyDecision,
      fallbackReason: 'adapter_flag_off',
    };
  }

  // 2. Module load
  const bundle = await loadAdapterRuntime();
  if (!bundle) {
    return {
      ...legacyDecision,
      fallbackReason: 'adapters_module_unavailable',
      authorityError: 'load_failed',
    };
  }

  // 3-4. Resolver
  let detection;
  try {
    detection = bundle.mod.resolve(
      {
        html: ctx.html,
        hintedFamily: pageFamily,
        hintedAdapterId: ctx.bundleAdapterHint ?? undefined,
        landingPageId: ctx.landingPageId,
      },
      bundle.registry.list(),
    );
  } catch (err) {
    return {
      ...legacyDecision,
      fallbackReason: 'resolver_error',
      authorityError: errorMessage(err),
    };
  }

  const candidates = detection.candidates.map((c) => ({
    adapterId: c.adapterId,
    score: c.score,
  }));

  if (detection.resolution !== 'confident' || !detection.chosen) {
    return {
      ...legacyDecision,
      adapterResolution: detection.resolution,
      candidates,
      resolverReasons: detection.reasons,
      fallbackReason:
        detection.resolution === 'ambiguous'
          ? 'ambiguous_candidates'
          : 'no_matching_adapter',
    };
  }

  // 5. Escopo 10.5: só Kaching é autoritativo. Outros adapters (futuros)
  //    continuam legacy até fase separada.
  if (detection.chosen.adapterId !== 'kaching') {
    return {
      ...legacyDecision,
      adapterResolution: 'confident',
      adapterId: detection.chosen.adapterId,
      candidates,
      resolverReasons: detection.reasons,
      fallbackReason: 'adapter_not_kaching_in_10_5',
    };
  }

  // 6. Extract
  const adapter = bundle.registry.get(detection.chosen.adapterId);
  if (!adapter) {
    return {
      ...legacyDecision,
      adapterResolution: 'confident',
      adapterId: detection.chosen.adapterId,
      candidates,
      resolverReasons: detection.reasons,
      fallbackReason: 'adapter_missing_in_registry',
    };
  }

  let extraction;
  try {
    extraction = adapter.extract({
      html: ctx.html,
      hintedFamily: pageFamily,
      hintedAdapterId: ctx.bundleAdapterHint ?? undefined,
      landingPageId: ctx.landingPageId,
    });
  } catch (err) {
    return {
      ...legacyDecision,
      adapterResolution: 'confident',
      adapterId: 'kaching',
      candidates,
      resolverReasons: detection.reasons,
      fallbackReason: 'adapter_extract_error',
      authorityError: errorMessage(err),
    };
  }

  // 7. Bundle region presente?
  const bundleRegion = extraction.regions.find((r) => r.kind === 'bundles');
  if (!bundleRegion) {
    return {
      ...legacyDecision,
      adapterResolution: 'confident',
      adapterId: 'kaching',
      overallConfidence: extraction.overallConfidence,
      candidates,
      resolverReasons: detection.reasons,
      fallbackReason: 'no_bundle_region',
    };
  }

  // 8. Confidence
  if (bundleRegion.confidence < CRITICAL_MIN_CONFIDENCE) {
    return {
      ...legacyDecision,
      adapterResolution: 'confident',
      adapterId: 'kaching',
      overallConfidence: extraction.overallConfidence,
      bundleRegionSelector: bundleRegion.selector,
      bundleRegionConfidence: bundleRegion.confidence,
      candidates,
      resolverReasons: detection.reasons,
      fallbackReason: 'critical_region_low_confidence',
    };
  }

  // 9. Cards do adapter — busca por selector via mesmo $ do processor
  //    (parity real: cards vão pra renderBundleOffers com o mesmo $).
  const adapterCards = ctx.$(bundleRegion.selector) as unknown as Cheerio<never>;
  if (adapterCards.length === 0) {
    return {
      ...legacyDecision,
      adapterResolution: 'confident',
      adapterId: 'kaching',
      overallConfidence: extraction.overallConfidence,
      bundleRegionSelector: bundleRegion.selector,
      bundleRegionConfidence: bundleRegion.confidence,
      candidates,
      resolverReasons: detection.reasons,
      fallbackReason: 'adapter_zero_cards',
    };
  }

  // 10. Parity guard — SAFETY guard obrigatório em 10.5.
  //     Adapter só pode ganhar autoridade se produz mesmos cards que legacy.
  const legacySample = sampleLegacyBundles(ctx.$, ctx.legacyCards);
  const adapterSample = sampleAdapterBundles(extraction);
  const comparison = compareBundles(legacySample, adapterSample);

  if (!comparison.comparisonMatch) {
    return {
      ...legacyDecision,
      adapterResolution: 'confident',
      adapterId: 'kaching',
      overallConfidence: extraction.overallConfidence,
      bundleRegionSelector: bundleRegion.selector,
      bundleRegionConfidence: bundleRegion.confidence,
      candidates,
      resolverReasons: detection.reasons,
      comparison,
      fallbackReason: 'parity_mismatch',
    };
  }

  // 11. Adapter path autoritativo.
  return {
    authority: 'adapter',
    bundleTargetAuthority: 'adapter',
    cards: adapterCards,
    adapterId: 'kaching',
    adapterResolution: 'confident',
    overallConfidence: extraction.overallConfidence,
    bundleRegionSelector: bundleRegion.selector,
    bundleRegionConfidence: bundleRegion.confidence,
    candidates,
    resolverReasons: detection.reasons,
    comparison,
    pageFamily,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
