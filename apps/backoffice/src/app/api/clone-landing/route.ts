// POST /api/clone-landing
//
// Fase F.2 (2026-09-15) — REESCRITO: agora só enfileira job no worker Railway.
//
// Antes: rodava Playwright direto no Next dev server (não funciona em Vercel
// Serverless — sem Chromium, filesystem read-only).
//
// Agora:
//   1. Valida URL
//   2. Cria/reusa row em landing_pages com generation_mode='cloned', placeholder
//   3. Enfileira job em 'landinglab.squad0.clone' via BullMQ (Redis)
//   4. Retorna { landingId, jobId } — frontend polleia por status
//
// Worker Railway (apps/worker/src/processors/landinglab-clone.processor.ts)
// tem Playwright + Supabase SDK + filesystem persistente. Processa em ~30-90s.
//
// TODO Fase F.3: SSE endpoint GET /api/clone-landing/stream?jobId=X pra
// mostrar progress bar em tempo real (hoje frontend polleia status da landing).

import { randomUUID } from 'node:crypto';

import { landingPages } from '@blackshop/db/schema-landinglab-core';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { enqueueJob } from '@/lib/api-queue';
import { getDb } from '@/lib/landing-db';
import { buildRateLimitResponse, getClientIdentity, rateLimit } from '@/lib/rate-limit';
import { requireVerifiedApiSession } from '@/lib/session';
const STORE_ID = 'l0i';
const CLONE_QUEUE = 'landinglab.squad0.clone';

export const runtime = 'nodejs';
// Como agora só enfileira (não roda Playwright), timeout curto é suficiente.
export const maxDuration = 15;

const ALLOWED_LANGS = ['en', 'it', 'de', 'fr', 'es', 'ja', 'zh', 'pt-BR', 'pt'] as const;
type AllowedLang = (typeof ALLOWED_LANGS)[number];

interface CloneRequestBody {
  url?: string;
  /** Se fornecido, faz RECLONE (UPDATE) em vez de criar nova landing. */
  landingId?: string;
  /**
   * Fase T (set/2026): idioma-alvo do Wizard. Se setado, o clone processor
   * enfileira translate-text automaticamente após o clone terminar.
   */
  targetLanguage?: string;
  /**
   * Fase T (set/2026): se true, o translate-text processor encadeia
   * translate-images após terminar. Só efetivo com targetLanguage setado.
   */
  translateImages?: boolean;
  /**
   * FR-30 / html-only mode: HTML já renderizado pelo browser do usuário
   * (view-source). Quando presente:
   *   - URL vira opcional (placeholder https://placeholder.local/manual-paste)
   *   - Worker skipa Playwright, extrai URLs via cheerio
   *   - Bypass total de anti-bot / timeout / fingerprint
   */
  htmlOverride?: string;
  /**
   * Tipo semântico da landing (Wave 1 Item 3 — set/2026):
   *   - advertorial: aquece lead, aponta pra sales_page. Wizard mostra
   *     APENAS traduzir + ajustar CTAs + publicar.
   *   - sales_page: oferta com produto. Wizard mostra fluxo completo
   *     (preços, bundles, imagens do produto, publicar).
   * Grava em landing_pages.landing_kind (coluna já existente desde
   * migration 0062). Se não vier, default 'unknown' e usuário classifica
   * no wizard depois.
   */
  landingKind?: 'advertorial' | 'sales_page';
}

const HTML_PLACEHOLDER_URL = 'https://placeholder.local/manual-paste';

