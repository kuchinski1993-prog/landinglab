// Template Selector — pure deterministic rule engine.
//
// Story 13.6 AC10. Zero LLM. Reads PIR only; returns one of the 3 templates
// registered in packages/landinglab-render/src/templates/landinglab/index.ts.
//
// Rules (first match wins — order matters):
//   1. High sophistication (>= 3) + complex category  → long-form-advertorial
//   2. High emotional intensity OR rich psychographic → story-driven
//   3. Otherwise                                       → short-form-direct

import type { Pir } from '@blackshop/landinglab-research';

import type { TemplateName } from '../schema/build-output.js';

/** Categories that historically require education/proof to close the sale. */
const COMPLEX_CATEGORIES = new Set([
  'electronics',
  'tools',
  'fitness_equipment',
  'beauty',
  'supplements',
  'health_devices',
]);

export interface TemplateSelection {
  templateName: TemplateName;
  reasoning: string;
}

export function selectTemplate(pir: Pir): TemplateSelection {
  const sophistication = pir.market?.sophistication_level ?? 1;
  const category = (pir.identity?.category ?? '').toLowerCase();
  const topPainIntensity = pir.voc?.top_pains?.[0]?.intensity ?? 0;
  const beliefsCount = pir.avatar?.psychographics?.beliefs?.length ?? 0;

  // Rule 1: sophistication + complex category → long-form.
  if (sophistication >= 3 && COMPLEX_CATEGORIES.has(category)) {
    return {
      templateName: 'long-form-advertorial',
      reasoning: `high sophistication (${sophistication}) + complex product category (${category}) needs education`,
    };
  }

  // Rule 2: emotional intensity or rich psychographic profile → story-driven.
  if (topPainIntensity >= 8 || beliefsCount >= 3) {
    return {
      templateName: 'story-driven',
      reasoning: `high emotional intensity (pain=${topPainIntensity}, beliefs=${beliefsCount}) + rich psychographic profile favors narrative`,
    };
  }

  // Rule 3: default → short-form for impulse/above-fold conversion.
  return {
    templateName: 'short-form-direct',
    reasoning: `simple/impulse product (sophistication=${sophistication}, pain=${topPainIntensity}), above-fold conversion`,
  };
}
