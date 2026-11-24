// Fase 11.3 — ArticleDetector.
//
// Detecta article body + headline + subheadline em advertorial content.
//
// PRECISION > COVERAGE. Não classificar qualquer bloco com 3 <p> como article.
//
// Sinais combinados (article body):
//   A1: <article> tag semântico presente (obrigatório inicialmente)
//   A2: 5+ <p> filhos diretos no <article>
//   A3: <h1> ou <h2> dentro do <article> (evidência de headline associada)
//   A4: cumulative text length dos <p> children >= 400 chars
//   A5: ausência de kaching/cc-pdp/product-form dentro do <article>
//
// Confidence article_body:
//   A1 obrigatório
//   A1 + A2 + A3 + A4         → 0.85
//   A1 + A2 + A3              → 0.70
//   A1 + A2 (só)              → 0.55 (below CRITICAL_MIN — unclassified)
//   A5 ausente → -0.15 (commerce markers presentes; advertorial questionável)
//
// Emite:
//   article_body (o próprio <article>)
//   headline (primeiro h1/h2 filho direto)
//   subheadline (segundo h1/h2/h3 se presente, com constraint)
//
// Ownership: shared_detector, priority default, authoritative=true
// (kinds article_body/headline/subheadline permitem shared_detector primary)

import type { EditableField } from '../../types/editable-field.js';
import type {
  AdapterWarning,
  UnclassifiedElement,
} from '../../types/extraction.js';
import { criticalityOf } from '../../types/semantic-region.js';
import type {
  SemanticRegion,
  SemanticRegionKind,
} from '../../types/semantic-region.js';
import { buildDomScope } from '../dom-scope.js';
import type { DomScope } from '../dom-scope.js';
import { DEFAULT_PRIORITY_BY_ORIGIN } from '../ownership.js';
import type { RegionOwnershipClaim } from '../ownership.js';
import type {
  SharedDetectorContext,
  SharedDetectorResult,
  SharedRegionDetector,
} from '../types.js';

const DETECTOR_ID = 'article';

const COMMERCE_MARKERS_IN_ARTICLE =
  '.kaching-bundles__bar, .cc-pdp-offer, button[name="add"], ' +
  'form[action*="/cart"], form[data-product-form], [class*="bundle-selector"]';

