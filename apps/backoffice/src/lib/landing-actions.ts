'use server';

// Server actions CRUD pra landing_pages.
//
// TODO(pós-13.7): quando existirem endpoints REST em apps/api (/api/landinglab/*),
// refatorar essas actions pra fazer proxy pros endpoints ao invés de bater
// direto no Drizzle. Story 13.2 opta por Drizzle direto pra evitar duplicar
// esforço antes da 13.7 chegar (decisão SM registrada na 13.2 §Dev Notes).

import { and, desc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

import { landingPages } from '@blackshop/db/schema-landinglab-core';
import { landingDeployments, landingGenerationRuns, landingVisualAssets } from '@blackshop/db';
import { normalizeCheckoutProvider } from '@blackshop/shared/external-checkout';

import { getDb } from './landing-db';
import {
  AI_SQUADS,
  ALLOWED_CURRENCIES,
  FULFILLMENT_TYPES,
  LANDING_STATUSES,
  type ActionResult,
  type AiSquad,
  type LandingPageInput,
  type LandingPageRow,
  type LandingPageSummary,
  type LandingStatus,
  type ListLandingsFilters,
  type ListLandingsResult,
  type ListLandingsSummaryResult,
  type SquadStatus,
} from './landing-types';

// STORE_ID immutable — retained for DB compatibility with rows created before
// rename (Story 13.7). Same policy as migrations 0045/0046 filenames.
const STORE_ID = 'l0i';

// ─── Validação básica (defesa em profundidade) ──────────────────────────────
// Client já valida, mas server nunca confia — evita 500 caso alguém bata
// direto na action via devtools ou script.

function validate(input: LandingPageInput): { ok: true } | { ok: false; message: string } {
  if (!input.title.trim()) return { ok: false, message: 'Título é obrigatório.' };
  if (!input.slug.trim()) return { ok: false, message: 'Slug é obrigatório.' };
  if (!input.htmlBody.trim()) return { ok: false, message: 'Conteúdo HTML é obrigatório.' };
  if (!input.price || Number.isNaN(Number(input.price))) {
    return { ok: false, message: 'Preço é obrigatório.' };
  }
  if (!ALLOWED_CURRENCIES.includes(input.currency)) {
    return { ok: false, message: `Moeda inválida (permitidas: ${ALLOWED_CURRENCIES.join(', ')}).` };
  }
  if (!FULFILLMENT_TYPES.includes(input.fulfillmentType)) {
    return { ok: false, message: 'Fulfillment type inválido.' };
  }
  if (!LANDING_STATUSES.includes(input.status)) {
    return { ok: false, message: 'Status inválido.' };
  }
  // Slug precisa ser url-safe (letras, dígitos, hífen).
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(input.slug)) {
    return {
      ok: false,
      message: 'Slug deve conter apenas letras minúsculas, números e hífens.',
    };
  }
  return { ok: true };
}

// Postgres unique_violation error code.
const PG_UNIQUE_VIOLATION = '23505';

function isDuplicateSlugError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const record = err as Record<string, unknown>;
  return record['code'] === PG_UNIQUE_VIOLATION;
}

// ─── Read ───────────────────────────────────────────────────────────────────

