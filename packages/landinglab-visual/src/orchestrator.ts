// runVisualSquad — orquestrador do Squad 3 (Visual & Brand Forge). Wave 2 real impl.
//
// Flow:
//   1. Load PIR from DB (via pirDocumentId) if not provided in input.
//   2. Load CopyDeck EN from DB (via copyDeckIds[0]) if not provided.
//   3. Phase 1 (sequencial): runVisualDirector → VisualDirection (palette/typography/tone).
//   4. Phase 2 (parallel via Promise.allSettled): 5 agents:
//        [brand-forge, hero-designer, lifestyle-composer, icon-generator, social-proof-designer]
//        Per-agent retry: 2 max with exp backoff (2s base, 30s cap).
//        Global timeout: 240s hard.
//   5. Aggregate outputs → VisualAssets.
//   6. Hero mandatory check: if urls_by_size.desktop AND .mobile both empty → abort.
//   7. validateVisualAssets(assembled) — if Zod fails, retry orchestration once.
//   8. Persist to landing_visual_assets (version = max_existing + 1).
//   9. Return { visualAssetsId, brand, assets, costUsd, durationMs, agentTrace, directorNotes }.
//
// [AUTO-DECISION Wave 2] Fallback triggers documented in director_notes.

import { desc, eq } from 'drizzle-orm';

import type { Database } from '@blackshop/db';
import { landingPirDocuments, landingCopyDecks, landingVisualAssets } from '@blackshop/db';
import type { NewLandingVisualAsset } from '@blackshop/db';
import { pirSchema, type Pir } from '@blackshop/landinglab-research';
import { validateCopyDeck, type CopyDeck } from '@blackshop/landinglab-copy';

import { runBrandForge } from './agents/brand-forge.js';
import { runHeroDesigner } from './agents/hero-designer.js';
import { runIconGenerator } from './agents/icon-generator.js';
import { runLifestyleComposer } from './agents/lifestyle-composer.js';
import { runSocialProofDesigner } from './agents/social-proof-designer.js';
import { runVisualDirector } from './agents/visual-director.js';
import type { VisualAgentName, VisualDirection } from './agents/types.js';
import type { ClaudeTextClient } from './providers/claude.js';
import type { ImageProvider } from './providers/types.js';
import type { Assets, Brand, ContributingAgent, VisualAssets } from './schema/visual-assets.js';
import {
  validateVisualAssets,
  VisualAssetsValidationError,
} from './schema/visual-assets.js';

// ─── Config ──────────────────────────────────────────────────────────────

const GLOBAL_TIMEOUT_MS = 240_000;
const AGENT_MAX_RETRIES = 2;
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 30_000;

// ─── Public types ────────────────────────────────────────────────────────

export interface RunVisualSquadInput {
  landingPageId: string;
  pirDocumentId: string;
  copyDeckIds: string[];
  languages: string[];
  pir?: unknown;
  copyDeck?: unknown;
  previousRunId?: string;
}

export interface VisualTraceEntry {
  agent: string;
  provider: 'freepik' | 'higgsfield' | 'claude' | 'none';
  tokens_in?: number;
  tokens_out?: number;
  cost_usd: number;
  latency_ms: number;
  error?: string;
}

export interface RunVisualSquadOutput {
  visualAssetsId: string;
  brand: VisualAssets['brand'];
  assets: VisualAssets['assets'];
  costUsd: number;
  durationMs: number;
  agentTrace: VisualTraceEntry[];
  directorNotes: string;
  mode: 'visual';
}

export interface VisualSquadDeps {
  claude: ClaudeTextClient;
  imageProvider: ImageProvider;
  fallbackProvider?: ImageProvider;
  db: Database;
  now?: () => Date;
}

// ─── Entry point ─────────────────────────────────────────────────────────

