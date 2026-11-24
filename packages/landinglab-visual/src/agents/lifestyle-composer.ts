// Lifestyle Composer — Squad 3 agent (Fase 2, paralelo).
//
// Story 13.5 AC14.
// Gera 3-5 imagens de lifestyle (produto em contexto de uso real do avatar).

import type { Pir } from '@blackshop/landinglab-research';
import type { CopyDeck } from '@blackshop/landinglab-copy';

import type { ImageProvider } from '../providers/types.js';
import type { VisualTraceEntry } from '../orchestrator.js';
import { generateWithFallback } from './shared.js';
import type { LifestyleComposerOutput, VisualDirection } from './types.js';

export interface LifestyleComposerDeps {
  primary: ImageProvider;
  fallback?: ImageProvider;
}

/** Contextos padrão de lifestyle (derivados de avatar quando possível). */
function buildScenes(pir: Pir): string[] {
  const desires = pir.voc.top_desires.slice(0, 5).map((d) => d.desire);
  const psychographics = pir.avatar.psychographics.lifestyle ?? 'daily-life';
  const baseScenes = [
    `at home, cozy setting, natural lighting, ${psychographics}`,
    'outdoors, active setting, golden hour lighting',
    'in a modern minimalist workspace/context',
  ];
  const bonusScenes = desires.slice(0, 2).map((d) => `context evoking: "${d}"`);
  const scenes = [...baseScenes, ...bonusScenes].slice(0, 4); // 4 total (min 3, max 5)
  return scenes;
}

function buildLifestylePrompt(
  pir: Pir,
  direction: VisualDirection,
  scene: string,
): string {
  return [
    `Lifestyle scene for landing page. Product context: ${pir.identity.name}.`,
    `Setting: ${scene}.`,
    `Palette guidance: primary ${direction.palette.primary}, accent ${direction.palette.accent}.`,
    `Tone: ${direction.tone_descriptor}. ${direction.style_guidance}`,
    'Photorealistic. Natural composition. No text overlays. No watermarks.',
  ].join(' ');
}

export async function runLifestyleComposer(
  pir: Pir,
  _copyDeck: CopyDeck,
  direction: VisualDirection,
  deps: LifestyleComposerDeps,
): Promise<LifestyleComposerOutput & { notes: string[]; placeholderUsed: boolean }> {
  const scenes = buildScenes(pir);
  const allTraces: VisualTraceEntry[] = [];
  const notes: string[] = [];
  let placeholderUsed = false;

  const results = await Promise.allSettled(
    scenes.map((scene) =>
      generateWithFallback(
        'lifestyle-composer',
        {
          prompt: buildLifestylePrompt(pir, direction, scene),
          size: '1024x1024',
          style: 'photorealistic-lifestyle',
        },
        { primary: deps.primary, fallback: deps.fallback },
      ),
    ),
  );

  const urls: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      allTraces.push(...r.value.traces);
      if (r.value.placeholderUsed) placeholderUsed = true;
      if (r.value.output) {
        urls.push(r.value.output.url);
      } else {
        notes.push(`lifestyle scene ${i + 1} failed on both providers`);
      }
    } else {
      const err = r.reason instanceof Error ? r.reason.message : String(r.reason);
      notes.push(`lifestyle scene ${i + 1} rejected: ${err}`);
    }
  });

  return {
    urls,
    traces: allTraces,
    notes,
    placeholderUsed,
  };
}
