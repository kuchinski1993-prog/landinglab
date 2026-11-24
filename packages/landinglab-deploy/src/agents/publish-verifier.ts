// Publish Verifier — Squad 5 Deploy Agent (AC17).
//
// Story 13.8 Wave 2 — 4-check HTTP health verification on the live URL.
//
// Reads hero_title from landing_copy_decks.content.hooks[0] (per Wave 1
// [AUTO-DECISION] — landing_pages has no hero_title column). Fallback:
// if copy_deck JOIN returns nothing, degrade to checking <h1> presence
// and record a warning in deployment_metadata.warnings.

import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '@blackshop/db';
import { landingCopyDecks } from '@blackshop/db';

export interface PublishVerifierDeps {
  db: Database;
  httpClient?: (url: string, opts?: RequestInit) => Promise<Response>;
}

export interface PublishVerifierInput {
  landingPageId: string;
  hostname: string;
  contentLanguage: string;
}

export interface PublishVerifierOutput {
  ok: true;
  healthCheckPassed: boolean;
  status: number;
  checksPassed: string[];
  checksFailed: string[];
  responseTimeMs: number;
  verifiedAt: string;
  /** Populated when hero_title JOIN returns nothing (fallback to <h1> check). */
  warning?: string;
}

const HTTP_TIMEOUT_MS = 10_000;

const CHECK_STATUS_200 = 'status_200';
const CHECK_HERO_TITLE = 'hero_title_present';
const CHECK_H1_PRESENT = 'h1_present_fallback';
const CHECK_OG_TITLE = 'og_title_present';
const CHECK_NOT_NOINDEX = 'not_noindex';

export async function runPublishVerifier(
  input: PublishVerifierInput,
  deps: PublishVerifierDeps,
): Promise<PublishVerifierOutput> {
  const url = `https://${input.hostname}`;
  const httpClient = deps.httpClient ?? fetch;

  const heroTitle = await loadHeroTitle(deps.db, input.landingPageId, input.contentLanguage);

  const checksPassed: string[] = [];
  const checksFailed: string[] = [];
  let status = -1;
  let body = '';
  let warning: string | undefined;

  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    const response = await httpClient(url, { signal: controller.signal });
    clearTimeout(timer);
    status = response.status;
    body = await response.text();
  } catch (err) {
    const elapsedFail = Date.now() - started;
    checksFailed.push(CHECK_STATUS_200);
    return {
      ok: true,
      healthCheckPassed: false,
      status,
      checksPassed: [],
      checksFailed: [CHECK_STATUS_200, `error:${(err as Error).message}`],
      responseTimeMs: elapsedFail,
      verifiedAt: new Date().toISOString(),
    };
  }
  const responseTimeMs = Date.now() - started;

  // 1. Status 200.
  if (status === 200) {
    checksPassed.push(CHECK_STATUS_200);
  } else {
    checksFailed.push(CHECK_STATUS_200);
  }

  // 2. Hero title (or <h1> fallback).
  if (heroTitle) {
    if (body.includes(heroTitle)) {
      checksPassed.push(CHECK_HERO_TITLE);
    } else {
      checksFailed.push(CHECK_HERO_TITLE);
    }
  } else {
    warning = 'no_copy_deck_hero_fallback_h1';
    if (/<h1[\s>]/i.test(body)) {
      checksPassed.push(CHECK_H1_PRESENT);
    } else {
      checksFailed.push(CHECK_H1_PRESENT);
    }
  }

  // 3. Open Graph meta.
  if (/<meta\s+property=["']og:title["']/i.test(body)) {
    checksPassed.push(CHECK_OG_TITLE);
  } else {
    checksFailed.push(CHECK_OG_TITLE);
  }

  // 4. No noindex.
  if (/<meta\s+name=["']robots["']\s+content=["'][^"']*noindex/i.test(body)) {
    checksFailed.push(CHECK_NOT_NOINDEX);
  } else {
    checksPassed.push(CHECK_NOT_NOINDEX);
  }

  const healthCheckPassed = checksFailed.length === 0;

  return {
    ok: true,
    healthCheckPassed,
    status,
    checksPassed,
    checksFailed,
    responseTimeMs,
    verifiedAt: new Date().toISOString(),
    warning,
  };
}

async function loadHeroTitle(
  db: Database,
  landingPageId: string,
  contentLanguage: string,
): Promise<string | null> {
  const rows = await db
    .select({ content: landingCopyDecks.content })
    .from(landingCopyDecks)
    .where(
      and(
        eq(landingCopyDecks.landingPageId, landingPageId),
        eq(landingCopyDecks.language, contentLanguage),
      ),
    )
    .orderBy(desc(landingCopyDecks.version))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const content = row.content as unknown;
  if (!content || typeof content !== 'object') return null;
  const hooks = (content as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks) || hooks.length === 0) return null;
  const first = hooks[0];
  if (first && typeof first === 'object' && typeof (first as { text?: unknown }).text === 'string') {
    return (first as { text: string }).text;
  }
  return null;
}
