// Fase 11.3 — AccordionDetector.
//
// Detecta patterns de accordion/FAQ.
//
// IMPORTANTE (design 11.3 §3): nem todo accordion é FAQ. Pode ser:
//   - shipping accordion
//   - product details
//   - ingredients
//   - real FAQ
//
// Detector só emite kind='faq' quando evidência semântica for suficiente.
// Caso contrário → unclassified/warning com hint 'accordion detected'.
//
// Sinais robustos (accordion pattern):
//   AC1: <details><summary> pares (HTML5 nativo)
//   AC2: [aria-expanded][aria-controls] com relação coerente
//   AC3: patterns conhecidos do processor §7.5:
//        .pss-accordion-trigger + .pss-accordion-panel
//        .cc-faq__question + .cc-faq__answer
//        .faq-img-question + .faq-img-answer
//
// FAQ classification (upgrade de accordion → faq):
//   F1: pattern class contém "faq" (cc-faq, faq-img)
//   F2: >= 2 accordion items agrupados
//   F3: texto do summary/trigger tem "?" (indica question)
//   F4: heading próximo (h2/h3) contém "FAQ" ou "Frequently"

import type { CheerioAPI } from 'cheerio';
import type { EditableField } from '../../types/editable-field.js';
import type {
  AdapterWarning,
  UnclassifiedElement,
} from '../../types/extraction.js';
import { criticalityOf } from '../../types/semantic-region.js';
import type { SemanticRegion } from '../../types/semantic-region.js';
import { buildDomScope } from '../dom-scope.js';
import type { DomScope } from '../dom-scope.js';
import { DEFAULT_PRIORITY_BY_ORIGIN } from '../ownership.js';
import type { RegionOwnershipClaim } from '../ownership.js';
import type {
  SharedDetectorContext,
  SharedDetectorResult,
  SharedRegionDetector,
} from '../types.js';

const DETECTOR_ID = 'accordion';

interface AccordionCluster {
  scope: DomScope;
  containerEl: unknown;
  triggers: unknown[];
  classHint: string;
  pattern: 'details_summary' | 'aria' | 'pss' | 'cc_faq' | 'faq_img';
}

export const accordionDetector: SharedRegionDetector = Object.freeze({
  id: DETECTOR_ID,
  targetKinds: ['faq'] as const,
  supportedFamilies: [] as const,
  detect(ctx: SharedDetectorContext): SharedDetectorResult {
    const $ = ctx.$;

    const claims: RegionOwnershipClaim[] = [];
    const editableFields: EditableField[] = [];
    const unclassified: UnclassifiedElement[] = [];
    const warnings: AdapterWarning[] = [];
    const reasons: string[] = [];

    const clusters = findAccordionClusters($);

    if (clusters.length === 0) {
      reasons.push('no accordion patterns found');
      return {
        detectorId: DETECTOR_ID,
        ownershipClaims: claims,
        editableFields,
        unclassified,
        warnings,
        reasons,
      };
    }

    for (const cluster of clusters) {
      const faqDecision = classifyClusterAsFaq($, cluster);
      const {
        isFaq,
        confidence,
        evidenceReasons,
      } = faqDecision;

      if (!isFaq) {
        // Accordion detectado mas não sabemos se é FAQ — unclassified com hint
        unclassified.push({
          selector: cluster.scope.selector,
          reason:
            `accordion_pattern_but_not_faq pattern=${cluster.pattern} ` +
            `confidence=${confidence.toFixed(2)} ` +
            `evidence=[${evidenceReasons.join(',')}]`,
          suggestedKinds: ['faq'],
        });
        continue;
      }

      // Emit faq
      const region: SemanticRegion = {
        kind: 'faq',
        selector: cluster.scope.selector,
        evidence: {
          reasons: [
            `semantic_id=faq.section.${cluster.scope.instanceId}`,
            `pattern=${cluster.pattern}`,
            `confidence=${confidence.toFixed(2)}`,
            ...evidenceReasons,
          ],
          matchedRules: [`${DETECTOR_ID}.${cluster.pattern}`],
        },
        confidence,
        criticality: criticalityOf('faq'),
      };

      claims.push({
        ownerId: DETECTOR_ID,
        originType: 'shared_detector',
        regionKind: 'faq',
        scope: cluster.scope,
        priority: DEFAULT_PRIORITY_BY_ORIGIN.shared_detector,
        confidence,
        authoritative: true,
        reason: `faq.section @ ${cluster.scope.structuralPath}`,
        region,
      });

      reasons.push(
        `emitted faq scope=${cluster.scope.structuralPath} confidence=${confidence.toFixed(2)}`,
      );
    }

    return {
      detectorId: DETECTOR_ID,
      ownershipClaims: claims,
      editableFields,
      unclassified,
      warnings,
      reasons,
    };
  },
});

// ────────────────────────────────────────────────────────────────
// Cluster discovery
// ────────────────────────────────────────────────────────────────

