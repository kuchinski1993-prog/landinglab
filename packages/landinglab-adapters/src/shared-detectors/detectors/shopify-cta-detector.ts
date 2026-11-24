// Fase 11.3 — ShopifyCtaDetector.
//
// Reconhece CTA comercial principal Shopify quando evidência estrutural
// suficiente. Distingue main CTA de sticky/floating.
//
// PRECISION > COVERAGE. Prefere "não detectado" a "detectado errado".
//
// Sinais combinados (não usa button[name="add"] isolado):
//   S1: button[name="add"] fora de cart-drawer/quickview/modal
//   S2: ancestor form[action*="/cart"] OR form[data-product-form]
//   S3: form contém variant selector (select/radio name=id)
//   S4: NÃO está dentro de sticky/floating container
//   S5: NÃO está em cart-drawer/quickview
//   S6: contexto product section (main/article/product-info nearby)
//
// Confidence:
//   S1 obrigatório (senão nada emitido)
//   S1 sozinho              → 0.35 (baixo; abaixo de CRITICAL_MIN 0.60)
//   S1 + S2                 → 0.65 (form product real)
//   S1 + S2 + S3            → 0.85 (form completo com variants)
//   S1 + S2 + S3 + S6       → 0.90
//   Se dentro de sticky/floating → cta_primary.sticky com confidence -0.10
//
// Ownership:
//   originType='shared_detector'
//   priority=DEFAULT (40)
//   authoritative=true (kind='cta_primary' permite shared_detector primary)

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

const DETECTOR_ID = 'shopify-cta';

// Contexts onde CTA NÃO deve ser tratado como main
const EXCLUDE_ANCESTORS =
  'cart-drawer, .cart-drawer, [data-cart-drawer], .quickview, .quick-view, ' +
  '.modal, dialog, [role="dialog"]';

// Contexts que caracterizam sticky/floating (não é main)
const STICKY_ANCESTORS =
  '[class*="sticky-atc"], [class*="floating-atc"], [class*="sticky-cta"], ' +
  '[class*="floating-cart"], [data-sticky-cart], [data-floating-cta]';

// Contexts que reforçam confidence (main product section)
const PRODUCT_SECTION_ANCESTORS =
  'main, article, [class*="product-info"], [class*="product__info"], ' +
  '[class*="product-form"], [class*="product-main"]';

export const shopifyCtaDetector: SharedRegionDetector = Object.freeze({
  id: DETECTOR_ID,
  targetKinds: ['cta_primary'] as const,
  // Detector faz sentido em qualquer family exceto quando não há commerce.
  // Advertorial: se tem estrutura Shopify legítima, emite (evidence-based).
  // Passamos [] = todas, o classifier de família só reduz score do lado
  // consumidor.
  supportedFamilies: [] as const,
  detect(ctx: SharedDetectorContext): SharedDetectorResult {
    const $ = ctx.$;

    const claims: RegionOwnershipClaim[] = [];
    const editableFields: EditableField[] = [];
    const unclassified: UnclassifiedElement[] = [];
    const warnings: AdapterWarning[] = [];
    const reasons: string[] = [];

    // S1: candidatos base
    const candidates = $('button[name="add"]').toArray();

    if (candidates.length === 0) {
      reasons.push('no button[name="add"] found');
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
      const $btn = $(el as never);

      // S5: exclusão hard — cart drawer/quickview/modal
      if ($btn.closest(EXCLUDE_ANCESTORS).length > 0) {
        reasons.push('button skipped: inside excluded ancestor');
        continue;
      }

      // S4: sticky/floating check
      const inSticky = $btn.closest(STICKY_ANCESTORS).length > 0;

      // S2: ancestor form product
      const productForm = $btn.closest(
        'form[action*="/cart"], form[data-product-form]',
      );
      const hasProductForm = productForm.length > 0;

      // S3: variant selector dentro do form
      const hasVariantSelector =
        hasProductForm &&
        (productForm.find('select[name="id"]').length > 0 ||
          productForm.find('input[name="id"][type="radio"]').length > 0);

      // S6: contexto product section
      const inProductSection = $btn.closest(PRODUCT_SECTION_ANCESTORS).length > 0;

      // Score
      let confidence = 0.35; // S1 baseline
      const evidenceReasons: string[] = ['S1:button[name="add"]'];
      if (hasProductForm) {
        confidence += 0.3;
        evidenceReasons.push('S2:ancestor_form_product');
      }
      if (hasVariantSelector) {
        confidence += 0.2;
        evidenceReasons.push('S3:variant_selector_in_form');
      }
      if (inProductSection) {
        confidence += 0.05;
        evidenceReasons.push('S6:in_product_section');
      }
      if (inSticky) {
        confidence -= 0.1;
        evidenceReasons.push('sticky_penalty');
      }

      confidence = Math.max(0, Math.min(1, confidence));

      // Precision gate: abaixo de 0.60 não emite como confident.
      if (confidence < 0.6) {
        // Marca como unclassified com hint
        const scope = buildDomScope($, el);
        unclassified.push({
          selector: scope.selector,
          reason: `low_confidence_cta score=${confidence.toFixed(2)} evidence=[${evidenceReasons.join(',')}]`,
          suggestedKinds: ['cta_primary'],
        });
        continue;
      }

      // Emit region + claim
      const scope = buildDomScope($, el);
      const isSticky = inSticky;

      // Semantic instance id: cta_primary.main OR cta_primary.sticky.N
      // (registrado no reason; DomScope continua sendo identidade estrutural).
      const semanticId = isSticky
        ? `cta_primary.sticky.${scope.instanceId}`
        : `cta_primary.main`;

      const region: SemanticRegion = {
        kind: 'cta_primary',
        selector: scope.selector,
        evidence: {
          reasons: [
            `semantic_id=${semanticId}`,
            `confidence=${confidence.toFixed(2)}`,
            ...evidenceReasons,
          ],
          matchedRules: [
            `${DETECTOR_ID}.S1`,
            ...(hasProductForm ? [`${DETECTOR_ID}.S2`] : []),
            ...(hasVariantSelector ? [`${DETECTOR_ID}.S3`] : []),
            ...(inSticky ? [`${DETECTOR_ID}.S4_sticky`] : []),
            ...(inProductSection ? [`${DETECTOR_ID}.S6`] : []),
          ],
        },
        confidence,
        criticality: criticalityOf('cta_primary'),
      };

      claims.push({
        ownerId: DETECTOR_ID,
        originType: 'shared_detector',
        regionKind: 'cta_primary',
        scope,
        priority: DEFAULT_PRIORITY_BY_ORIGIN.shared_detector,
        confidence,
        // Sticky NÃO é authoritative como main. Só o main pode ser authority.
        authoritative: !isSticky,
        reason: `shopify_cta_${isSticky ? 'sticky' : 'main'} @ ${scope.structuralPath}`,
        region,
      });

      // EditableField opcional: label do CTA. Só emit se textContent útil.
      const label = $btn.text().trim();
      if (label.length > 0 && label.length < 100) {
        editableFields.push({
          id: `${semanticId}.label`,
          region: 'cta_primary',
          type: 'text',
          label: `CTA text (${isSticky ? 'sticky' : 'main'})`,
          source: 'html',
          criticality: 'critical',
          value: label,
          confidence,
          capabilities: ['edit', 'translate'],
          selector: scope.selector,
        });
      }

      reasons.push(
        `emitted cta_primary.${isSticky ? 'sticky' : 'main'} ` +
          `confidence=${confidence.toFixed(2)} scope=${scope.structuralPath}`,
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
