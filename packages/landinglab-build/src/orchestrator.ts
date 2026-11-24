// runBuildSquad — orchestrator for Squad 4 (Build HTML). Wave 2 real impl.
//
// Flow (Wave 2):
//   1. Load PIR (landing_pir_documents) + base landing_page row.
//   2. Load VisualAssets — try by visualAssetsId; fallback to latest version
//      for the landingPageId.
//   3. Loop per language in input.languages (guarded by GLOBAL_TIMEOUT_MS):
//        a. Load CopyDeck for language.
//        b. runBuildChief() — 5 deterministic agents + optional Haiku SEO.
//        c. Persist: UPDATE for EN base; INSERT (upsert on store_id+slug) for variants.
//   4. Aggregate cost + trace across languages. Retry each language once on failure.
//
// Article IV: build_metadata.generation_notes is always populated with a
// human-readable audit trail (template used, reasoning, SEO scores, htmlSize).

import { desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '@blackshop/db';
import {
  landingPirDocuments,
  landingCopyDecks,
  landingVisualAssets,
  landingPages,
  type NewLandingPage,
} from '@blackshop/db';
import { pirSchema, type Pir } from '@blackshop/landinglab-research';
import { validateCopyDeck, type CopyDeck } from '@blackshop/landinglab-copy';
import type { VisualAssets } from '@blackshop/landinglab-visual';
import { VisualAssetsSchema } from '@blackshop/landinglab-visual';

import { runBuildChief } from './agents/build-chief.js';
import type { ClaudeHaikuClient } from './providers/claude-haiku.js';
import type { TemplateName } from './schema/build-output.js';

// ─── Config ──────────────────────────────────────────────────────────────

const GLOBAL_TIMEOUT_MS = 120_000;
const PER_LANGUAGE_MAX_RETRIES = 1;

// ─── Public types ────────────────────────────────────────────────────────

export interface RunBuildSquadInput {
  /** UUID of the base landing page (EN row). */
  landingPageId: string;
  /** UUID of the PIR that originated this pipeline. */
  pirDocumentId: string;
  /** UUIDs of the copy decks (one per language). */
  copyDeckIds: string[];
  /** UUID of the visual assets bundle (Squad 3 output). */
  visualAssetsId: string;
  /** ISO 639-1 language codes to build (e.g. ['en', 'de']). EN is base. */
  languages: string[];
  /** Optional canonical base URL — used to compose canonical + hreflang. */
  baseUrl?: string;
}

export interface BuildTraceEntry {
  agent: string;
  language: string;
  cost_usd: number;
  latency_ms: number;
  provider?: string;
  tokens_in?: number;
  tokens_out?: number;
  error?: string;
  notes?: string;
}

export interface RunBuildSquadOutput {
  ok: true;
  /** UUIDs of all landing_pages rows written (base updated + variants inserted). */
  languageVariantIds: string[];
  /** Which languages actually generated HTML successfully. */
  languagesGenerated: string[];
  costUsd: number;
  durationMs: number;
  agentTrace: BuildTraceEntry[];
}

export interface BuildSquadDeps {
  db: Database;
  haiku: ClaudeHaikuClient;
  now?: () => Date;
}

// ─── Entry point ─────────────────────────────────────────────────────────

export async function runBuildSquad(
  input: RunBuildSquadInput,
  deps: BuildSquadDeps,
): Promise<RunBuildSquadOutput> {
  const started = Date.now();
  const trace: BuildTraceEntry[] = [];
  const languageVariantIds: string[] = [];
  const languagesGenerated: string[] = [];

  const inner = runInternal(input, deps, trace, languageVariantIds, languagesGenerated);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(
            `runBuildSquad timed out after ${GLOBAL_TIMEOUT_MS}ms for landingPage=${input.landingPageId}`,
          ),
        ),
      GLOBAL_TIMEOUT_MS,
    ),
  );

  await Promise.race([inner, timeoutPromise]);

  const costUsd = trace.reduce((s, t) => s + (t.cost_usd ?? 0), 0);
  return {
    ok: true,
    languageVariantIds,
    languagesGenerated,
    costUsd,
    durationMs: Date.now() - started,
    agentTrace: trace,
  };
}

// ─── Internal flow ───────────────────────────────────────────────────────

