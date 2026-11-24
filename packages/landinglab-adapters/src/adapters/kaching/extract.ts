// ADR-001 §3.5 (D3) + Fase 10.3 §4–7 + closure 10.3 — Kaching extraction.
//
// SCOPE: Kaching Bundles COMPONENT — não page theme. Só emite regiões que
// são estruturalmente responsabilidade do widget:
//
//   - bundles          (crítica — o widget)
//   - price_block[]    (crítica — filhas do widget)
//
// EXCLUÍDO (closure 10.3):
//   - cta_primary      → button[name="add"] é padrão Shopify genérico
//                        (não específico Kaching). Fica pra camada shared.
//   - product_json     → script[data-cc-pdp-product-json] é tema AURIVITA
//                        (ver apps/worker/.../landinglab-apply-bundle.processor.ts:2354).
//                        Não é responsabilidade do Kaching adapter.
//
// Não força gallery/reviews/faq/etc. apenas pra aumentar coverage (§4).
//
// Selectors preservam parity com legacy detector:
//   legacy: $('.kaching-bundles__bar[data-deal-bar-id]')
//   → adapter fornece MESMO selector no bundleRegion e ordem 1:1 dos cards.
//   → 10.5 usa isto pra cut sem mudar renderBundleOffers.

import * as cheerio from 'cheerio';
import type { CheerioAPI, Cheerio } from 'cheerio';
import type { AdapterInput } from '../../theme-adapter.js';
import type { ExtractionResult, UnclassifiedElement, AdapterWarning } from '../../types/extraction.js';
import type { SemanticRegion } from '../../types/semantic-region.js';
import type { EditableField } from '../../types/editable-field.js';
import { INITIAL_THRESHOLDS } from '../../resolver/thresholds.js';
import { criticalityOf } from '../../types/semantic-region.js';
import { runAllRules } from './rules.js';
import { KACHING_ADAPTER_ID } from './detect.js';

// Legacy parity: mesmo selector usado por detectBundleCards() em
// apps/worker/src/processors/landinglab-apply-bundle.processor.ts (rama 1/4).
const BUNDLE_CARDS_SELECTOR = '.kaching-bundles__bar[data-deal-bar-id]';
const BUNDLE_CONTAINER_SELECTOR = '.kaching-bundles__bar[data-deal-bar-id]';
const PRICE_SPAN_SELECTOR = '.kaching-bundles__bar-price';
const COMPARE_SPAN_SELECTOR = '.kaching-bundles__bar-full-price';