export async function runVisualSquad(
  input: RunVisualSquadInput,
  deps: VisualSquadDeps,
): Promise<RunVisualSquadOutput> {
  const started = Date.now();
  const agentTrace: VisualTraceEntry[] = [];

  const inner = runInternal(input, deps, agentTrace);
  const result = await withGlobalTimeout(inner, GLOBAL_TIMEOUT_MS);

  if (result.status === 'timeout') {
    throw new Error(
      `runVisualSquad timed out after ${GLOBAL_TIMEOUT_MS}ms for landingPage=${input.landingPageId}`,
    );
  }
  if (result.status === 'error') {
    throw result.error;
  }

  return {
    visualAssetsId: result.visualAssetsId,
    brand: result.assets.brand,
    assets: result.assets.assets,
    costUsd: agentTrace.reduce((s, t) => s + (t.cost_usd ?? 0), 0),
    durationMs: Date.now() - started,
    agentTrace,
    directorNotes: result.assets.director_notes,
    mode: 'visual',
  };
}

// ─── Internal flow ───────────────────────────────────────────────────────

type InternalResult =
  | { status: 'ok'; visualAssetsId: string; assets: VisualAssets }
  | { status: 'timeout' }
  | { status: 'error'; error: Error };

async function runInternal(
  input: RunVisualSquadInput,
  deps: VisualSquadDeps,
  agentTrace: VisualTraceEntry[],
): Promise<InternalResult> {
  try {
    // 1. Load PIR + CopyDeck if not provided.
    const pir = input.pir
      ? pirSchema.parse(input.pir)
      : await loadPirFromDb(deps.db, input.pirDocumentId);
    const copyDeck = input.copyDeck
      ? validateCopyDeck(input.copyDeck)
      : await loadCopyDeckFromDb(deps.db, input.landingPageId, input.copyDeckIds);

    // Try up to 2 times (Zod-aware retry on validateVisualAssets failure).
    let lastValidationError: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const orchestrationNotes: string[] = [];
      if (lastValidationError) {
        orchestrationNotes.push(`retry-attempt-${attempt}: previous validation failed: ${lastValidationError}`);
      }

      // Phase 1: Visual Director (sequential).
      const directorResult = await runVisualDirector(pir, copyDeck, { claude: deps.claude });
      agentTrace.push(directorResult.trace);
      orchestrationNotes.push(directorResult.notes);

      // Phase 2: 5 agents in parallel with retry.
      const [brandRes, heroRes, lifestyleRes, iconRes, socialRes] = await Promise.allSettled([
        withRetry(
          () =>
            runBrandForge(pir, copyDeck, directorResult.direction, {
              claude: deps.claude,
              primary: deps.imageProvider,
              fallback: deps.fallbackProvider,
            }),
          'brand-forge',
        ),
        withRetry(
          () =>
            runHeroDesigner(pir, copyDeck, directorResult.direction, {
              primary: deps.imageProvider,
              fallback: deps.fallbackProvider,
            }),
          'hero-designer',
        ),
        withRetry(
          () =>
            runLifestyleComposer(pir, copyDeck, directorResult.direction, {
              primary: deps.imageProvider,
              fallback: deps.fallbackProvider,
            }),
          'lifestyle-composer',
        ),
        withRetry(
          () =>
            runIconGenerator(pir, copyDeck, directorResult.direction, {
              primary: deps.imageProvider,
              fallback: deps.fallbackProvider,
            }),
          'icon-generator',
        ),
        withRetry(
          () =>
            runSocialProofDesigner(pir, copyDeck, directorResult.direction, {
              primary: deps.imageProvider,
              fallback: deps.fallbackProvider,
            }),
          'social-proof-designer',
        ),
      ]);

      // Collect traces.
      const brand = unpack(brandRes, 'brand-forge', agentTrace, orchestrationNotes);
      const hero = unpack(heroRes, 'hero-designer', agentTrace, orchestrationNotes);
      const lifestyle = unpack(lifestyleRes, 'lifestyle-composer', agentTrace, orchestrationNotes);
      const icons = unpack(iconRes, 'icon-generator', agentTrace, orchestrationNotes);
      const socialProof = unpack(socialRes, 'social-proof-designer', agentTrace, orchestrationNotes);

      // Hero mandatory abort check.
      const heroDesktop = hero?.urls_by_size?.desktop ?? '';
      const heroMobile = hero?.urls_by_size?.mobile ?? '';
      if (!heroDesktop && !heroMobile) {
        return {
          status: 'error',
          error: new Error(
            `runVisualSquad aborted: hero desktop AND mobile both empty. Notes: ${orchestrationNotes.join('; ')}`,
          ),
        };
      }

      // Assemble VisualAssets.
      const brandData: Brand = {
        name: brand?.name ?? 'NovaLab',
        tagline: brand?.tagline ?? 'The next-gen experience',
        logo_urls: brand?.logo_urls ?? {
          full: 'https://placeholder.landinglab.local/logo-full.png',
          mark: 'https://placeholder.landinglab.local/logo-mark.png',
          wordmark: 'https://placeholder.landinglab.local/logo-wordmark.png',
        },
        palette: directorResult.direction.palette,
        typography: directorResult.direction.typography,
      };

      // Ensure hero has all 3 (schema requires .url() on all).
      const filledHero = fillHeroUrls(hero?.urls_by_size);

      // Ensure minimums for lifestyle (3-5), icons (5-8), trust_badges (2-3).
      const lifestyleUrls = ensureMinLifestyle(lifestyle?.urls ?? []);
      const iconList = ensureMinIcons(icons?.icons ?? [], copyDeck.benefit_bullets.length);
      const badges = ensureMinBadges(socialProof?.trust_badges ?? []);

      const assetsData: Assets = {
        hero: { urls_by_size: filledHero },
        lifestyle: lifestyleUrls,
        icons: iconList,
        trust_badges: badges,
        before_after: (socialProof?.before_after ?? []).length > 0 ? socialProof!.before_after : undefined,
        backgrounds: (socialProof?.backgrounds ?? []).length > 0 ? socialProof!.backgrounds : undefined,
      };

      const contributingAgents: ContributingAgent[] = buildContributingAgents({
        brand,
        hero,
        lifestyle,
        icons,
        socialProof,
      });

      const directorNotes = buildDirectorNotes(orchestrationNotes, {
        brand,
        hero,
        lifestyle,
        icons,
        socialProof,
        direction: directorResult.direction,
      });

      const candidate = {
        schema_version: '1.0.0' as const,
        brand: brandData,
        assets: assetsData,
        contributing_agents: contributingAgents,
        director_notes: directorNotes,
      };

      // Validate.
      try {
        const validated = validateVisualAssets(candidate);
        // Persist.
        const nextVersion = await computeNextVersion(deps.db, input.landingPageId);
        const insertRow: NewLandingVisualAsset = {
          landingPageId: input.landingPageId,
          pirDocumentId: input.pirDocumentId,
          version: nextVersion,
          brand: validated.brand as unknown as NewLandingVisualAsset['brand'],
          assets: validated.assets as unknown as NewLandingVisualAsset['assets'],
          contributingAgents:
            validated.contributing_agents as unknown as NewLandingVisualAsset['contributingAgents'],
          costUsd: String(
            Math.round(agentTrace.reduce((s, t) => s + (t.cost_usd ?? 0), 0) * 10000) / 10000,
          ),
          directorNotes: validated.director_notes,
          generatedByAgent: 'landinglab-visual-director@opus-4-7',
        };
        const [inserted] = await deps.db
          .insert(landingVisualAssets)
          .values(insertRow)
          .returning({ id: landingVisualAssets.id });
        const id = inserted?.id ?? '';
        return { status: 'ok', visualAssetsId: id, assets: validated };
      } catch (err) {
        if (err instanceof VisualAssetsValidationError) {
          lastValidationError = err.message;
          if (attempt === 0) continue; // retry once
        }
        return {
          status: 'error',
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    }

    return {
      status: 'error',
      error: new Error(
        `runVisualSquad failed validation after 2 attempts. Last error: ${lastValidationError ?? 'unknown'}`,
      ),
    };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err : new Error(String(err)) };
  }
}

