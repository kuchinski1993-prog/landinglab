// LandingLab templates barrel — Squad 4 (Story 13.6).
//
// Wave 1: only the stub was exported for the React SSR de-risk smoke test.
// Wave 2 adds the 3 real templates + shared building blocks + TemplateSlots type.

export { StubTemplate, type StubTemplateProps } from './stub.js';

export * from './types.js';

export { LongFormAdvertorial } from './long-form-advertorial.js';
export { ShortFormDirect } from './short-form-direct.js';
export { StoryDriven } from './story-driven.js';
export { DynamicBlocks } from './dynamic-blocks.js';
export { BepurexAdvertorialV1 } from './bepurex-advertorial-v1.js';
export { BepurexLandingV1 } from './bepurex-landing-v1.js';

import { DynamicBlocks } from './dynamic-blocks.js';
import { LongFormAdvertorial } from './long-form-advertorial.js';
import { ShortFormDirect } from './short-form-direct.js';
import { StoryDriven } from './story-driven.js';
import { BepurexAdvertorialV1 } from './bepurex-advertorial-v1.js';
import { BepurexLandingV1 } from './bepurex-landing-v1.js';

/**
 * Template registry — maps template name (persisted in
 * landing_pages.build_metadata.template_used) to the React component that
 * renders it. Used by html-builder agent.
 *
 * Fase 3 (2026-09): dynamic-blocks é agora o template default. Os 3 antigos
 * ficam retidos por compatibilidade com landings pré-Fase-3 (histórico).
 * SM-1.4: bepurex-* são skeletons versionados (FR-8, FR-27, ADR-8).
 *
 * DynamicBlocks assinatura difere: recebe { slots } em vez de spread props.
 * html-builder detecta pela chave e chama React.createElement adequadamente.
 */
export const TEMPLATES = {
  'long-form-advertorial': LongFormAdvertorial,
  'short-form-direct': ShortFormDirect,
  'story-driven': StoryDriven,
  'dynamic-blocks': DynamicBlocks,
  'bepurex-advertorial-v1': BepurexAdvertorialV1,
  'bepurex-landing-v1': BepurexLandingV1,
} as const;

export type TemplateName = keyof typeof TEMPLATES;
export type SkeletonId = keyof typeof TEMPLATES;