function findAccordionClusters($: CheerioAPI): AccordionCluster[] {
  const clusters: AccordionCluster[] = [];
  const seen = new Set<string>();

  // AC1: <details><summary>
  const detailsContainers = new Map<string, { container: unknown; count: number }>();
  $('details > summary').each((_, sumEl) => {
    const $summary = $(sumEl as never);
    const parent = $summary.parent().parent().get(0);
    if (!parent) return;
    const scope = buildDomScope($, parent);
    const key = `details:${scope.structuralPath}`;
    const existing = detailsContainers.get(key);
    if (existing) {
      existing.count++;
    } else {
      detailsContainers.set(key, { container: parent, count: 1 });
    }
  });
  for (const [key, info] of detailsContainers) {
    if (seen.has(key)) continue;
    seen.add(key);
    const scope = buildDomScope($, info.container);
    clusters.push({
      scope,
      containerEl: info.container,
      triggers: $('details > summary', info.container as never).toArray(),
      classHint: 'details',
      pattern: 'details_summary',
    });
  }

  // AC3: known patterns — cluster por parent do trigger
  addPatternClusters($, 'pss-accordion-trigger', 'pss', clusters, seen);
  addPatternClusters($, 'cc-faq__question', 'cc_faq', clusters, seen);
  addPatternClusters($, 'faq-img-question', 'faq_img', clusters, seen);

  // AC2: aria-expanded coerente (fallback genérico) — só cluster quando
  // agrupamento é claro (parent comum contendo >= 2 triggers).
  const ariaGroups = new Map<string, unknown>();
  const ariaCounts = new Map<string, number>();
  $('[aria-expanded][aria-controls]').each((_, el) => {
    const parent = $(el as never).parent().get(0);
    if (!parent) return;
    const scope = buildDomScope($, parent);
    const key = `aria:${scope.structuralPath}`;
    ariaGroups.set(key, parent);
    ariaCounts.set(key, (ariaCounts.get(key) ?? 0) + 1);
  });
  for (const [key, count] of ariaCounts) {
    if (count < 2) continue;
    if (seen.has(key)) continue;
    const container = ariaGroups.get(key);
    if (!container) continue;
    seen.add(key);
    const scope = buildDomScope($, container);
    clusters.push({
      scope,
      containerEl: container,
      triggers: $('[aria-expanded][aria-controls]', container as never).toArray(),
      classHint: 'aria',
      pattern: 'aria',
    });
  }

  return clusters;
}

function addPatternClusters(
  $: CheerioAPI,
  triggerClass: string,
  pattern: AccordionCluster['pattern'],
  clusters: AccordionCluster[],
  seen: Set<string>,
): void {
  const containerMap = new Map<string, { container: unknown; count: number }>();
  $(`.${triggerClass}`).each((_, el) => {
    const parent = $(el as never).parent().get(0);
    if (!parent) return;
    const scope = buildDomScope($, parent);
    const key = `${pattern}:${scope.structuralPath}`;
    const existing = containerMap.get(key);
    if (existing) {
      existing.count++;
    } else {
      containerMap.set(key, { container: parent, count: 1 });
    }
  });

  for (const [key, info] of containerMap) {
    if (seen.has(key)) continue;
    seen.add(key);
    const scope = buildDomScope($, info.container);
    clusters.push({
      scope,
      containerEl: info.container,
      triggers: $(`.${triggerClass}`, info.container as never).toArray(),
      classHint: triggerClass,
      pattern,
    });
  }
}

// ────────────────────────────────────────────────────────────────
// FAQ classification per cluster
// ────────────────────────────────────────────────────────────────

interface FaqDecision {
  isFaq: boolean;
  confidence: number;
  evidenceReasons: string[];
}

function classifyClusterAsFaq(
  $: CheerioAPI,
  cluster: AccordionCluster,
): FaqDecision {
  const evidenceReasons: string[] = [];
  let score = 0;

  // F1: class contém 'faq'
  const hasFaqClass =
    cluster.pattern === 'cc_faq' ||
    cluster.pattern === 'faq_img' ||
    $(cluster.containerEl as never)
      .attr('class')
      ?.toLowerCase()
      .includes('faq') === true;
  if (hasFaqClass) {
    score += 0.35;
    evidenceReasons.push('F1:class_contains_faq');
  }

  // F2: >= 2 items agrupados
  const triggerCount = cluster.triggers.length;
  if (triggerCount >= 2) {
    score += 0.2;
    evidenceReasons.push(`F2:trigger_count=${triggerCount}`);
  }

  // F3: pelo menos 50% dos triggers tem '?' no texto
  let questionCount = 0;
  for (const t of cluster.triggers) {
    const text = $(t as never).text().trim();
    if (text.includes('?')) questionCount++;
  }
  const questionRatio = triggerCount > 0 ? questionCount / triggerCount : 0;
  if (questionRatio >= 0.5) {
    score += 0.25;
    evidenceReasons.push(`F3:question_ratio=${questionRatio.toFixed(2)}`);
  }

  // F4: heading próximo com "FAQ" ou "Frequently"
  const nearbyHeading =
    $(cluster.containerEl as never).prevAll('h1,h2,h3').first().text().trim().toLowerCase();
  const parentPrev =
    $(cluster.containerEl as never)
      .parent()
      .prevAll('h1,h2,h3')
      .first()
      .text()
      .trim()
      .toLowerCase();
  const nearbyText = `${nearbyHeading} ${parentPrev}`;
  if (/\bfaq\b|\bfrequently/i.test(nearbyText)) {
    score += 0.2;
    evidenceReasons.push('F4:nearby_heading_faq');
  }

  const confidence = Math.max(0, Math.min(1, score));
  return {
    isFaq: confidence >= 0.6,
    confidence,
    evidenceReasons,
  };
}
