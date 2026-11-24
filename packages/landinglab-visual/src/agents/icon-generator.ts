// Icon Generator — Squad 3 agent (Fase 2, paralelo).
//
// Story 13.5 AC15.
// Gera 5-8 ícones minimalistas (um por bullet) — ordem 1:1 com copyDeck.benefit_bullets.

import type { Pir } from '@blackshop/landinglab-research';
import type { CopyDeck } from '@blackshop/landinglab-copy';

import type { ImageProvider } from '../providers/types.js';
import type { Icon } from '../schema/visual-assets.js';
import type { VisualTraceEntry } from '../orchestrator.js';
import { generateWithFallback } from './shared.js';
import type { IconGeneratorOutput, VisualDirection } from './types.js';

export interface IconGeneratorDeps {
  primary: ImageProvider;
  fallback?: ImageProvider;
}

function buildIconPrompt(bulletText: string, direction: VisualDirection): string {
  return [
    'Minimalist line-art icon for a landing page benefit bullet.',
    `Bullet concept: "${bulletText.slice(0, 120)}"`,
    `Style: thin line, monochromatic in accent color ${direction.palette.accent}.`,
    `Background: transparent or ${direction.palette.bg}.`,
    'Simple geometric shape. Iconic. 512x512. No text, no words.',
  ].join(' ');
}

export async function runIconGenerator(
  _pir: Pir,
  copyDeck: CopyDeck,
  direction: VisualDirection,
  deps: IconGeneratorDeps,
): Promise<IconGeneratorOutput & { notes: string[]; placeholderUsed: boolean }> {
  const bullets = copyDeck.benefit_bullets;
  const allTraces: VisualTraceEntry[] = [];
  const notes: string[] = [];
  let placeholderUsed = false;

  const results = await Promise.allSettled(
    bullets.map((b) =>
      generateWithFallback(
        'icon-generator',
        {
          prompt: buildIconPrompt(b.text, direction),
          size: '512x512',
          style: 'minimalist-line-icon',
        },
        { primary: deps.primary, fallback: deps.fallback },
      ),
    ),
  );

  const icons: Icon[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      allTraces.push(...r.value.traces);
      if (r.value.placeholderUsed) placeholderUsed = true;
      if (r.value.output) {
        icons.push({ url: r.value.output.url, matches_bullet: i });
      } else {
        notes.push(`icon for bullet ${i} failed on both providers`);
      }
    } else {
      const err = r.reason instanceof Error ? r.reason.message : String(r.reason);
      notes.push(`icon for bullet ${i} rejected: ${err}`);
    }
  });

  return { icons, traces: allTraces, notes, placeholderUsed };
}
