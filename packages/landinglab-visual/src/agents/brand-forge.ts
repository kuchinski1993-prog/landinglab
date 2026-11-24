// Brand Forge — Squad 3 agent (Fase 2, paralelo).
//
// Story 13.5 AC12, AC26.
//
// Responsabilidades:
//   - Gera brand.name (fictional, min 3, max 30, passa filter) via Claude text.
//   - Gera brand.tagline (min 5, max 80) via Claude text.
//   - Gera 3 logos (full, mark, wordmark) via ImageProvider (Freepik primary + fallback).
//   - Retry 1x se brand.name violar BANNED_BRAND_TERMS.

import type { Pir } from '@blackshop/landinglab-research';
import type { CopyDeck } from '@blackshop/landinglab-copy';

import type { ClaudeTextClient } from '../providers/claude.js';
import type { ImageProvider } from '../providers/types.js';
import type { Brand } from '../schema/visual-assets.js';
import { rejectsBannedBrands, BANNED_BRAND_TERMS } from '../schema/visual-assets.js';
import type { VisualTraceEntry } from '../orchestrator.js';
import { generateWithFallback, tryParseJson } from './shared.js';
import type { BrandForgeOutput, VisualDirection } from './types.js';

export interface BrandForgeDeps {
  claude: ClaudeTextClient;
  primary: ImageProvider;
  fallback?: ImageProvider;
}

const NAMING_SYSTEM_PROMPT = `You are the BRAND FORGE agent — LandingLab Squad 3.

Generate a fictional brand identity for a product landing page.

Output ONE JSON object:
{
  "candidates": ["Name1", "Name2", "Name3", "Name4", "Name5"],
  "chosen_name": "Name",
  "tagline": "5-80 char tagline"
}

RULES:
- All names MUST be fictional (invented). NEVER use or reference real brands like: ${BANNED_BRAND_TERMS.join(', ')}.
- Name length: 3-30 chars.
- Tagline echoes the product's dream outcome from PIR.
- CRITICAL: Respond with a single JSON object only. No prose.`;

interface NamingResult {
  name: string;
  tagline: string;
  traces: VisualTraceEntry[];
  notes: string[];
}

async function chooseName(
  pir: Pir,
  copyDeck: CopyDeck,
  direction: VisualDirection,
  deps: BrandForgeDeps,
): Promise<NamingResult> {
  const started = Date.now();
  let tokens_in = 0;
  let tokens_out = 0;
  let cost_usd = 0;
  const notes: string[] = [];
  let lastError = '';

  const userPayload = JSON.stringify(
    {
      product: pir.identity.name,
      category: pir.identity.category,
      dream_outcome: pir.value_equation.dream_outcome,
      tone: direction.tone_descriptor,
      hook_sample: copyDeck.hooks[0]?.text ?? null,
    },
    null,
    2,
  );

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const systemPrompt =
        attempt === 0
          ? NAMING_SYSTEM_PROMPT
          : `${NAMING_SYSTEM_PROMPT}\n\nPREVIOUS ATTEMPT PRODUCED A BANNED NAME OR INVALID JSON: ${lastError}\nGenerate a completely different fictional name that does not contain any banned term.`;
      const res = await deps.claude.createMessage({
        system: systemPrompt,
        messages: [
          { role: 'user', content: `Produce brand naming JSON for:\n${userPayload}` },
        ],
        jsonMode: true,
        temperature: attempt === 0 ? 0.9 : 0.6,
        maxTokens: 500,
      });
      tokens_in += res.tokens_in;
      tokens_out += res.tokens_out;
      cost_usd += res.cost_usd;

      const parsed = tryParseJson(res.content) as Record<string, unknown> | null;
      if (!parsed) {
        lastError = 'invalid_json';
        continue;
      }

      const candidates = Array.isArray(parsed['candidates'])
        ? (parsed['candidates'] as unknown[]).filter((c): c is string => typeof c === 'string')
        : [];
      const chosenRaw =
        typeof parsed['chosen_name'] === 'string' ? (parsed['chosen_name'] as string) : '';
      const taglineRaw =
        typeof parsed['tagline'] === 'string' ? (parsed['tagline'] as string) : '';

      // Try chosen first, then candidates in order.
      const nameCandidates = [chosenRaw, ...candidates].filter(
        (n) => typeof n === 'string' && n.trim().length >= 3 && n.length <= 30,
      );
      const validName = nameCandidates.find((n) => rejectsBannedBrands(n));
      if (validName && taglineRaw.length >= 5 && taglineRaw.length <= 80) {
        if (validName !== chosenRaw) {
          notes.push(`chosen_name violated banned brand filter; fell back to candidate "${validName}"`);
        }
        return {
          name: validName,
          tagline: taglineRaw,
          notes,
          traces: [
            {
              agent: 'brand-forge',
              provider: 'claude',
              tokens_in,
              tokens_out,
              cost_usd,
              latency_ms: Date.now() - started,
            },
          ],
        };
      }
      lastError = validName
        ? `tagline invalid (length=${taglineRaw.length})`
        : `all name candidates violated filter or invalid length`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  // Full fallback: synthesize from product name + fallback tagline.
  const rawProductName = pir.identity.name.trim();
  const genericName = deriveGenericName(rawProductName);
  const genericTagline = `Design your ${pir.identity.category ?? 'lifestyle'} — ${direction.tone_descriptor}`.slice(0, 80);
  notes.push(`brand-forge fallback name/tagline generated (Claude failed: ${lastError})`);
  return {
    name: genericName,
    tagline: genericTagline.length >= 5 ? genericTagline : `The ${genericName} experience`,
    notes,
    traces: [
      {
        agent: 'brand-forge',
        provider: 'claude',
        tokens_in,
        tokens_out,
        cost_usd,
        latency_ms: Date.now() - started,
        error: lastError,
      },
    ],
  };
}

