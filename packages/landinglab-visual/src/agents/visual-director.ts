// Visual Director — Squad 3 orchestrator agent (Fase 1, sequencial).
//
// Story 13.5 AC11, AC24.
//
// Responsabilidades:
//   - Lê PIR (identity, avatar, market.sophistication_level, voc, value_equation)
//     + CopyDeck EN (hooks, offer_stack, social_proof, bullets).
//   - Decide paleta (5 cores hex), tipografia (2 Google Fonts), tom visual + guidance.
//   - Retorna VisualDirection — os 5 agents downstream consomem.
//   - NÃO gera imagens; NÃO persiste. Só decide direção.
//
// Fallback (AC24): se Claude retornar paleta incompleta, completa com defaults
// baseados em sophistication_level do PIR (baixo → vibrante; alto → sóbrio).

import type { Pir } from '@blackshop/landinglab-research';
import type { CopyDeck } from '@blackshop/landinglab-copy';

import type { ClaudeTextClient } from '../providers/claude.js';
import type { BrandPalette, BrandTypography } from '../schema/visual-assets.js';
import type { VisualTraceEntry } from '../orchestrator.js';
import { tryParseJson } from './shared.js';
import type { VisualDirection } from './types.js';

export interface VisualDirectorDeps {
  claude: ClaudeTextClient;
}

export interface VisualDirectorResult {
  direction: VisualDirection;
  trace: VisualTraceEntry;
  /** Notas do director sobre decisões — usado no director_notes final. */
  notes: string;
}

const DIRECTOR_SYSTEM_PROMPT = `You are the VISUAL DIRECTOR of the LandingLab Squad 3.

Your job: decide the visual identity for a landing page based on PIR + CopyDeck.

You output a SINGLE JSON object with this shape:
{
  "palette": {
    "primary": "#RRGGBB",
    "secondary": "#RRGGBB",
    "accent": "#RRGGBB",
    "bg": "#RRGGBB",
    "text": "#RRGGBB"
  },
  "typography": {
    "headline_font": "Google Font name (e.g., 'Poppins')",
    "body_font": "Google Font name (e.g., 'Inter')"
  },
  "tone_descriptor": "3-6 words describing the visual tone",
  "style_guidance": "1-2 sentences guiding downstream image agents (framing, mood, subjects to include/avoid)"
}

DECISION RULES:
- sophistication_level 1-2 (early market): vibrant colors, bold sans-serif headlines, energetic tone.
- sophistication_level 3 (competitive): balanced palette, versatile typography, aspirational tone.
- sophistication_level 4-5 (saturated): sophisticated palette (muted or contrasted), serif or premium sans, clinical/trustworthy tone.
- All 5 palette colors MUST be valid hex (#RRGGBB or #RGB).
- headline_font and body_font MUST be real Google Fonts.

CRITICAL: Respond with a single JSON object only. No prose, no markdown, no code fences.`;

/**
 * Builds the user payload for the Claude call.
 * Extracts only fields that matter for visual direction — avoids sending full PIR.
 */
function buildUserPayload(pir: Pir, copyDeck: CopyDeck): string {
  const summary = {
    identity: {
      name: pir.identity.name,
      category: pir.identity.category,
    },
    avatar: {
      demographics: pir.avatar.demographics,
      psychographics: pir.avatar.psychographics,
    },
    market: {
      sophistication_level: pir.market.sophistication_level,
    },
    value_equation: {
      dream_outcome: pir.value_equation.dream_outcome,
    },
    voc: {
      top_desires_sample: pir.voc.top_desires.slice(0, 5).map((d) => d.desire),
    },
    copy_hooks: copyDeck.hooks.map((h) => ({ stage: h.awareness_stage, text: h.text })),
    copy_offer_main: copyDeck.offer_stack.main_offer,
    copy_bullets_sample: copyDeck.benefit_bullets.slice(0, 3).map((b) => b.text),
  };
  return `Decide visual direction for landing page. Product context below.\n\n${JSON.stringify(summary, null, 2)}`;
}

const HEX6_REGEX = /^#[0-9a-fA-F]{6}$/;
const HEX_ANY_REGEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function isValidHex(s: unknown): s is string {
  return typeof s === 'string' && HEX_ANY_REGEX.test(s);
}

/** Palette defaults por sophistication level (fallback AC24). */
function paletteDefaults(sophisticationLevel: number): BrandPalette {
  if (sophisticationLevel <= 2) {
    // Early market: vibrant.
    return {
      primary: '#FF5A3C',
      secondary: '#FFB800',
      accent: '#00C2A8',
      bg: '#FFFFFF',
      text: '#111111',
    };
  }
  if (sophisticationLevel === 3) {
    // Competitive: balanced.
    return {
      primary: '#2563EB',
      secondary: '#7C3AED',
      accent: '#F59E0B',
      bg: '#F9FAFB',
      text: '#111827',
    };
  }
  // Saturated: sophisticated.
  return {
    primary: '#0F172A',
    secondary: '#334155',
    accent: '#D4AF37',
    bg: '#FAFAF9',
    text: '#1C1917',
  };
}

const TYPOGRAPHY_DEFAULT: BrandTypography = {
  headline_font: 'Poppins',
  body_font: 'Inter',
};

/**
 * Runs the Visual Director. 1 retry if JSON parse fails.
 * Applies fallback for missing palette colors (AC24).
 */
