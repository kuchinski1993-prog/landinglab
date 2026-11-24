// Hero Designer — Squad 3 agent (Fase 2, paralelo).
//
// Story 13.5 AC13.
//
// Responsabilidades:
//   - Gera hero cinematográfico em 3 tamanhos:
//       desktop (1920x1080), og (1200x630), mobile (375x812)
//   - Prompt anchor: copyDeck.hooks[0].text (hook principal EN).
//   - Provider: Freepik primary + Higgsfield fallback (via generateWithFallback).
//   - Se ambos falham para hero desktop AND mobile, orchestrator abortará.

import type { Pir } from '@blackshop/landinglab-research';
import type { CopyDeck } from '@blackshop/landinglab-copy';

import type { ImageProvider } from '../providers/types.js';
import type { Assets } from '../schema/visual-assets.js';
import type { VisualTraceEntry } from '../orchestrator.js';
import { generateWithFallback } from './shared.js';
import type { HeroDesignerOutput, VisualDirection } from './types.js';

export interface HeroDesignerDeps {
  primary: ImageProvider;
  fallback?: ImageProvider;
}

const SIZES: Array<{ key: keyof Assets['hero']['urls_by_size']; size: string }> = [
  { key: 'desktop', size: '1920x1080' },
  { key: 'og', size: '1200x630' },
  { key: 'mobile', size: '375x812' },
];

function buildHeroPrompt(
  pir: Pir,
  copyDeck: CopyDeck,
  direction: VisualDirection,
  sizeKey: string,
): string {
  const hook = copyDeck.hooks[0]?.text ?? pir.value_equation.dream_outcome;
  const desire = pir.voc.top_desires[0]?.desire ?? pir.value_equation.dream_outcome;
  const framing =
    sizeKey === 'mobile'
      ? 'Vertical composition. Subject centered top-third. Room for text overlay in bottom half.'
      : sizeKey === 'og'
        ? 'Landscape composition, tight framing. Subject slightly right-of-center, negative space for headline overlay on the left.'
        : 'Cinematic wide landscape composition. Subject in golden ratio. Depth of field, atmospheric lighting.';
  return [
    `Cinematographic hero image for a landing page. Tone: ${direction.tone_descriptor}.`,
    `Emotional anchor (from hook): "${hook}"`,
    `Aspirational state: ${desire}.`,
    `Palette guidance: primary ${direction.palette.primary}, accent ${direction.palette.accent}.`,
    `Style guidance: ${direction.style_guidance}`,
    framing,
    'Photorealistic. High detail. No text overlays. No watermarks. No logos.',
  ].join(' ');
}

export async function runHeroDesigner(
  pir: Pir,
  copyDeck: CopyDeck,
  direction: VisualDirection,
  deps: HeroDesignerDeps,
): Promise<HeroDesignerOutput & { notes: string[]; placeholderUsed: boolean }> {
  const allTraces: VisualTraceEntry[] = [];
  const notes: string[] = [];
  let placeholderUsed = false;

  const results = await Promise.allSettled(
    SIZES.map((s) =>
      generateWithFallback(
        'hero-designer',
        {
          prompt: buildHeroPrompt(pir, copyDeck, direction, s.key),
          size: s.size,
          style: 'cinematic-photorealistic',
        },
        { primary: deps.primary, fallback: deps.fallback },
      ),
    ),
  );

  const urls: Assets['hero']['urls_by_size'] = { desktop: '', og: '', mobile: '' };

  results.forEach((r, i) => {
    const sizeKey = SIZES[i]!.key;
    if (r.status === 'fulfilled') {
      allTraces.push(...r.value.traces);
      if (r.value.placeholderUsed) placeholderUsed = true;
      if (r.value.output) {
        urls[sizeKey] = r.value.output.url;
      } else {
        notes.push(`hero ${String(sizeKey)}: both providers failed`);
      }
    } else {
      const err = r.reason instanceof Error ? r.reason.message : String(r.reason);
      notes.push(`hero ${String(sizeKey)} rejected: ${err}`);
    }
  });

  // Fallback: if og is missing but desktop or mobile present, clone.
  if (!urls.og) {
    const fallbackUrl = urls.desktop || urls.mobile;
    if (fallbackUrl) {
      urls.og = fallbackUrl;
      notes.push('hero og cloned from desktop/mobile (og failed)');
    }
  }

  return {
    urls_by_size: urls,
    traces: allTraces,
    notes,
    placeholderUsed,
  };
}