async function runInternal(
  input: RunBuildSquadInput,
  deps: BuildSquadDeps,
  trace: BuildTraceEntry[],
  languageVariantIds: string[],
  languagesGenerated: string[],
): Promise<void> {
  // 1. Load PIR.
  const pir = await loadPir(deps.db, input.pirDocumentId);

  // 2. Load base landing_page row (needs store_id + slug for INSERT/UPDATE).
  const base = await loadBaseLandingPage(deps.db, input.landingPageId);

  // 3. Load VisualAssets (by id preferred; fallback to latest for landingPageId).
  const visualAssets = await loadVisualAssets(
    deps.db,
    input.visualAssetsId,
    input.landingPageId,
  );

  // 4. Prefetch all CopyDecks (one query).
  const copyDeckRows = await loadCopyDecks(deps.db, input.copyDeckIds, input.landingPageId);

  // 5. Iterate languages (sequential — keeps global timeout predictable).
  for (const lang of input.languages) {
    const cd = pickCopyDeck(copyDeckRows, lang);
    if (!cd) {
      trace.push({
        agent: 'build-chief',
        language: lang,
        cost_usd: 0,
        latency_ms: 0,
        error: `no CopyDeck for language=${lang}`,
      });
      continue;
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= PER_LANGUAGE_MAX_RETRIES; attempt++) {
      try {
        // Sticky CTA precisa formatar preço — "EUR 69,95" pt-BR-style.
        const priceNum = Number(base.price);
        const priceDisplay =
          Number.isFinite(priceNum) && priceNum > 0
            ? `${base.currency} ${priceNum.toFixed(2).replace('.', ',')}`
            : undefined;
        const chiefResult = await runBuildChief({
          pir,
          copyDeck: cd,
          visualAssets,
          language: lang,
          variantLangs: input.languages,
          parentSlug: base.slug,
          baseUrl: input.baseUrl,
          haiku: deps.haiku,
          mediaUrls: base.mediaUrls,
          ...(priceDisplay !== undefined ? { priceDisplay } : {}),
          // useDynamicBlocks default = true (Fase 3).
        });

        for (const entry of chiefResult.trace) trace.push(entry as BuildTraceEntry);

        const persistedId = await persistHtml({
          db: deps.db,
          language: lang,
          baseLandingPageId: input.landingPageId,
          baseStoreId: base.storeId,
          baseSlug: base.slug,
          html: chiefResult.html,
          templateUsed: chiefResult.template_used,
          generationNotes: chiefResult.generation_notes,
          seoScores: chiefResult.seo_scores,
          languages: input.languages,
          pir,
        });

        languageVariantIds.push(persistedId);
        languagesGenerated.push(lang);
        lastError = null;
        break; // success — exit retry loop
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt >= PER_LANGUAGE_MAX_RETRIES) {
          trace.push({
            agent: 'build-chief',
            language: lang,
            cost_usd: 0,
            latency_ms: 0,
            error: lastError.message,
          });
        }
      }
    }
  }
}

// ─── DB loading helpers ──────────────────────────────────────────────────