export async function getLandingPages(
  filters: ListLandingsFilters = {},
): Promise<ListLandingsResult> {
  const db = getDb();
  const { status, q, limit = 20, offset = 0 } = filters;
  const conditions = [eq(landingPages.storeId, STORE_ID)];
  if (status && status !== 'all') {
    conditions.push(eq(landingPages.status, status));
  }
  if (q && q.trim()) {
    const term = `%${q.trim()}%`;
    const searchCondition = or(
      ilike(landingPages.title, term),
      ilike(landingPages.slug, term),
    );
    if (searchCondition) conditions.push(searchCondition);
  }
  const where = and(...conditions);

  const [items, totalRow] = await Promise.all([
    db
      .select()
      .from(landingPages)
      .where(where)
      .orderBy(desc(landingPages.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(landingPages)
      .where(where),
  ]);

  return {
    items: items.map(rowToDto),
    total: totalRow[0]?.count ?? 0,
  };
}

// UUID v4 format (accepts any version). Postgres casts strings to uuid strictly —
// passing a non-UUID slug to eq(id, ...) throws "invalid input syntax for type uuid".
// We branch here so getLandingPage aceita tanto UUID quanto slug transparentemente.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Summary (grid de cards) ────────────────────────────────────────────────
// Retorna landings + progresso IA agregado + hero image (thumbnail).
// Otimizado pra listagem: NÃO puxa htmlBody/customCss (blobs pesados).

// Schema JSON de landing_visual_assets.assets — só o pedaço que precisamos aqui.
interface VisualAssetsJson {
  hero?: {
    urls_by_size?: {
      desktop?: string;
      mobile?: string;
      og?: string;
    };
  };
}

function pickHeroUrl(assets: unknown): string | null {
  if (typeof assets !== 'object' || assets === null) return null;
  const typed = assets as VisualAssetsJson;
  return typed.hero?.urls_by_size?.desktop ?? typed.hero?.urls_by_size?.mobile ?? null;
}

// Mapeia squad name do DB (canônico) pra chave do enum AI_SQUADS.
// GENERATION_SQUADS no schema-landinglab.ts define nomes canônicos.
function normalizeSquadName(raw: string): AiSquad | null {
  const map: Record<string, AiSquad> = {
    product_research: 'product_research',
    copy: 'copy',
    visual: 'visual',
    build_html: 'build_html',
    build: 'build_html', // legacy fallback
    deploy: 'deploy',
  };
  return map[raw] ?? null;
}

function mapDbStatusToSquadStatus(dbStatus: string): SquadStatus {
  if (dbStatus === 'completed') return 'completed';
  if (dbStatus === 'failed') return 'failed';
  if (dbStatus === 'running' || dbStatus === 'pending') return 'running';
  return 'idle';
}

export async function getLandingPagesSummary(
  filters: ListLandingsFilters = {},
): Promise<ListLandingsSummaryResult> {
  const db = getDb();
  const { status, q, limit = 24, offset = 0 } = filters;

  // 1) Base query — landings.
  const conditions = [eq(landingPages.storeId, STORE_ID)];
  if (status && status !== 'all') conditions.push(eq(landingPages.status, status));
  if (q && q.trim()) {
    const term = `%${q.trim()}%`;
    const search = or(ilike(landingPages.title, term), ilike(landingPages.slug, term));
    if (search) conditions.push(search);
  }
  const where = and(...conditions);

  const [landings, totalRow] = await Promise.all([
    db
      .select({
        id: landingPages.id,
        slug: landingPages.slug,
        title: landingPages.title,
        status: landingPages.status,
        currency: landingPages.currency,
        price: landingPages.price,
        fulfillmentType: landingPages.fulfillmentType,
        generationMode: landingPages.generationMode,
        createdAt: landingPages.createdAt,
        updatedAt: landingPages.updatedAt,
        cloneMetadata: landingPages.cloneMetadata,
        // Story 20.10a (retrabalho): só "tem HTML?" para a prévia do cartão — `octet_length` não
        // traz o html_body (pesado) para o app.
        hasHtml: sql<boolean>`octet_length(${landingPages.htmlBody}) > 0`,
      })
      .from(landingPages)
      .where(where)
      .orderBy(desc(landingPages.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(landingPages)
      .where(where),
  ]);

  if (landings.length === 0) {
    return { items: [], total: totalRow[0]?.count ?? 0 };
  }

  const landingIds = landings.map((l) => l.id);

  // 2) Progresso IA — todas as runs das landings acima, agregado no app.
  //    Estratégia: pega mais recente por (landing_page_id, squad).
  //    Postgres DISTINCT ON seria ideal mas drizzle não expõe; usamos
  //    fetch all + reduce no app (N pequeno: 5 squads × 24 landings = 120 rows).
  const runs = await db
    .select({
      landingPageId: landingGenerationRuns.landingPageId,
      squad: landingGenerationRuns.squad,
      status: landingGenerationRuns.status,
      error: landingGenerationRuns.error,
      startedAt: landingGenerationRuns.startedAt,
    })
    .from(landingGenerationRuns)
    .where(inArray(landingGenerationRuns.landingPageId, landingIds))
    .orderBy(desc(landingGenerationRuns.startedAt));

  // Map: landingId -> squad -> latest run
  const progressMap = new Map<string, Map<AiSquad, { status: string; error: string | null }>>();
  const errorByLanding = new Map<string, string>();
  for (const run of runs) {
    const squadKey = normalizeSquadName(run.squad);
    if (!squadKey) continue;
    let inner = progressMap.get(run.landingPageId);
    if (!inner) {
      inner = new Map();
      progressMap.set(run.landingPageId, inner);
    }
    // Já ordenado por started_at DESC — primeira ocorrência é a mais recente.
    if (!inner.has(squadKey)) {
      inner.set(squadKey, { status: run.status, error: run.error });
      // Guarda primeira mensagem de erro que encontrarmos por landing.
      if (run.status === 'failed' && run.error && !errorByLanding.has(run.landingPageId)) {
        errorByLanding.set(run.landingPageId, run.error);
      }
    }
  }

  // 3) Visual assets — só o hero desktop. Última versão por landing_id.
  const visuals = await db
    .select({
      landingPageId: landingVisualAssets.landingPageId,
      version: landingVisualAssets.version,
      assets: landingVisualAssets.assets,
    })
    .from(landingVisualAssets)
    .where(inArray(landingVisualAssets.landingPageId, landingIds))
    .orderBy(desc(landingVisualAssets.version));

  const heroByLanding = new Map<string, string | null>();
  for (const v of visuals) {
    if (!heroByLanding.has(v.landingPageId)) {
      heroByLanding.set(v.landingPageId, pickHeroUrl(v.assets));
    }
  }

  // 3.5) URL pública das landings publicadas — pega o deployment mais recente
  //      com status='published' de cada landing. Botão "Ver landing" abre esta URL.
  const deployments = await db
    .select({
      landingPageId: landingDeployments.landingPageId,
      verificationUrl: landingDeployments.verificationUrl,
      hostname: landingDeployments.hostname,
      publishedAt: landingDeployments.publishedAt,
    })
    .from(landingDeployments)
    .where(
      and(
        inArray(landingDeployments.landingPageId, landingIds),
        eq(landingDeployments.deploymentStatus, 'published'),
      ),
    )
    .orderBy(desc(landingDeployments.publishedAt));

  const publishedUrlByLanding = new Map<string, string>();
  for (const d of deployments) {
    if (!publishedUrlByLanding.has(d.landingPageId)) {
      const url = d.verificationUrl ?? (d.hostname ? `https://${d.hostname}` : null);
      if (url) publishedUrlByLanding.set(d.landingPageId, url);
    }
  }

  // 4) Compose summary.
  const items: LandingPageSummary[] = landings.map((l) => {
    const squadProgress: Record<AiSquad, SquadStatus> = {
      product_research: 'idle',
      copy: 'idle',
      visual: 'idle',
      build_html: 'idle',
      deploy: 'idle',
    };
    const inner = progressMap.get(l.id);
    if (inner) {
      for (const squad of AI_SQUADS) {
        const run = inner.get(squad);
        if (run) squadProgress[squad] = mapDbStatusToSquadStatus(run.status);
      }
    }
    return {
      id: l.id,
      slug: l.slug,
      title: l.title,
      status: (LANDING_STATUSES.includes(l.status as LandingStatus)
        ? l.status
        : 'draft') as LandingStatus,
      currency: l.currency,
      price: l.price,
      fulfillmentType: l.fulfillmentType,
      generationMode:
        l.generationMode === 'autopilot' ||
        l.generationMode === 'manual' ||
        l.generationMode === 'cloned'
          ? l.generationMode
          : null,
      createdAt: l.createdAt.toISOString(),
      updatedAt: l.updatedAt.toISOString(),
      heroImageUrl: heroByLanding.get(l.id) ?? null,
      squadProgress,
      lastError: errorByLanding.get(l.id) ?? null,
      publishedUrl: publishedUrlByLanding.get(l.id) ?? null,
      hasHtml: l.hasHtml === true,
      cloneMetadata:
        l.cloneMetadata && typeof l.cloneMetadata === 'object'
          ? (l.cloneMetadata as Record<string, unknown>)
          : null,
    };
  });

  return { items, total: totalRow[0]?.count ?? 0 };
}

export async function getLandingPage(idOrSlug: string): Promise<LandingPageRow | null> {
  const db = getDb();
  const matchCondition = UUID_RE.test(idOrSlug)
    ? eq(landingPages.id, idOrSlug)
    : eq(landingPages.slug, idOrSlug);
  const rows = await db
    .select()
    .from(landingPages)
    .where(and(matchCondition, eq(landingPages.storeId, STORE_ID)))
    .limit(1);
  const row = rows[0];
  return row ? rowToDto(row) : null;
}

// Drizzle retorna Date objects para timestamps e string para numeric. Uniformizamos
// pra string aqui pra evitar surpresas de serialização no client component.
function rowToDto(row: typeof landingPages.$inferSelect): LandingPageRow {
  return {
    id: row.id,
    storeId: row.storeId,
    slug: row.slug,
    title: row.title,
    status: row.status,
    currency: row.currency,
    fulfillmentType: row.fulfillmentType,
    htmlBody: row.htmlBody,
    customCss: row.customCss,
    mediaUrls: row.mediaUrls ?? [],
    videoUrls: row.videoUrls ?? [],
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
    seoImage: row.seoImage,
    manufacturer: row.manufacturer,
    productType: row.productType,
    countryOfOrigin: row.countryOfOrigin,
    tags: row.tags ?? [],
    price: row.price,
    compareAtPrice: row.compareAtPrice,
    soldOutCounter: row.soldOutCounter,
    disclaimerHtml: row.disclaimerHtml,
    anvisaNotificationNumber: row.anvisaNotificationNumber,
    cofeprisRegistrationNumber: row.cofeprisRegistrationNumber,
    previewToken: row.previewToken,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    // Autopilot fields (Story 13.3 — schema-additive, nunca null pós-migration).
    // Narrowing pra shape estrito só quando o CHECK constraint deixou passar.
    // Fase 5.A adicionou 'cloned' como valor válido.
    generationMode:
      row.generationMode === 'autopilot' ||
      row.generationMode === 'manual' ||
      row.generationMode === 'cloned'
        ? row.generationMode
        : null,
    sourceType:
      row.sourceType === 'aliexpress_link' ||
      row.sourceType === 'photo_upload' ||
      row.sourceType === 'other_url'
        ? row.sourceType
        : null,
    sourceUrl: row.sourceUrl,
    sourceImageUrl: row.sourceImageUrl,
    targetLanguage:
      row.targetLanguage === 'de' ||
      row.targetLanguage === 'it' ||
      row.targetLanguage === 'en' ||
      row.targetLanguage === 'es' ||
      row.targetLanguage === 'fr'
        ? row.targetLanguage
        : null,
    // Story 13.4: filtra entries válidas do array text[].
    targetLanguages: Array.isArray(row.targetLanguages)
      ? (row.targetLanguages.filter(
          (l): l is 'de' | 'it' | 'en' | 'es' | 'fr' =>
            l === 'de' || l === 'it' || l === 'en' || l === 'es' || l === 'fr',
        ) as Array<'de' | 'it' | 'en' | 'es' | 'fr'>)
      : null,
    pirDocumentId: row.pirDocumentId,
    // Fase 5.A — clone metadata.
    clonedAt: row.clonedAt ? row.clonedAt.toISOString() : null,
    cloneMetadata:
      row.cloneMetadata && typeof row.cloneMetadata === 'object'
        ? (row.cloneMetadata as Record<string, unknown>)
        : null,
    // Migration 0062 — Wizard classification. Default 'unknown' pra rows legadas.
    landingKind:
      row.landingKind === 'advertorial' || row.landingKind === 'sales_page'
        ? row.landingKind
        : 'unknown',
    parentSalesPageId: row.parentSalesPageId ?? null,
    // Fase Q — brand swap fields
    brandFrom: row.brandFrom ?? null,
    brandTo: row.brandTo ?? null,
    // Fase R — demografia alvo pra Seedream (imagens)
    targetDemographic: row.targetDemographic ?? null,
    // Fase T — translation state machine
    translationStatus:
      row.translationStatus === 'text_pending' ||
      row.translationStatus === 'text_running' ||
      row.translationStatus === 'images_pending' ||
      row.translationStatus === 'images_running' ||
      row.translationStatus === 'done' ||
      row.translationStatus === 'done_with_warnings' ||
      row.translationStatus === 'failed'
        ? row.translationStatus
        : 'idle',
    translationProgress:
      (row.translationProgress as Record<string, unknown> | null) ?? {},
    initialTargetLanguage: row.initialTargetLanguage ?? null,
    initialTranslateImages: Boolean(row.initialTranslateImages),
    // Wizard V2 (migration 0065)
    wizardStep:
      row.wizardStep === 'branding' ||
      row.wizardStep === 'images_selection' ||
      row.wizardStep === 'progress' ||
      row.wizardStep === 'pricing' ||
      row.wizardStep === 'product' ||
      row.wizardStep === 'publish' ||
      row.wizardStep === 'done'
        ? row.wizardStep
        : 'branding',
    wizardState: (row.wizardState as Record<string, unknown> | null) ?? {},
    imageOcrMetadata: Array.isArray(row.imageOcrMetadata)
      ? (row.imageOcrMetadata as LandingPageRow['imageOcrMetadata'])
      : null,
    displayCurrency: row.displayCurrency ?? null,
    useNewBundleEngine: Boolean(row.useNewBundleEngine),
    shopifyProductGid: row.shopifyProductGid ?? null,
    marketId: row.marketId ?? null,
    // Story 16.3: 'external' explícito (valor desconhecido → 'shopify', default do banco).
    checkoutProvider: normalizeCheckoutProvider(row.checkoutProvider),
  };
}

// ─── Slug uniqueness check ──────────────────────────────────────────────────
// Faz SELECT antes do INSERT/UPDATE pra dar erro amigável cedo. Se por race
// condition escapar do check e cair no unique constraint do banco, o catch
// abaixo pega o 23505 e retorna a mesma mensagem.

async function isSlugTaken(slug: string, excludeId?: string): Promise<boolean> {
  const db = getDb();
  const conditions = [
    eq(landingPages.storeId, STORE_ID),
    eq(landingPages.slug, slug),
  ];
  if (excludeId) conditions.push(ne(landingPages.id, excludeId));
  const rows = await db
    .select({ id: landingPages.id })
    .from(landingPages)
    .where(and(...conditions))
    .limit(1);
  return rows.length > 0;
}

// ─── Create ─────────────────────────────────────────────────────────────────

export async function createLandingPage(
  input: LandingPageInput,
): Promise<ActionResult<{ id: string }>> {
  const validation = validate(input);
  if (!validation.ok) {
    return { ok: false, code: 'validation', message: validation.message };
  }

  if (await isSlugTaken(input.slug)) {
    return {
      ok: false,
      code: 'duplicate_slug',
      message: 'Slug já utilizado — escolha outro.',
    };
  }

  try {
    const db = getDb();
    const now = new Date();
    const [row] = await db
      .insert(landingPages)
      .values({
        storeId: STORE_ID,
        title: input.title,
        slug: input.slug,
        status: input.status,
        currency: input.currency,
        fulfillmentType: input.fulfillmentType,
        htmlBody: input.htmlBody,
        customCss: input.customCss,
        mediaUrls: input.mediaUrls,
        videoUrls: input.videoUrls,
        seoTitle: input.seoTitle,
        seoDescription: input.seoDescription,
        seoImage: input.seoImage,
        manufacturer: input.manufacturer,
        productType: input.productType,
        countryOfOrigin: input.countryOfOrigin,
        tags: input.tags,
        price: input.price,
        compareAtPrice: input.compareAtPrice,
        soldOutCounter: input.soldOutCounter,
        disclaimerHtml: input.disclaimerHtml,
        anvisaNotificationNumber: input.anvisaNotificationNumber,
        cofeprisRegistrationNumber: input.cofeprisRegistrationNumber,
        // Preview token gerado UMA vez na criação; nunca regenerado (senão
        // quebra links compartilhados pra time interno).
        previewToken: crypto.randomUUID(),
        // Se dono clicou "Publicar" no create, seta published_at agora.
        publishedAt: input.status === 'published' ? now : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: landingPages.id });

    if (!row) {
      return { ok: false, code: 'unknown', message: 'Falha ao criar landing page.' };
    }

    revalidatePath('/landing-pages');
    return { ok: true, data: { id: row.id } };
  } catch (err) {
    if (isDuplicateSlugError(err)) {
      return {
        ok: false,
        code: 'duplicate_slug',
        message: 'Slug já utilizado — escolha outro.',
      };
    }
    // Log server-side, mensagem genérica pro client.
    console.error('[landing-actions] createLandingPage failed', err);
    return { ok: false, code: 'unknown', message: 'Erro interno ao criar landing.' };
  }
}

// ─── Update ─────────────────────────────────────────────────────────────────

export async function updateLandingPage(
  id: string,
  input: LandingPageInput,
): Promise<ActionResult<{ id: string }>> {
  const validation = validate(input);
  if (!validation.ok) {
    return { ok: false, code: 'validation', message: validation.message };
  }

  if (await isSlugTaken(input.slug, id)) {
    return {
      ok: false,
      code: 'duplicate_slug',
      message: 'Slug já utilizado — escolha outro.',
    };
  }

  try {
    const db = getDb();
    const now = new Date();
    // Buscar row atual pra decidir se publishedAt precisa ser setado (transição
    // draft/archived → published) ou preservado (published → published).
    const [current] = await db
      .select({ status: landingPages.status, publishedAt: landingPages.publishedAt })
      .from(landingPages)
      .where(and(eq(landingPages.id, id), eq(landingPages.storeId, STORE_ID)))
      .limit(1);

    if (!current) {
      return { ok: false, code: 'validation', message: 'Landing page não encontrada.' };
    }

    // Se mudou pra published e ainda não tem publishedAt, seta agora.
    // Se já era published, mantém publishedAt original (não sobreescreve).
    let nextPublishedAt: Date | null;
    if (input.status === 'published') {
      nextPublishedAt = current.publishedAt ?? now;
    } else {
      nextPublishedAt = current.publishedAt; // preserva mesmo em archived, pra saber quando publicou
    }

    await db
      .update(landingPages)
      .set({
        title: input.title,
        slug: input.slug,
        status: input.status,
        currency: input.currency,
        fulfillmentType: input.fulfillmentType,
        htmlBody: input.htmlBody,
        customCss: input.customCss,
        mediaUrls: input.mediaUrls,
        videoUrls: input.videoUrls,
        seoTitle: input.seoTitle,
        seoDescription: input.seoDescription,
        seoImage: input.seoImage,
        manufacturer: input.manufacturer,
        productType: input.productType,
        countryOfOrigin: input.countryOfOrigin,
        tags: input.tags,
        price: input.price,
        compareAtPrice: input.compareAtPrice,
        soldOutCounter: input.soldOutCounter,
        disclaimerHtml: input.disclaimerHtml,
        anvisaNotificationNumber: input.anvisaNotificationNumber,
        cofeprisRegistrationNumber: input.cofeprisRegistrationNumber,
        publishedAt: nextPublishedAt,
        // Trigger update_updated_at NÃO existe (migration 0046 §L25-29 explica
        // por que optamos por controle na app). Setar sempre em cada UPDATE.
        updatedAt: now,
      })
      .where(and(eq(landingPages.id, id), eq(landingPages.storeId, STORE_ID)));

    revalidatePath('/landing-pages');
    revalidatePath(`/landing-pages/${id}`);
    return { ok: true, data: { id } };
  } catch (err) {
    if (isDuplicateSlugError(err)) {
      return {
        ok: false,
        code: 'duplicate_slug',
        message: 'Slug já utilizado — escolha outro.',
      };
    }
    console.error('[landing-actions] updateLandingPage failed', err);
    return { ok: false, code: 'unknown', message: 'Erro interno ao atualizar landing.' };
  }
}

// ─── Delete ─────────────────────────────────────────────────────────────────
// Hard delete nesta story (dono confirma no modal). Soft delete pode entrar
// numa story futura se necessário pra auditoria.

export async function deleteLandingPage(id: string): Promise<ActionResult> {
  try {
    const db = getDb();
    // Fase 5.A Task #23 — antes de deletar do DB, checa se é clone (tem
    // assets em public/cloned/{id}/) e limpa a pasta. Idempotente: se pasta
    // não existe (landing manual/autopilot), não faz nada.
    const rows = await db
      .select({ generationMode: landingPages.generationMode })
      .from(landingPages)
      .where(and(eq(landingPages.id, id), eq(landingPages.storeId, STORE_ID)))
      .limit(1);
    if (rows[0]?.generationMode === 'cloned') {
      try {
        const { rmSync, existsSync } = await import('node:fs');
        const { join } = await import('node:path');
        const dir = join(process.cwd(), 'public', 'cloned', id);
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch (fsErr) {
        // Falha de FS não bloqueia delete do DB — apenas loga.
        console.warn('[landing-actions] failed to clean clone assets', fsErr);
      }
    }
    await db
      .delete(landingPages)
      .where(and(eq(landingPages.id, id), eq(landingPages.storeId, STORE_ID)));
    revalidatePath('/landing-pages');
    return { ok: true, data: undefined };
  } catch (err) {
    console.error('[landing-actions] deleteLandingPage failed', err);
    return { ok: false, code: 'unknown', message: 'Erro ao excluir landing.' };
  }
}

// ─── Publish / Unpublish ────────────────────────────────────────────────────
// REMOVIDO (GAP-01, 2026-09-28): as antigas publishLandingPage/unpublishLandingPage
// faziam UPDATE direto em landing_pages.status sem passar pelo fidelity gate,
// sem criar deployment row e sem atualizar current_deployment_id. Bypass total
// de segurança. Novas implementações em:
//   - apps/backoffice/src/app/(dashboard)/landing-pages/[id]/publish-actions.ts
//     (server actions com validação, gate e deployment lifecycle completo)
//   - apps/backoffice/src/app/api/landing-domains/publish-on-domain/route.ts
//     (endpoint REST usado pelo editor V2 / PublishSection)
// O único caller legado (edit-client.tsx / EditWorkspace) foi removido junto.

// ─── Rename (título + slug) — Fase 5.A Task #17 ───────────────────────────
// Action leve pra renomear landing sem passar o payload completo.
// Usado especialmente por landings clonadas (slugs auto-gerados são feios).
export async function renameLandingPage(
  id: string,
  input: { title: string; slug: string },
): Promise<ActionResult<{ id: string; slug: string }>> {
  const title = input.title.trim();
  const slug = input.slug.trim().toLowerCase();
  if (!title) {
    return { ok: false, code: 'validation', message: 'Título é obrigatório.' };
  }
  if (!slug) {
    return { ok: false, code: 'validation', message: 'Slug é obrigatório.' };
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    return {
      ok: false,
      code: 'validation',
      message: 'Slug deve conter apenas letras minúsculas, números e hífens.',
    };
  }

  if (await isSlugTaken(slug, id)) {
    return { ok: false, code: 'duplicate_slug', message: 'Slug já utilizado.' };
  }

  try {
    const db = getDb();
    const result = await db
      .update(landingPages)
      .set({ title, slug, updatedAt: new Date() })
      .where(and(eq(landingPages.id, id), eq(landingPages.storeId, STORE_ID)))
      .returning({ id: landingPages.id, slug: landingPages.slug });
    if (result.length === 0) {
      return { ok: false, code: 'validation', message: 'Landing não encontrada.' };
    }
    revalidatePath('/landing-pages');
    revalidatePath(`/landing-pages/${id}`);
    return { ok: true, data: { id, slug: result[0]!.slug } };
  } catch (err) {
    if (isDuplicateSlugError(err)) {
      return { ok: false, code: 'duplicate_slug', message: 'Slug já utilizado.' };
    }
    console.error('[landing-actions] renameLandingPage failed', err);
    return { ok: false, code: 'unknown', message: 'Erro ao renomear landing.' };
  }
}

// ─── Wizard: classificar landing como advertorial ou sales_page (Fase B) ────

export type LandingKind = 'advertorial' | 'sales_page';

export interface ClassifyLandingInput {
  kind: LandingKind;
  /** Se kind=advertorial, ID da sales_page pai. Ignorado quando kind=sales_page. */
  parentSalesPageId?: string | null;
}

/**
 * Marca uma landing como advertorial ou sales_page e opcionalmente vincula
 * advertorial a sua sales_page pai. Habilita a lógica do Wizard (Fase B).
 */
export async function classifyLanding(
  landingId: string,
  input: ClassifyLandingInput,
): Promise<ActionResult<{ id: string }>> {
  if (!UUID_RE.test(landingId)) {
    return { ok: false, code: 'validation', message: 'landingId inválido.' };
  }
  if (input.kind !== 'advertorial' && input.kind !== 'sales_page') {
    return {
      ok: false,
      code: 'validation',
      message: 'kind deve ser "advertorial" ou "sales_page".',
    };
  }

  // parent_sales_page_id só faz sentido em advertorial. Em sales_page limpa.
  const parentId =
    input.kind === 'advertorial' && input.parentSalesPageId
      ? input.parentSalesPageId
      : null;

  if (parentId && !UUID_RE.test(parentId)) {
    return { ok: false, code: 'validation', message: 'parentSalesPageId inválido.' };
  }

  // Se aponta pra parent, valida que ele existe e é sales_page.
  if (parentId) {
    const db = getDb();
    const parentRows = await db
      .select({ id: landingPages.id, kind: landingPages.landingKind })
      .from(landingPages)
      .where(and(eq(landingPages.id, parentId), eq(landingPages.storeId, STORE_ID)))
      .limit(1);
    if (parentRows.length === 0) {
      return {
        ok: false,
        code: 'validation',
        message: 'Sales page pai não encontrada.',
      };
    }
    if (parentRows[0]!.kind !== 'sales_page') {
      return {
        ok: false,
        code: 'validation',
        message: 'Landing pai precisa ser do tipo sales_page.',
      };
    }
  }

  try {
    const db = getDb();
    const result = await db
      .update(landingPages)
      .set({
        landingKind: input.kind,
        parentSalesPageId: parentId,
        updatedAt: new Date(),
      })
      .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)))
      .returning({ id: landingPages.id });
    if (result.length === 0) {
      return { ok: false, code: 'validation', message: 'Landing não encontrada.' };
    }
    revalidatePath('/landing-pages');
    revalidatePath(`/landing-pages/${landingId}`);
    return { ok: true, data: { id: landingId } };
  } catch (err) {
    console.error('[landing-actions] classifyLanding failed', err);
    return { ok: false, code: 'unknown', message: 'Erro ao classificar landing.' };
  }
}

/**
 * Fase Q — Salva configuração de tradução/rebrand da landing.
 * Chamado pelo Wizard step "Marca & Idioma" (novo).
 */
export interface UpdateBrandingInput {
  /** Marca origem detectada/inserida (ex: "Cayenne Max"). null = não usar swap. */
  brandFrom?: string | null;
  /** Marca destino do dono (ex: "Vigorex"). null = não usar swap. */
  brandTo?: string | null;
  /** Idioma alvo. null = manter atual/detectar. */
  targetLanguage?: 'it' | 'de' | 'en' | 'es' | 'fr' | 'pt' | 'pt-BR' | 'ja' | 'zh' | null;
  /** Fase R — demografia alvo pra Seedream adaptar rostos. Ex: "Italian adults 40-55". null = manter rostos originais. */
  targetDemographic?: string | null;
}

export async function updateBrandingLanding(
  landingId: string,
  input: UpdateBrandingInput,
): Promise<ActionResult<{ id: string }>> {
  if (!UUID_RE.test(landingId)) {
    return { ok: false, code: 'validation', message: 'landingId inválido.' };
  }

  const db = getDb();
  const now = new Date();
  try {
    await db
      .update(landingPages)
      .set({
        brandFrom: input.brandFrom?.trim() || null,
        brandTo: input.brandTo?.trim() || null,
        targetDemographic: input.targetDemographic?.trim() || null,
        targetLanguage: input.targetLanguage ?? null,
        updatedAt: now,
      })
      .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)));
    revalidatePath(`/landing-pages/${landingId}`);
    return { ok: true, data: { id: landingId } };
  } catch (err) {
    console.error('updateBrandingLanding failed:', err);
    return { ok: false, code: 'unknown', message: 'Erro ao salvar configuração.' };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Wizard V2 (set/2026) — state machine persistence.
// Migration 0065 adicionou wizard_step + wizard_state ao landing_pages.
// ─────────────────────────────────────────────────────────────────────

export type WizardStep =
  | 'branding'
  | 'images_selection'
  | 'progress'
  | 'pricing'
  | 'product'
  | 'publish'
  | 'done';

const WIZARD_STEPS_ORDER: WizardStep[] = [
  'branding',
  'images_selection',
  'progress',
  'pricing',
  'product',
  'publish',
  'done',
];

/**
 * Atualiza escolha de uma etapa do wizard. Faz MERGE (não sobrescreve
 * outras etapas). Opcionalmente avança wizardStep pra próxima.
 *
 * Ex uso:
 *   updateWizardState(id, {
 *     stepKey: 'branding',
 *     stepData: { keepOriginBrand: false, newBrand: 'Vigorex', targetLanguage: 'it' },
 *     advanceTo: 'images_selection'
 *   })
 */
export interface UpdateWizardStateInput {
  /** Nome da etapa cuja escolha está sendo salva (chave em wizard_state jsonb). */
  stepKey: WizardStep | 'meta';
  /** Dados dessa etapa. Merge no jsonb (não sobrescreve outras chaves). */
  stepData: Record<string, unknown>;
  /** Se fornecido, também atualiza wizard_step pra este valor. */
  advanceTo?: WizardStep;
}

export async function updateWizardState(
  landingId: string,
  input: UpdateWizardStateInput,
): Promise<ActionResult<{ id: string; wizardStep: WizardStep }>> {
  if (!UUID_RE.test(landingId)) {
    return { ok: false, code: 'validation', message: 'landingId inválido.' };
  }
  if (!input.stepKey || typeof input.stepData !== 'object') {
    return { ok: false, code: 'validation', message: 'stepKey + stepData obrigatórios.' };
  }
  if (input.advanceTo && !WIZARD_STEPS_ORDER.includes(input.advanceTo)) {
    return { ok: false, code: 'validation', message: 'advanceTo inválido.' };
  }

  const db = getDb();
  const now = new Date();

  try {
    // Merge no jsonb sem sobrescrever outras chaves: usa jsonb_set com key path.
    const stepDataJson = JSON.stringify(input.stepData);
    await db
      .update(landingPages)
      .set({
        wizardState: sql`jsonb_set(
          COALESCE(wizard_state, '{}'::jsonb),
          ${'{' + input.stepKey + '}'}::text[],
          ${stepDataJson}::jsonb,
          true
        )`,
        ...(input.advanceTo ? { wizardStep: input.advanceTo } : {}),
        updatedAt: now,
      })
      .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)));

    revalidatePath(`/landing-pages/${landingId}`);
    return {
      ok: true,
      data: {
        id: landingId,
        wizardStep: input.advanceTo ?? 'branding',
      },
    };
  } catch (err) {
    console.error('updateWizardState failed:', err);
    return { ok: false, code: 'unknown', message: 'Erro ao salvar estado do wizard.' };
  }
}

/**
 * Lista landings do tipo sales_page pra popular dropdown "Qual sales page é
 * o destino?" no wizard de advertorial.
 */
export async function listSalesPages(): Promise<
  Array<{ id: string; title: string; slug: string }>
> {
  const db = getDb();
  const rows = await db
    .select({
      id: landingPages.id,
      title: landingPages.title,
      slug: landingPages.slug,
    })
    .from(landingPages)
    .where(
      and(
        eq(landingPages.storeId, STORE_ID),
        eq(landingPages.landingKind, 'sales_page'),
      ),
    )
    .orderBy(desc(landingPages.updatedAt))
    .limit(200);
  return rows;
}