export async function POST(req: Request): Promise<Response> {
  // Épico 0 · 0.1 — sessão verificada na API (não basta o cookie existir).
  const authError = await requireVerifiedApiSession(req);
  if (authError) return authError;

  // Wrapper defensivo — garante que NUNCA retornamos body vazio. Vercel
  // serverless às vezes crasha silencioso e o cliente vê 'Unexpected end
  // of JSON'. Um catch global aqui é caro (retry log confuso) mas evita
  // debug cego.
  try {
    return await handleClonePost(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error('[clone-landing] uncaught error:', message, stack);
    return NextResponse.json(
      { ok: false, message: `Erro interno: ${message}` },
      { status: 500 },
    );
  }
}

async function handleClonePost(req: Request): Promise<Response> {
  // Rate limit: 100 clones/hora por usuário (session id) ou IP.
  // Aumentado temporariamente de 5 pra 100 durante fase de smoke/debug.
  // TODO: voltar pra 5 quando a rota estiver estável em prod.
  const rl = await rateLimit(`clone:${getClientIdentity(req)}`, 100, 60 * 60 * 1000);
  if (!rl.ok) return buildRateLimitResponse(rl.resetAt);

  let body: CloneRequestBody;
  try {
    body = (await req.json()) as CloneRequestBody;
  } catch {
    return NextResponse.json({ ok: false, message: 'JSON inválido' }, { status: 400 });
  }

  // html-only mode: URL fica opcional (worker skipa Playwright). Se URL vazia,
  // usa placeholder que passa validação básica sem ser fetchada.
  const htmlOverride =
    typeof body.htmlOverride === 'string' && body.htmlOverride.trim().length >= 100
      ? body.htmlOverride
      : undefined;

  let url = body.url?.trim() ?? '';
  if (htmlOverride && !url) {
    url = HTML_PLACEHOLDER_URL;
  }
  if (!url || !/^https?:\/\//i.test(url)) {
    return NextResponse.json(
      {
        ok: false,
        message: htmlOverride
          ? 'URL inválida — em modo HTML, deixe vazio pra usar placeholder ou cole uma URL http/https válida.'
          : 'URL válida obrigatória (deve começar com http/https)',
      },
      { status: 400 },
    );
  }
  if (!htmlOverride && body.htmlOverride) {
    return NextResponse.json(
      { ok: false, message: 'htmlOverride precisa ter no mínimo 100 caracteres.' },
      { status: 400 },
    );
  }

  // Fase T: valida targetLanguage se fornecido. Null/undefined = clone puro.
  const targetLanguage = body.targetLanguage?.trim() || null;
  if (targetLanguage && !ALLOWED_LANGS.includes(targetLanguage as AllowedLang)) {
    return NextResponse.json(
      {
        ok: false,
        message: `targetLanguage inválido. Aceitos: ${ALLOWED_LANGS.join(', ')}`,
      },
      { status: 400 },
    );
  }
  const translateImages = Boolean(body.translateImages) && Boolean(targetLanguage);

  // Wave 1 Item 3: valida landingKind. Se inválido/vazio → 'unknown' (usuário
  // classifica no wizard depois). Se válido → grava na coluna landing_kind e
  // wizard adapta steps automaticamente.
  const landingKind: 'advertorial' | 'sales_page' | 'unknown' =
    body.landingKind === 'advertorial' || body.landingKind === 'sales_page'
      ? body.landingKind
      : 'unknown';

  const db = getDb();
  const now = new Date();

  // Extrai host pra usar como parte do slug/título temporário.
  let host = 'clone';
  try {
    host = new URL(url).hostname.replace(/^www\./, '').split('.')[0] ?? 'clone';
  } catch {
    // silêncio — usa 'clone' default
  }

  // Reclone mode: body.landingId reusa row existente. Sem: cria nova.
  let landingId: string;
  let slug: string;

  if (body.landingId) {
    const existing = await db
      .select({ id: landingPages.id, slug: landingPages.slug })
      .from(landingPages)
      .where(and(eq(landingPages.id, body.landingId), eq(landingPages.storeId, STORE_ID)))
      .limit(1);
    if (existing.length === 0) {
      return NextResponse.json(
        { ok: false, message: 'Landing não encontrada pra reclone.' },
        { status: 404 },
      );
    }
    landingId = existing[0]!.id;
    slug = existing[0]!.slug;
    // Marca como "processando" novamente pra UI mostrar status correto.
    // Fase T: reset translation state + registra intent do Wizard.
    await db
      .update(landingPages)
      .set({
        title: `Reclonando ${host}...`,
        htmlBody: '<!-- reclone in progress -->',
        initialTargetLanguage: targetLanguage,
        initialTranslateImages: translateImages,
        translationStatus: 'idle',
        // clone_status='cloning' para lifecycle explícito (SB-08).
        cloneMetadata: { clone_status: 'cloning', queued_at: now.toISOString() },
        // Reclone respeita landingKind fornecido; se 'unknown' (default),
        // NÃO sobrescreve valor existente na row (preserva classificação prévia).
        ...(landingKind !== 'unknown' ? { landingKind } : {}),
        updatedAt: now,
      })
      .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)));
  } else {
    landingId = randomUUID();
    slug = `${host}-clone-${Date.now().toString(36)}`;
    await db.insert(landingPages).values({
      id: landingId,
      storeId: STORE_ID,
      title: `Clone de ${host} (processando...)`,
      slug,
      status: 'draft',
      currency: 'USD',
      fulfillmentType: 'dropship',
      htmlBody: '<!-- cloning in progress -->',
      price: '0.00',
      generationMode: 'cloned',
      sourceType: 'other_url',
      sourceUrl: url,
      previewToken: randomUUID(),
      // clone_metadata com clone_status='cloning' permite UI derivar lifecycle
      // sem depender de htmlBody como string frágil (SB-08).
      // Story 15.2: 'USD' é provisória — o worker grava a moeda detectada na origem.
      cloneMetadata: {
        clone_status: 'cloning',
        queued_at: now.toISOString(),
        currency_source: 'placeholder',
      },
      // Wave 1 Item 3: tipo semântico. Wizard adapta steps conforme:
      //   advertorial → só traduzir + CTAs + publicar
      //   sales_page → fluxo completo (preços, bundles, imagens produto)
      landingKind,
      // Fase T: intent do Wizard grava no DB pra clone processor ler no chain
      initialTargetLanguage: targetLanguage,
      initialTranslateImages: translateImages,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Enfileira job pro worker Railway processar (Playwright + Supabase upload).
  let jobId: string;
  try {
    ({ jobId } = await enqueueJob(
      CLONE_QUEUE,
      'CloneJob',
      {
        landingPageId: landingId,
        url,
        ...(htmlOverride ? { htmlOverride } : {}),
      },
      {
        jobId: `clone-${landingId}-${Date.now()}`,
        attempts: 2,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400 },
      },
    ));
  } catch (err) {
    // Falha ao enfileirar: reverte placeholder ou marca como failed.
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(landingPages)
      .set({
        title: `Falha ao iniciar clone de ${host}`,
        htmlBody: `<!-- enqueue failed: ${message} -->`,
        updatedAt: new Date(),
      })
      .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)));
    return NextResponse.json(
      {
        ok: false,
        message: `Falha ao enfileirar clone: ${message}`,
        landingId,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    landingId,
    slug,
    jobId,
    status: 'queued',
    targetLanguage,
    translateImages,
    message: targetLanguage
      ? `Clone + tradução enfileirados. Texto em ${targetLanguage}${translateImages ? ' + imagens' : ''} após o clone.`
      : 'Clone enfileirado — landing pronta em ~30-90s.',
  });
}