// ─── DB loading ──────────────────────────────────────────────────────────

async function loadPirFromDb(db: Database, pirDocumentId: string): Promise<Pir> {
  const rows = await db
    .select({ content: landingPirDocuments.content })
    .from(landingPirDocuments)
    .where(eq(landingPirDocuments.id, pirDocumentId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(`PIR document not found: ${pirDocumentId}`);
  }
  return pirSchema.parse(row.content);
}

async function loadCopyDeckFromDb(
  db: Database,
  landingPageId: string,
  copyDeckIds: string[],
): Promise<CopyDeck> {
  // Prefer EN deck for that landingPageId. Fallback to first available.
  const rows = await db
    .select({ id: landingCopyDecks.id, content: landingCopyDecks.content, language: landingCopyDecks.language })
    .from(landingCopyDecks)
    .where(eq(landingCopyDecks.landingPageId, landingPageId));
  if (rows.length === 0) {
    throw new Error(`No CopyDeck found for landingPageId=${landingPageId}`);
  }
  // Prefer 'en'; else use the one matching first copyDeckId; else first row.
  const en = rows.find((r) => r.language === 'en');
  const byId = copyDeckIds[0] ? rows.find((r) => r.id === copyDeckIds[0]) : undefined;
  const row = en ?? byId ?? rows[0]!;
  return validateCopyDeck(row.content);
}

async function computeNextVersion(db: Database, landingPageId: string): Promise<number> {
  const rows = await db
    .select({ version: landingVisualAssets.version })
    .from(landingVisualAssets)
    .where(eq(landingVisualAssets.landingPageId, landingPageId))
    .orderBy(desc(landingVisualAssets.version))
    .limit(1);
  const max = rows[0]?.version ?? 0;
  return max + 1;
}

// ─── Retry / unpack helpers ──────────────────────────────────────────────

type AgentOutput<T> = T & { notes: string[]; placeholderUsed: boolean; traces: VisualTraceEntry[] };

async function withRetry<T>(
  fn: () => Promise<AgentOutput<T>>,
  agentName: VisualAgentName,
): Promise<AgentOutput<T>> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= AGENT_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < AGENT_MAX_RETRIES) {
        await sleep(Math.min(RETRY_CAP_MS, RETRY_BASE_MS * Math.pow(2, attempt)));
      }
    }
  }
  // Rethrow so Promise.allSettled captures it.
  throw new Error(`Agent "${agentName}" failed after ${AGENT_MAX_RETRIES + 1} attempts: ${lastErr?.message ?? 'unknown'}`);
}

