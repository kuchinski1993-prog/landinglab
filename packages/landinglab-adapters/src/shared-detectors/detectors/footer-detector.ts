// Fase 11.3 — FooterDetector.
//
// PRECISION > COVERAGE. Só emite footer com evidência CLARA:
//   F1: <footer> tag semântico
//   F2: role="contentinfo"
//
// NÃO usa "último container grande da página" como regra.
//
// Se não bater F1 nem F2 → detector é no-op (silent).

import type { EditableField } from '../../types/editable-field.js';
import type {
  AdapterWarning,
  UnclassifiedElement,
} from '../../types/extraction.js';
import { criticalityOf } from '../../types/semantic-region.js';
import type { SemanticRegion } from '../../types/semantic-region.js';
import { buildDomScope } from '../dom-scope.js';
import { DEFAULT_PRIORITY_BY_ORIGIN } from '../ownership.js';
import type { RegionOwnershipClaim } from '../ownership.js';
import type {
  SharedDetectorContext,
  SharedDetectorResult,
  SharedRegionDetector,
} from '../types.js';

const DETECTOR_ID = 'footer';

export const footerDetector: SharedRegionDetector = Object.freeze({
  id: DETECTOR_ID,
  targetKinds: ['footer'] as const,
  supportedFamilies: [] as const,
  detect(ctx: SharedDetectorContext): SharedDetectorResult {
    const $ = ctx.$;

    const claims: RegionOwnershipClaim[] = [];
    const editableFields: EditableField[] = [];
    const unclassified: UnclassifiedElement[] = [];
    const warnings: AdapterWarning[] = [];
    const reasons: string[] = [];

    // F1 + F2: <footer> OR role="contentinfo"
    const candidates = $('footer, [role="contentinfo"]').toArray();

    if (candidates.length === 0) {
      reasons.push('no <footer> or role="contentinfo" found — detector no-op');
      return {
        detectorId: DETECTOR_ID,
        ownershipClaims: [],
        editableFields: [],
        unclassified: [],
        warnings: [],
        reasons,
      };
    }

    for (const el of candidates) {
      const $el = $(el as never);
      const scope = buildDomScope($, el);

      // Preferimos <footer> tag semântico
      const isFooterTag = scope.tagName === 'footer';
      const hasRoleContentinfo = ($el.attr('role') ?? '').toLowerCase() === 'contentinfo';

      const evidenceReasons: string[] = [];
      let confidence = 0;
      if (isFooterTag) {
        confidence = 0.85;
        evidenceReasons.push('F1:footer_tag');
      } else if (hasRoleContentinfo) {
        confidence = 0.75;
        evidenceReasons.push('F2:role_contentinfo');
      }

      // Precision gate
      if (confidence < 0.6) {
        reasons.push('candidate below threshold');
        continue;
      }

      const region: SemanticRegion = {
        kind: 'footer',
        selector: scope.selector,
        evidence: {
          reasons: [
            `semantic_id=footer.${scope.instanceId}`,
            `confidence=${confidence.toFixed(2)}`,
            ...evidenceReasons,
          ],
          matchedRules: [
            `${DETECTOR_ID}.${isFooterTag ? 'F1' : 'F2'}`,
          ],
        },
        confidence,
        criticality: criticalityOf('footer'),
      };

      claims.push({
        ownerId: DETECTOR_ID,
        originType: 'shared_detector',
        regionKind: 'footer',
        scope,
        priority: DEFAULT_PRIORITY_BY_ORIGIN.shared_detector,
        confidence,
        authoritative: true,
        reason: `footer @ ${scope.structuralPath}`,
        region,
      });

      reasons.push(
        `emitted footer scope=${scope.structuralPath} confidence=${confidence.toFixed(2)}`,
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