async function loadPir(db: Database, pirDocumentId: string): Promise<Pir> {
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

interface BaseLandingPage {
  id: string;
  storeId: string;
  slug: string;
  contentLanguage: string | null;
  // Fase 3 (layout-planner): gallery block usa mediaUrls do Firecrawl scrape.
  mediaUrls: string[];
  // Sticky CTA precisa mostrar preço formatado ("EUR 69,95").
  price: string;
  currency: string;
}

async function loadBaseLandingPage(
  db: Database,
  landingPageId: string,
): Promise<BaseLandingPage> {
  const rows = await db
    .select({
      id: landingPages.id,
      storeId: landingPages.storeId,
      slug: landingPages.slug,
      contentLanguage: landingPages.contentLanguage,
      mediaUrls: landingPages.mediaUrls,
      price: landingPages.price,
      currency: landingPages.currency,
    })
    .from(landingPages)
    .where(eq(landingPages.id, landingPageId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(`Landing page not found: ${landingPageId}`);
  }
  return {
    id: row.id,
    storeId: row.storeId,
    slug: row.slug,
    contentLanguage: row.contentLanguage ?? null,
    mediaUrls: Array.isArray(row.mediaUrls) ? row.mediaUrls : [],
    price: row.price,
    currency: row.currency,
  };
}

async function loadVisualAssets(
  db: Database,
  visualAssetsId: string,
  landingPageId: string,
): Promise<VisualAssets> {
  // Try by id first.
  const byId = await db
    .select({
      brand: landingVisualAssets.brand,
      assets: landingVisualAssets.assets,
      contributingAgents: landingVisualAssets.contributingAgents,
      directorNotes: landingVisualAssets.directorNotes,
    })
    .from(landingVisualAssets)
    .where(eq(landingVisualAssets.id, visualAssetsId))
    .limit(1);

  let row = byId[0];
  if (!row) {
    // Fallback: latest version for landingPageId.
    const fallback = await db
      .select({
        brand: landingVisualAssets.brand,
        assets: landingVisualAssets.assets,
        contributingAgents: landingVisualAssets.contributingAgents,
        directorNotes: landingVisualAssets.directorNotes,
      })
      .from(landingVisualAssets)
      .where(eq(landingVisualAssets.landingPageId, landingPageId))
      .orderBy(desc(landingVisualAssets.version))
      .limit(1);
    row = fallback[0];
  }
  if (!row) {
    throw new Error(
      `VisualAssets not found: id=${visualAssetsId} landingPageId=${landingPageId}`,
    );
  }
  return VisualAssetsSchema.parse({
    schema_version: '1.0.0',
    brand: row.brand,
    assets: row.assets,
    contributing_agents: row.contributingAgents ?? [],
    director_notes: row.directorNotes ?? 'legacy row without director_notes',
  });
}

interface CopyDeckRow {
  id: string;
  language: string;
  content: unknown;
}

async function loadCopyDecks(
  db: Database,
  copyDeckIds: string[],
  landingPageId: string,
): Promise<CopyDeckRow[]> {
  if (copyDeckIds.length > 0) {
    const rows = await db
      .select({
        id: landingCopyDecks.id,
        language: landingCopyDecks.language,
        content: landingCopyDecks.content,
      })
      .from(landingCopyDecks)
      .where(inArray(landingCopyDecks.id, copyDeckIds));
    if (rows.length > 0) return rows;
  }
  // Fallback: all decks for the landing page.
  return db
    .select({
      id: landingCopyDecks.id,
      language: landingCopyDecks.language,
      content: landingCopyDecks.content,
    })
    .from(landingCopyDecks)
    .where(eq(landingCopyDecks.landingPageId, landingPageId));
}

function pickCopyDeck(rows: CopyDeckRow[], language: string): CopyDeck | null {
  const match = rows.find((r) => r.language === language);
  if (!match) return null;
  try {
    return validateCopyDeck(match.content);
  } catch {
    return null;
  }
}

// ─── Persistence ─────────────────────────────────────────────────────────

interface PersistInput {
  db: Database;
  language: string;
  baseLandingPageId: string;
  baseStoreId: string;
  baseSlug: string;
  html: string;
  templateUsed: TemplateName;
  generationNotes: string;
  seoScores: { meta_length: number; jsonld_present: boolean; hreflang_count: number };
  languages: string[];
  pir: Pir;
}

async function persistHtml(input: PersistInput): Promise<string> {
  const {
    db,
    language,
    baseLandingPageId,
    baseStoreId,
    baseSlug,
    html,
    templateUsed,
    generationNotes,
    seoScores,
  } = input;

  const buildMetadata = {
    template_used: templateUsed,
    generation_notes: generationNotes,
    agents_used: [
      'template-selector',
      'content-composer',
      'html-builder',
      'seo-optimizer',
      'performance-optimizer',
      'build-chief',
    ],
    seo_scores: seoScores,
  };

  // EN = base row → UPDATE.
  if (language === 'en') {
    const updated = await db
      .update(landingPages)
      .set({
        htmlBody: html,
        buildMetadata: buildMetadata as unknown as NewLandingPage['buildMetadata'],
        contentLanguage: 'en',
        updatedAt: new Date(),
      })
      .where(eq(landingPages.id, baseLandingPageId))
      .returning({ id: landingPages.id });
    const id = updated[0]?.id ?? baseLandingPageId;
    return id;
  }

  // Non-EN → INSERT variant row with upsert on (store_id, slug).
  // Guard: if baseSlug already ends with the language suffix, don't duplicate.
  const langSuffix = `-${language}`;
  const variantSlug = baseSlug.endsWith(langSuffix) ? baseSlug : `${baseSlug}${langSuffix}`;

  const insertRow: NewLandingPage = {
    storeId: baseStoreId,
    slug: variantSlug,
    title: `${input.pir.identity.name} (${language.toUpperCase()})`,
    status: 'draft',
    // Currency + fulfillment mirror base — but base fields aren't loaded to
    // avoid schema drift. Use safe defaults (Wave 3 backoffice sets these
    // explicitly at creation time).
    currency: input.pir.identity.currency ?? 'USD',
    fulfillmentType: 'dropship',
    htmlBody: html,
    price: String(input.pir.identity.price ?? 0),
    buildMetadata: buildMetadata as unknown as NewLandingPage['buildMetadata'],
    contentLanguage: language as unknown as NewLandingPage['contentLanguage'],
    parentLandingPageId: baseLandingPageId,
    generationMode: 'autopilot',
  };

  const result = await db
    .insert(landingPages)
    .values(insertRow)
    .onConflictDoUpdate({
      target: [landingPages.storeId, landingPages.slug],
      set: {
        htmlBody: html,
        buildMetadata: buildMetadata as unknown as NewLandingPage['buildMetadata'],
        contentLanguage: language as unknown as NewLandingPage['contentLanguage'],
        parentLandingPageId: baseLandingPageId,
        updatedAt: new Date(),
      },
    })
    .returning({ id: landingPages.id });

  return result[0]?.id ?? '';
}