function unpack<T>(
  settled: PromiseSettledResult<AgentOutput<T>>,
  agentName: VisualAgentName,
  agentTrace: VisualTraceEntry[],
  orchestrationNotes: string[],
): AgentOutput<T> | null {
  if (settled.status === 'fulfilled') {
    agentTrace.push(...settled.value.traces);
    if (settled.value.notes.length > 0) {
      orchestrationNotes.push(`[${agentName}] ${settled.value.notes.join('; ')}`);
    }
    if (settled.value.placeholderUsed) {
      orchestrationNotes.push(`[${agentName}] placeholder URLs used (higgsfield fallback without endpoint)`);
    }
    return settled.value;
  }
  const err = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
  orchestrationNotes.push(`[${agentName}] REJECTED: ${err}`);
  agentTrace.push({
    agent: agentName,
    provider: 'none',
    cost_usd: 0,
    latency_ms: 0,
    error: err,
  });
  return null;
}

// ─── Assembly helpers ────────────────────────────────────────────────────

function fillHeroUrls(input: Partial<Assets['hero']['urls_by_size']> | undefined): Assets['hero']['urls_by_size'] {
  const desktop = input?.desktop ?? '';
  const og = input?.og ?? '';
  const mobile = input?.mobile ?? '';
  const fallback = desktop || mobile || og || 'https://placeholder.landinglab.local/hero.png';
  return {
    desktop: desktop || fallback,
    og: og || fallback,
    mobile: mobile || fallback,
  };
}