export async function runVisualDirector(
  pir: Pir,
  copyDeck: CopyDeck,
  deps: VisualDirectorDeps,
): Promise<VisualDirectorResult> {
  const started = Date.now();
  const notes: string[] = [];
  let tokens_in = 0;
  let tokens_out = 0;
  let cost_usd = 0;
  let lastError = 'unknown_failure';

  const userPayload = buildUserPayload(pir, copyDeck);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await deps.claude.createMessage({
        system:
          attempt === 0
            ? DIRECTOR_SYSTEM_PROMPT
            : `${DIRECTOR_SYSTEM_PROMPT}\n\nPREVIOUS ATTEMPT FAILED: ${lastError}\nReturn a VALID JSON object with all required fields.`,
        messages: [{ role: 'user', content: userPayload }],
        jsonMode: true,
        temperature: attempt === 0 ? 0.6 : 0.3,
        maxTokens: 1_500,
      });
      tokens_in += res.tokens_in;
      tokens_out += res.tokens_out;
      cost_usd += res.cost_usd;

      const parsed = tryParseJson(res.content) as Record<string, unknown> | null;
      if (!parsed) {
        lastError = 'invalid_json';
        continue;
      }

      // Extract with fallbacks.
      const paletteRaw = parsed['palette'] as Record<string, unknown> | undefined;
      const defaults = paletteDefaults(pir.market.sophistication_level);
      const palette: BrandPalette = {
        primary: isValidHex(paletteRaw?.['primary']) ? (paletteRaw!['primary'] as string) : defaults.primary,
        secondary: isValidHex(paletteRaw?.['secondary'])
          ? (paletteRaw!['secondary'] as string)
          : defaults.secondary,
        accent: isValidHex(paletteRaw?.['accent']) ? (paletteRaw!['accent'] as string) : defaults.accent,
        bg: isValidHex(paletteRaw?.['bg']) ? (paletteRaw!['bg'] as string) : defaults.bg,
        text: isValidHex(paletteRaw?.['text']) ? (paletteRaw!['text'] as string) : defaults.text,
      };

      // Normalize hex to 6-char lower for downstream consistency.
      for (const k of Object.keys(palette) as (keyof BrandPalette)[]) {
        const v = palette[k];
        if (v.length === 4) {
          // #RGB → #RRGGBB
          const r = v[1];
          const g = v[2];
          const b = v[3];
          palette[k] = `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
        } else {
          palette[k] = v.toUpperCase();
        }
      }

      // Track palette fallbacks.
      const fallbackKeys = (['primary', 'secondary', 'accent', 'bg', 'text'] as const).filter(
        (k) => !isValidHex(paletteRaw?.[k]),
      );
      if (fallbackKeys.length > 0) {
        notes.push(
          `palette fallback (sophistication_level=${pir.market.sophistication_level}): ${fallbackKeys.join(', ')}`,
        );
      }

      const typographyRaw = parsed['typography'] as Record<string, unknown> | undefined;
      const typography: BrandTypography = {
        headline_font:
          typeof typographyRaw?.['headline_font'] === 'string' && (typographyRaw['headline_font'] as string).length > 0
            ? (typographyRaw['headline_font'] as string)
            : TYPOGRAPHY_DEFAULT.headline_font,
        body_font:
          typeof typographyRaw?.['body_font'] === 'string' && (typographyRaw['body_font'] as string).length > 0
            ? (typographyRaw['body_font'] as string)
            : TYPOGRAPHY_DEFAULT.body_font,
      };

      const toneRaw = parsed['tone_descriptor'];
      const tone_descriptor =
        typeof toneRaw === 'string' && toneRaw.length > 0 ? toneRaw : 'aspirational and trustworthy';

      const guidanceRaw = parsed['style_guidance'];
      const style_guidance =
        typeof guidanceRaw === 'string' && guidanceRaw.length > 0
          ? guidanceRaw
          : `Focus on ${pir.value_equation.dream_outcome.slice(0, 60)}. Match tone: ${tone_descriptor}.`;

      // Validate hex6 after normalization.
      const badHex = (Object.keys(palette) as (keyof BrandPalette)[]).filter(
        (k) => !HEX6_REGEX.test(palette[k]),
      );
      if (badHex.length > 0) {
        // Force defaults for any that still don't parse.
        for (const k of badHex) {
          palette[k] = defaults[k].toUpperCase();
        }
        notes.push(`palette re-normalization applied for: ${badHex.join(', ')}`);
      }

      const direction: VisualDirection = {
        palette,
        typography,
        tone_descriptor,
        style_guidance,
      };

      const noteText =
        `visual-director selected tone="${tone_descriptor}" for sophistication_level=${pir.market.sophistication_level}` +
        (notes.length > 0 ? `. Notes: ${notes.join('; ')}` : '');

      return {
        direction,
        notes: noteText,
        trace: {
          agent: 'visual-director',
          provider: 'claude',
          tokens_in,
          tokens_out,
          cost_usd,
          latency_ms: Date.now() - started,
        },
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === 1) break;
    }
  }

  // Full fallback: no successful Claude response — use pure defaults.
  const defaults = paletteDefaults(pir.market.sophistication_level);
  const direction: VisualDirection = {
    palette: {
      primary: defaults.primary.toUpperCase(),
      secondary: defaults.secondary.toUpperCase(),
      accent: defaults.accent.toUpperCase(),
      bg: defaults.bg.toUpperCase(),
      text: defaults.text.toUpperCase(),
    },
    typography: TYPOGRAPHY_DEFAULT,
    tone_descriptor: 'aspirational and trustworthy',
    style_guidance: `Fallback direction (Claude call failed). Focus on ${pir.value_equation.dream_outcome.slice(0, 60)}.`,
  };
  return {
    direction,
    notes: `visual-director fallback: Claude failed (${lastError}); used sophistication-based defaults`,
    trace: {
      agent: 'visual-director',
      provider: 'claude',
      tokens_in,
      tokens_out,
      cost_usd,
      latency_ms: Date.now() - started,
      error: lastError,
    },
  };
}