export function extractKaching(input: AdapterInput): ExtractionResult {
  const $ = cheerio.load(input.html);
  const warnings: AdapterWarning[] = [];
  const unclassified: UnclassifiedElement[] = [];

  const outcomes = runAllRules($);
  const overallConfidence = Math.min(
    1,
    outcomes.reduce((acc, o) => acc + o.scoreDelta, 0),
  );

  const regions: SemanticRegion[] = [];
  const editableFields: EditableField[] = [];

  // ── bundles region ────────────────────────────────────────────
  const bars = $(BUNDLE_CARDS_SELECTOR);
  if (bars.length > 0) {
    const bundleRegion = buildBundleRegion($, bars, overallConfidence);
    regions.push(bundleRegion);
    editableFields.push(...buildBundleEditableFields($, bars));

    // Critical-region warning se overallConfidence < CRITICAL_MIN.
    if (overallConfidence < INITIAL_THRESHOLDS.CRITICAL_MIN_CONFIDENCE) {
      warnings.push({
        severity: 'error',
        code: 'critical_region_low_confidence',
        message: `bundles region confidence ${overallConfidence.toFixed(3)} < CRITICAL_MIN ${INITIAL_THRESHOLDS.CRITICAL_MIN_CONFIDENCE}`,
        region: 'bundles',
      });
    }
  } else {
    warnings.push({
      severity: 'warn',
      code: 'missing_bundles_region',
      message: 'no .kaching-bundles__bar[data-deal-bar-id] found',
      region: 'bundles',
    });
  }

  // NOTE (closure 10.3): removidos cta_primary e product_json daqui.
  //   - cta_primary  → button[name="add"] é Shopify genérico, não Kaching-specific.
  //     Fica pra camada shared/futuro adapter apropriado.
  //   - product_json → script[data-cc-pdp-product-json] é tema Aurivita
  //     (processor:2354). Não é responsabilidade do Kaching Bundles component.

  // ── unclassified: sticky ATC bars órfãos (padrão conhecido do legacy) ─
  // §9: quando há bloco relevante mas não conseguimos tipar, marca.
  const stickyAtc = $('[class*="sticky"][class*="atc"], [class*="floating-atc"]');
  stickyAtc.each((_, el) => {
    const $el = $(el);
    unclassified.push({
      selector: firstClassSelector($el),
      reason: 'sticky/floating ATC pattern detected — needs manual triage',
    });
  });

  return {
    family: 'sales_page',
    adapterId: KACHING_ADAPTER_ID,
    regions,
    editableFields,
    unclassified,
    overallConfidence,
    warnings,
  };
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function buildBundleRegion(
  $: CheerioAPI,
  bars: Cheerio<any>,
  regionConfidence: number,
): SemanticRegion {
  const children: SemanticRegion[] = [];
  bars.each((idx, el) => {
    const $el = $(el);
    const dealId = ($el.attr('data-deal-bar-id') ?? '').trim();
    // Selector do card: idealmente pelo data-deal-bar-id (estável).
    const cardSelector = dealId
      ? `.kaching-bundles__bar[data-deal-bar-id="${cssEscape(dealId)}"]`
      : `.kaching-bundles__bar[data-deal-bar-id]:nth-of-type(${idx + 1})`;
    children.push({
      kind: 'price_block',
      selector: cardSelector,
      evidence: {
        reasons: [
          `bundle_card idx=${idx}`,
          dealId ? `data-deal-bar-id="${dealId}"` : 'no-deal-id-fallback-nth',
        ],
        matchedRules: ['kaching.card.data_deal_bar_id'],
      },
      confidence: dealId ? 0.9 : 0.6,
      criticality: criticalityOf('price_block'),
    });
  });

  return {
    kind: 'bundles',
    selector: BUNDLE_CONTAINER_SELECTOR, // Mesmo selector do legacy detector
    evidence: {
      reasons: [`bars_count=${bars.length}`, `parity_selector=${BUNDLE_CONTAINER_SELECTOR}`],
      matchedRules: ['kaching.bundles.container'],
    },
    confidence: regionConfidence,
    criticality: criticalityOf('bundles'),
    children,
  };
}

function buildBundleEditableFields(
  $: CheerioAPI,
  bars: Cheerio<any>,
): EditableField[] {
  const fields: EditableField[] = [];

  bars.each((idx, el) => {
    const $el = $(el);
    const dealId = ($el.attr('data-deal-bar-id') ?? '').trim();
    const cardSelector = dealId
      ? `.kaching-bundles__bar[data-deal-bar-id="${cssEscape(dealId)}"]`
      : `.kaching-bundles__bar[data-deal-bar-id]:nth-of-type(${idx + 1})`;

    // A5 — bundle price: canonical source em landing_bundle_offers.price_cents
    fields.push({
      id: `bundles.offer.${idx}.price`,
      region: 'bundles',
      type: 'price',
      label: `Preço da oferta ${idx + 1}`,
      source: 'canonical',
      criticality: 'critical',
      reference: {
        table: 'landing_bundle_offers',
        column: 'price_cents',
        // rowId ainda não sabido: mapping oferta↔landing_bundle_offers.id
        // ocorre no worker por sort_order/position — fora do adapter (D3).
      },
      confidence: dealId ? 0.9 : 0.6,
      capabilities: ['edit'],
      selector: `${cardSelector} ${PRICE_SPAN_SELECTOR}`,
    });

    // A5 — bundle compare_at: também canonical
    const hasCompare = $el.find(COMPARE_SPAN_SELECTOR).length > 0;
    if (hasCompare) {
      fields.push({
        id: `bundles.offer.${idx}.compare_at`,
        region: 'bundles',
        type: 'price',
        label: `Preço "de" da oferta ${idx + 1}`,
        source: 'canonical',
        criticality: 'critical',
        reference: {
          table: 'landing_bundle_offers',
          column: 'compare_at_cents',
        },
        confidence: dealId ? 0.85 : 0.55,
        capabilities: ['edit'],
        selector: `${cardSelector} ${COMPARE_SPAN_SELECTOR}`,
      });
    }
  });

  return fields;
}

// Primeira classe legível do elemento (fallback pra selector).
function firstClassSelector($el: Cheerio<any>): string {
  const cls = ($el.attr('class') ?? '').trim().split(/\s+/).filter(Boolean);
  return cls.length > 0 ? `.${cls[0]}` : $el.get(0)?.tagName ?? 'unknown';
}

// Escape mínimo pra usar valor arbitrário em CSS attribute selector.
// Cheerio aceita aspas duplas quebradas → escapa só " e \.
function cssEscape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
