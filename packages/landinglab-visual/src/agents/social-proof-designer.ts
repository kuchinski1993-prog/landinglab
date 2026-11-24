// Social Proof Designer — Squad 3 agent (Fase 2, paralelo).
//
// Story 13.5 AC16.
// Gera assets visuais SEM texto real:
//   - 2-3 trust badges (shield/clock/chat outlines em palette.accent)
//   - 1-2 templates before/after (layout duas caixas)
//   - 1-2 backgrounds (usados como fundo para testimonial cards no Squad 4)

import type { Pir } from '@blackshop/landinglab-research';
import type { CopyDeck } from '@blackshop/landinglab-copy';

import type { ImageProvider } from '../providers/types.js';
import type { VisualTraceEntry } from '../orchestrator.js';
import { generateWithFallback } from './shared.js';
import type { SocialProofDesignerOutput, VisualDirection } from './types.js';

export interface SocialProofDesignerDeps {
  primary: ImageProvider;
  fallback?: ImageProvider;
}

const BADGE_CONCEPTS = ['shield outline (guarantee)', 'clock outline (fast support)', 'chat bubble outline (24/7)'];

function buildBadgePrompt(concept: string, direction: VisualDirection): string {
  return [
    `Minimalist trust badge visual: ${concept}.`,
    `Style: outline icon, ${direction.palette.accent} color, transparent background.`,
    'Simple geometric shape. No text, no words. 512x512.',
  ].join(' ');
}

function buildBeforeAfterPrompt(direction: VisualDirection): string {
  return [
    'Before/After transformation layout: two rectangular boxes side-by-side.',
    'Left box: subtle desaturated tones. Right box: vibrant.',
    `Accent color divider between boxes: ${direction.palette.accent}.`,
    'Minimal geometric shapes, no photorealistic content, no text. 1024x1024.',
  ].join(' ');
}

function buildBackgroundPrompt(direction: VisualDirection): string {
  return [
    'Abstract background pattern for testimonial section.',
    `Color palette: subtle ${direction.palette.bg} base with ${direction.palette.accent} accents.`,
    'Soft gradient, minimal geometric shapes. No text. 1024x1024.',
  ].join(' ');
}

export async function runSocialProofDesigner(
  pir: Pir,
  _copyDeck: CopyDeck,
  direction: VisualDirection,
  deps: SocialProofDesignerDeps,
): Promise<SocialProofDesignerOutput & { notes: string[]; placeholderUsed: boolean }> {
  void pir; // suppress unused — pir reserved for future niche-aware prompting.
  const allTraces: VisualTraceEntry[] = [];
  const notes: string[] = [];
  let placeholderUsed = false;

  // 3 badges + 1 before/after + 1 background (total 5 gen calls in parallel).
  const badgePromises = BADGE_CONCEPTS.map((concept) =>
    generateWithFallback(
      'social-proof-designer',
      {
        prompt: buildBadgePrompt(concept, direction),
        size: '512x512',
        style: 'flat-outline-icon',
      },
      { primary: deps.primary, fallback: deps.fallback },
    ),
  );

  const baPromise = generateWithFallback(
    'social-proof-designer',
    {
      prompt: buildBeforeAfterPrompt(direction),
      size: '1024x1024',
      style: 'minimal-geometric',
    },
    { primary: deps.primary, fallback: deps.fallback },
  );

  const bgPromise = generateWithFallback(
    'social-proof-designer',
    {
      prompt: buildBackgroundPrompt(direction),
      size: '1024x1024',
      style: 'abstract-pattern',
    },
    { primary: deps.primary, fallback: deps.fallback },
  );

  const [badgeResults, baResult, bgResult] = await Promise.all([
    Promise.allSettled(badgePromises),
    baPromise.catch((err) => ({
      output: null,
      traces: [] as VisualTraceEntry[],
      placeholderUsed: false,
      error: err instanceof Error ? err.message : String(err),
    })),
    bgPromise.catch((err) => ({
      output: null,
      traces: [] as VisualTraceEntry[],
      placeholderUsed: false,
      error: err instanceof Error ? err.message : String(err),
    })),
  ]);

  const trust_badges: string[] = [];
  badgeResults.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      allTraces.push(...r.value.traces);
      if (r.value.placeholderUsed) placeholderUsed = true;
      if (r.value.output) {
        trust_badges.push(r.value.output.url);
      } else {
        notes.push(`trust badge ${i} failed on both providers`);
      }
    } else {
      const err = r.reason instanceof Error ? r.reason.message : String(r.reason);
      notes.push(`trust badge ${i} rejected: ${err}`);
    }
  });

  const before_after: string[] = [];
  if ('output' in baResult && baResult.output) {
    allTraces.push(...baResult.traces);
    if (baResult.placeholderUsed) placeholderUsed = true;
    before_after.push(baResult.output.url);
  } else {
    notes.push('before/after template failed on both providers');
    if ('traces' in baResult) allTraces.push(...baResult.traces);
  }

  const backgrounds: string[] = [];
  if ('output' in bgResult && bgResult.output) {
    allTraces.push(...bgResult.traces);
    if (bgResult.placeholderUsed) placeholderUsed = true;
    backgrounds.push(bgResult.output.url);
  } else {
    notes.push('background failed on both providers');
    if ('traces' in bgResult) allTraces.push(...bgResult.traces);
  }

  return {
    trust_badges,
    before_after,
    backgrounds,
    traces: allTraces,
    notes,
    placeholderUsed,
  };
}
