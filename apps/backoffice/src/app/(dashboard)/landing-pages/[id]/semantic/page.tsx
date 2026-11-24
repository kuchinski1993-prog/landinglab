// /landing-pages/[id]/semantic — Fase 12.1 Editor V1 Semantic Shell (read-only).
//
// Server component: chama computePageSemanticModel direto (não via HTTP)
// pra evitar double-auth. Passa o model + landing pro client component.
//
// Feature flag: LANDINGLAB_SEMANTIC_EDITOR=true (default OFF).
// Quando OFF, página retorna notFound() → 404 (rota "não existe").

import { notFound } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';

import { landingPages } from '@blackshop/db';
import {
  computePageSemanticModel,
  createAdapterRegistry,
  createSharedDetectorRegistry,
  kachingAdapter,
  accordionDetector,
  articleDetector,
  footerDetector,
  shopifyCtaDetector,
  type ImageOcrMetadataEntry,
  type PageFamily,
  type PageSemanticModel,
} from '@blackshop/landinglab-adapters';
import { getDb } from '@/lib/landing-db';
import { requireSession } from '@/lib/session';

import SemanticShellPanel from './SemanticShellPanel';

export const dynamic = 'force-dynamic';

const STORE_ID = 'l0i';

function isFeatureEnabled(): boolean {
  return process.env['LANDINGLAB_SEMANTIC_EDITOR'] === 'true';
}

function mapLandingKindToPageFamily(
  kind: string | null | undefined,
): PageFamily | null {
  if (kind === 'sales_page') return 'sales_page';
  if (kind === 'advertorial') return 'advertorial';
  if (kind === 'pdp_derived') return 'pdp_derived';
  return null;
}

// Cache de registries a nível de módulo (frozen, sem risco de leak).
let cachedAdapterRegistry: ReturnType<typeof createAdapterRegistry> | null = null;
let cachedSharedRegistry: ReturnType<typeof createSharedDetectorRegistry> | null = null;

function getAdapterRegistry() {
  if (cachedAdapterRegistry) return cachedAdapterRegistry;
  const r = createAdapterRegistry();
  r.register(kachingAdapter);
  r.freeze();
  cachedAdapterRegistry = r;
  return r;
}

function getSharedRegistry() {
  if (cachedSharedRegistry) return cachedSharedRegistry;
  const r = createSharedDetectorRegistry();
  r.register(shopifyCtaDetector);
  r.register(articleDetector);
  r.register(accordionDetector);
  r.register(footerDetector);
  r.freeze();
  cachedSharedRegistry = r;
  return r;
}

interface Props {
  params: { id: string };
}

export default async function SemanticEditorPage({ params }: Props): Promise<JSX.Element> {
  // Auth: página SSR → cookie session (via requireSession).
  // NÃO usa assertAdmin porque essa é page-level (middleware já filtrou).
  requireSession(`/landing-pages/${params.id}/semantic`);

  if (!isFeatureEnabled()) {
    // Feature OFF → 404
    notFound();
  }

  const db = getDb();
  const [row] = await db
    .select({
      id: landingPages.id,
      slug: landingPages.slug,
      title: landingPages.title,
      htmlBody: landingPages.htmlBody,
      landingKind: landingPages.landingKind,
      imageOcrMetadata: landingPages.imageOcrMetadata,
      currency: landingPages.currency,
    })
    .from(landingPages)
    .where(and(eq(landingPages.id, params.id), eq(landingPages.storeId, STORE_ID)))
    .limit(1);

  if (!row || !row.htmlBody) {
    notFound();
  }

  const ocrMetadata = Array.isArray(row.imageOcrMetadata)
    ? (row.imageOcrMetadata as ImageOcrMetadataEntry[])
    : undefined;

  let model: PageSemanticModel;
  let mapperError: string | null = null;
  const startedAt = Date.now();
  try {
    model = computePageSemanticModel({
      html: row.htmlBody,
      landingPageId: row.id,
      userHint: mapLandingKindToPageFamily(row.landingKind),
      adapterRegistry: getAdapterRegistry(),
      sharedRegistry: getSharedRegistry(),
      ...(ocrMetadata ? { ocrMetadata } : {}),
      computedAt: new Date().toISOString(),
    });
  } catch (err) {
    mapperError = err instanceof Error ? err.message : String(err);
    model = {
      computedAt: new Date().toISOString(),
      family: 'unknown',
      familySource: 'default_unknown',
      familyConfidence: 0,
      familyClassifier: {
        family: 'unknown',
        familySource: 'default_unknown',
        familyConfidence: 0,
        familyResolution: 'unknown',
        candidates: [],
        warnings: [],
        reasons: [mapperError],
      },
      themeCandidates: [],
      components: [],
      regions: [],
      editableFields: [],
      imageSlots: [],
      textBlocks: [],
      unclassified: [],
      warnings: [
        {
          severity: 'error',
          code: 'semantic_mapper_fatal_ssr',
          message: mapperError,
        },
      ],
      conflicts: [],
      overallConfidence: 0,
      criticalRegionsHealthy: false,
      meta: { detectorsRun: 0, adaptersConsulted: 0, warningsCount: 1, conflictsCount: 0 },
    };
  }
  const latencyMs = Date.now() - startedAt;

  const htmlSha = crypto
    .createHash('sha256')
    .update(row.htmlBody, 'utf8')
    .digest('hex')
    .slice(0, 16);

  const semanticWritesEnabled = process.env['LANDINGLAB_SEMANTIC_WRITES'] === 'true';

  return (
    <SemanticShellPanel
      landing={{
        id: row.id,
        slug: row.slug,
        title: row.title,
        landingKind: row.landingKind,
        currency: row.currency,
        htmlBytes: row.htmlBody.length,
      }}
      model={model}
      meta={{ latencyMs, mapperError }}
      htmlSha={htmlSha}
      semanticWritesEnabled={semanticWritesEnabled}
    />
  );
}