export const articleDetector: SharedRegionDetector = Object.freeze({
  id: DETECTOR_ID,
  targetKinds: ['article_body', 'headline', 'subheadline'] as const,
  supportedFamilies: [] as const, // Filter é do próprio detector (via commerce markers)
  detect(ctx: SharedDetectorContext): SharedDetectorResult {
    const $ = ctx.$;

    const claims: RegionOwnershipClaim[] = [];
    const editableFields: EditableField[] = [];
    const unclassified: UnclassifiedElement[] = [];
    const warnings: AdapterWarning[] = [];
    const reasons: string[] = [];

    const articles = $('article').toArray();

    if (articles.length === 0) {
      reasons.push('no <article> tag found');
      return {
        detectorId: DETECTOR_ID,
        ownershipClaims: [],
        editableFields: [],
        unclassified: [],
        warnings: [],
        reasons,
      };
    }

    for (const el of articles) {
      const $article = $(el as never);

      // A2: 5+ paragraphs
      const paragraphs = $article.children('p').toArray();
      const pCount = paragraphs.length;

      // A3: headline (h1/h2 filho direto)
      const headlines = $article.children('h1, h2').toArray();
      const hasHeadline = headlines.length > 0;

      // A4: cumulative text length
      let cumulativeTextLen = 0;
      for (const p of paragraphs) {
        cumulativeTextLen += $(p as never).text().trim().length;
      }
      const hasSubstantialText = cumulativeTextLen >= 400;

      // A5: commerce markers dentro do article?
      const commerceInside = $article.find(COMMERCE_MARKERS_IN_ARTICLE).length > 0;

      // Confidence baseline (A1 já é dado por article existir)
      let confidence = 0.35; // A1 baseline
      const evidenceReasons: string[] = ['A1:article_tag'];

      if (pCount >= 5) {
        confidence += 0.2;
        evidenceReasons.push(`A2:paragraphs=${pCount}`);
      }
      if (hasHeadline) {
        confidence += 0.15;
        evidenceReasons.push(`A3:has_headline`);
      }
      if (hasSubstantialText) {
        confidence += 0.15;
        evidenceReasons.push(`A4:text_len=${cumulativeTextLen}`);
      }
      if (commerceInside) {
        confidence -= 0.15;
        evidenceReasons.push(`A5:commerce_inside_penalty`);
      }

      confidence = Math.max(0, Math.min(1, confidence));

      const articleScope = buildDomScope($, el);

      // Precision gate
      if (confidence < 0.6) {
        unclassified.push({
          selector: articleScope.selector,
          reason: `low_confidence_article score=${confidence.toFixed(2)} evidence=[${evidenceReasons.join(',')}]`,
          suggestedKinds: ['article_body'],
        });
        reasons.push(
          `article rejected: confidence=${confidence.toFixed(2)} scope=${articleScope.structuralPath}`,
        );
        continue;
      }

      // Emit article_body
      const articleRegion: SemanticRegion = {
        kind: 'article_body',
        selector: articleScope.selector,
        evidence: {
          reasons: [
            `semantic_id=article.body`,
            `confidence=${confidence.toFixed(2)}`,
            ...evidenceReasons,
          ],
          matchedRules: [`${DETECTOR_ID}.article_body`],
        },
        confidence,
        criticality: criticalityOf('article_body'),
      };

      claims.push(
        makeClaim(
          articleScope,
          articleRegion,
          'article_body',
          confidence,
          'article.body',
        ),
      );

      // Emit headline (primeiro h1/h2)
      if (hasHeadline) {
        const headlineEl = headlines[0]!;
        const headlineScope = buildDomScope($, headlineEl);
        const headlineText = $(headlineEl as never).text().trim();

        // Headline confidence herda parcialmente do article
        const headlineConfidence = Math.min(1, confidence + 0.05);

        const headlineRegion: SemanticRegion = {
          kind: 'headline',
          selector: headlineScope.selector,
          evidence: {
            reasons: [
              `semantic_id=article.headline`,
              `confidence=${headlineConfidence.toFixed(2)}`,
              `parent_article_confidence=${confidence.toFixed(2)}`,
            ],
            matchedRules: [`${DETECTOR_ID}.headline`],
          },
          confidence: headlineConfidence,
          criticality: criticalityOf('headline'),
        };

        claims.push(
          makeClaim(
            headlineScope,
            headlineRegion,
            'headline',
            headlineConfidence,
            'article.headline',
          ),
        );

        if (headlineText.length > 0 && headlineText.length < 300) {
          editableFields.push({
            id: 'article.headline.text',
            region: 'headline',
            type: 'text',
            label: 'Article headline',
            source: 'html',
            criticality: 'non_critical',
            value: headlineText,
            confidence: headlineConfidence,
            capabilities: ['edit', 'translate'],
            selector: headlineScope.selector,
          });
        }
      }

      // Emit subheadline se presente
      const potentialSubheadline = $article
        .children('h2, h3')
        .filter((_, x) => !headlines.includes(x))
        .first();
      if (potentialSubheadline.length > 0) {
        const subEl = potentialSubheadline.get(0)!;
        const subScope = buildDomScope($, subEl);
        const subText = $(subEl as never).text().trim();
        const subConfidence = Math.min(1, confidence - 0.05);

        if (subConfidence >= 0.55) {
          const subRegion: SemanticRegion = {
            kind: 'subheadline',
            selector: subScope.selector,
            evidence: {
              reasons: [
                `semantic_id=article.subheadline`,
                `confidence=${subConfidence.toFixed(2)}`,
              ],
              matchedRules: [`${DETECTOR_ID}.subheadline`],
            },
            confidence: subConfidence,
            criticality: criticalityOf('subheadline'),
          };

          claims.push(
            makeClaim(
              subScope,
              subRegion,
              'subheadline',
              subConfidence,
              'article.subheadline',
            ),
          );

          if (subText.length > 0 && subText.length < 300) {
            editableFields.push({
              id: 'article.subheadline.text',
              region: 'subheadline',
              type: 'text',
              label: 'Article subheadline',
              source: 'html',
              criticality: 'non_critical',
              value: subText,
              confidence: subConfidence,
              capabilities: ['edit', 'translate'],
              selector: subScope.selector,
            });
          }
        }
      }

      reasons.push(
        `emitted article_body scope=${articleScope.structuralPath} confidence=${confidence.toFixed(2)}`,
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

function makeClaim(
  scope: DomScope,
  region: SemanticRegion,
  kind: SemanticRegionKind,
  confidence: number,
  semanticId: string,
): RegionOwnershipClaim {
  return {
    ownerId: DETECTOR_ID,
    originType: 'shared_detector',
    regionKind: kind,
    scope,
    priority: DEFAULT_PRIORITY_BY_ORIGIN.shared_detector,
    confidence,
    authoritative: true,
    reason: `${semanticId} @ ${scope.structuralPath}`,
    region,
  };
}