/** Derive a safe fictional name from product name if Claude fails. */
function deriveGenericName(productName: string): string {
  const cleaned = productName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
  const base = cleaned.length >= 3 ? cleaned : 'Nova';
  const capitalized = base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
  const generic = `${capitalized}Lab`;
  // Fallback if it accidentally matches banned.
  if (!rejectsBannedBrands(generic)) return 'NovaLab';
  return generic.slice(0, 30);
}

function buildLogoPrompt(direction: VisualDirection, name: string, variant: 'full' | 'mark' | 'wordmark'): string {
  const palette = direction.palette;
  const base = `Fictional brand logo for "${name}". Tone: ${direction.tone_descriptor}. Palette: primary ${palette.primary}, accent ${palette.accent}, bg ${palette.bg}.`;
  switch (variant) {
    case 'full':
      return `${base} Full brand logo: symbol + brand name below. Flat vector style. Transparent background. High detail, minimalist, corporate-grade.`;
    case 'mark':
      return `${base} Brand mark only (icon/symbol, no text). Simple geometric shape, flat vector, transparent background. Iconic and recognizable.`;
    case 'wordmark':
      return `${base} Brand wordmark only (custom typography of the name, no symbol). Modern letterform, ${direction.typography.headline_font} inspired. Transparent background.`;
  }
}

export async function runBrandForge(
  pir: Pir,
  copyDeck: CopyDeck,
  direction: VisualDirection,
  deps: BrandForgeDeps,
): Promise<BrandForgeOutput & { notes: string[]; placeholderUsed: boolean }> {
  // Step 1: naming via Claude.
  const naming = await chooseName(pir, copyDeck, direction, deps);
  const notes: string[] = [...naming.notes];
  const allTraces: VisualTraceEntry[] = [...naming.traces];
  let placeholderUsed = false;

  // Step 2: 3 logos via ImageProvider (parallel).
  const variants: Array<'full' | 'mark' | 'wordmark'> = ['full', 'mark', 'wordmark'];
  const results = await Promise.allSettled(
    variants.map((v) =>
      generateWithFallback(
        'brand-forge',
        {
          prompt: buildLogoPrompt(direction, naming.name, v),
          size: '512x512',
          style: 'flat-vector-logo',
        },
        { primary: deps.primary, fallback: deps.fallback },
      ),
    ),
  );

  const urls: Record<'full' | 'mark' | 'wordmark', string> = {
    full: '',
    mark: '',
    wordmark: '',
  };

  results.forEach((r, i) => {
    const variant = variants[i]!;
    if (r.status === 'fulfilled') {
      allTraces.push(...r.value.traces);
      if (r.value.placeholderUsed) placeholderUsed = true;
      if (r.value.output) {
        urls[variant] = r.value.output.url;
      } else {
        notes.push(`brand-forge logo "${variant}" failed on both providers`);
      }
    } else {
      const err = r.reason instanceof Error ? r.reason.message : String(r.reason);
      allTraces.push({
        agent: 'brand-forge',
        provider: 'none',
        cost_usd: 0,
        latency_ms: 0,
        error: err,
      });
      notes.push(`brand-forge logo "${variant}" rejected: ${err}`);
    }
  });

  // Fill missing logos with a fallback URL: reuse the first successful one.
  const anyUrl = urls.full || urls.mark || urls.wordmark;
  if (anyUrl) {
    for (const v of variants) {
      if (!urls[v]) {
        urls[v] = anyUrl;
        notes.push(`brand-forge logo "${v}" cloned from another variant (fallback)`);
      }
    }
  } else {
    // NO logos generated at all — use a placeholder host so schema doesn't fail.
    const placeholder = `https://placeholder.landinglab.local/logo-${encodeURIComponent(naming.name)}.png`;
    for (const v of variants) urls[v] = placeholder;
    notes.push('brand-forge: no logo variants produced; using placeholder URLs');
    placeholderUsed = true;
  }

  const logo_urls: Brand['logo_urls'] = {
    full: urls.full,
    mark: urls.mark,
    wordmark: urls.wordmark,
  };

  return {
    name: naming.name,
    tagline: naming.tagline,
    logo_urls,
    traces: allTraces,
    notes,
    placeholderUsed,
  };
}