function ensureMinLifestyle(urls: string[]): string[] {
  const min = 3;
  const max = 5;
  const trimmed = urls.slice(0, max);
  while (trimmed.length < min) {
    // Clone last available, or placeholder if empty.
    const clone = trimmed[trimmed.length - 1] ?? 'https://placeholder.landinglab.local/lifestyle.png';
    trimmed.push(clone);
  }
  return trimmed;
}

function ensureMinIcons(icons: Array<{ url: string; matches_bullet: number }>, bulletCount: number): Array<{ url: string; matches_bullet: number }> {
  const min = 5;
  const max = 8;
  const target = Math.max(min, Math.min(bulletCount, max));
  const trimmed = icons.slice(0, max);
  while (trimmed.length < target) {
    const clone = trimmed[trimmed.length - 1]?.url ?? 'https://placeholder.landinglab.local/icon.png';
    trimmed.push({ url: clone, matches_bullet: trimmed.length });
  }
  return trimmed;
}

function ensureMinBadges(urls: string[]): string[] {
  const min = 2;
  const max = 3;
  const trimmed = urls.slice(0, max);
  while (trimmed.length < min) {
    const clone = trimmed[trimmed.length - 1] ?? 'https://placeholder.landinglab.local/badge.png';
    trimmed.push(clone);
  }
  return trimmed;
}

function buildContributingAgents(inputs: {
  brand: unknown;
  hero: unknown;
  lifestyle: unknown;
  icons: unknown;
  socialProof: unknown;
}): ContributingAgent[] {
  const entries: ContributingAgent[] = [
    { agent: 'visual-director', blocks_contributed: ['palette', 'typography', 'director_notes'] },
  ];
  if (inputs.brand) {
    entries.push({ agent: 'brand-forge', blocks_contributed: ['brand.name', 'brand.tagline', 'brand.logo_urls'] });
  }
  if (inputs.hero) {
    entries.push({ agent: 'hero-designer', blocks_contributed: ['assets.hero'] });
  }
  if (inputs.lifestyle) {
    entries.push({ agent: 'lifestyle-composer', blocks_contributed: ['assets.lifestyle'] });
  }
  if (inputs.icons) {
    entries.push({ agent: 'icon-generator', blocks_contributed: ['assets.icons'] });
  }
  if (inputs.socialProof) {
    entries.push({
      agent: 'social-proof-designer',
      blocks_contributed: ['assets.trust_badges', 'assets.before_after', 'assets.backgrounds'],
    });
  }
  return entries;
}

function buildDirectorNotes(
  orchestrationNotes: string[],
  ctx: {
    brand: unknown;
    hero: unknown;
    lifestyle: unknown;
    icons: unknown;
    socialProof: unknown;
    direction: VisualDirection;
  },
): string {
  const parts: string[] = [];
  parts.push(
    `Squad 3 assembled with tone="${ctx.direction.tone_descriptor}", headline_font=${ctx.direction.typography.headline_font}, body_font=${ctx.direction.typography.body_font}.`,
  );
  const failed: string[] = [];
  if (!ctx.brand) failed.push('brand-forge');
  if (!ctx.hero) failed.push('hero-designer');
  if (!ctx.lifestyle) failed.push('lifestyle-composer');
  if (!ctx.icons) failed.push('icon-generator');
  if (!ctx.socialProof) failed.push('social-proof-designer');
  if (failed.length > 0) {
    parts.push(`Agents that failed completely: ${failed.join(', ')}.`);
  }
  if (orchestrationNotes.length > 0) {
    parts.push('Details:');
    parts.push(orchestrationNotes.join(' | '));
  }
  return parts.join(' ').slice(0, 4000); // cap length for DB safety
}

// ─── Global timeout wrapper ─────────────────────────────────────────────

async function withGlobalTimeout(
  inner: Promise<InternalResult>,
  timeoutMs: number,
): Promise<InternalResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<InternalResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
  });
  try {
    return await Promise.race([inner, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
