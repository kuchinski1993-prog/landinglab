// LandingLab Squad 0 (Cloner) processor — Fase F.1 (2026-09-15).
//
// Consumes queue 'landinglab.squad0.clone':
//   1. Recebe { landingPageId, url, targetLanguage? }
//   2. Chama cloneLanding() do @blackshop/landinglab-cloner (Playwright + downloader + rewriter + sanitizer)
//   3. Upload assets baixados pra Supabase Storage bucket 'cloned-landings'
//   4. Reescreve URLs no HTML pra apontar pros assets do Supabase
//   5. UPDATE landing_pages com html_body final + media_urls + clone_metadata
//   6. Retorna sucesso (frontend polleia via GET /landing-pages/[id] até status mudar)
//
// Motivo (vs rota Vercel direta): Vercel Serverless não suporta Playwright
// (não tem Chromium instalado, filesystem read-only). Worker Railway já tem
// Playwright + filesystem persistente + Supabase SDK.
//
// Rate: Playwright é caro (~500MB RAM, ~30-90s de execução). Concurrency 1
// pra não estourar memória do container Railway.

import { readFile, rm, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { createHash } from 'node:crypto';

import { createClient, landingBundleOffers, landingHtmlSnapshots, landingPages, landingPixels, landingVariants } from '@blackshop/db';
import {
  cloneLanding,
  detectBrand,
  type CloneInput,
  type PixelConfig,
} from '@blackshop/landinglab-cloner';
import { normalizeCheckoutProvider, readExternalCheckoutConfig } from '@blackshop/shared/external-checkout';
import { Queue } from 'bullmq';
import type { Job } from 'bullmq';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { Redis } from 'ioredis';

import { persistCloneInitialSnapshot } from '../lib/html-snapshot-repo.js';
import { resolveLandingGlobalPixel } from '../lib/landing-global-pixel.js';

import { logger } from '../logger.js';
import { getSupabaseAdmin } from '../supabase.js';

const TRANSLATE_TEXT_QUEUE = 'landinglab.translate-text';

let cachedTranslateTextQueue: Queue | null = null;
function getTranslateTextQueue(): Queue | null {
  if (cachedTranslateTextQueue) return cachedTranslateTextQueue;
  const redisUrl = process.env['REDIS_URL'];
  if (!redisUrl) return null;
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  });
  cachedTranslateTextQueue = new Queue(TRANSLATE_TEXT_QUEUE, { connection });
  return cachedTranslateTextQueue;
}

export interface LandingLabCloneJobData {
  landingPageId: string;
  url: string;
  targetLanguage?: 'de' | 'it' | 'en' | 'es' | 'fr' | null;
  /**
   * FR-30 / html-only mode: HTML já renderizado pelo browser do usuário
   * (view-source). Quando presente, orchestrator skipa Playwright.
   * Bypass anti-bot / timeout / fingerprint. Tamanho típico 200KB-2MB.
   */
  htmlOverride?: string;
}

const SUPABASE_BUCKET = 'cloned-landings';

// Content-type inference por extensão (Supabase precisa pra servir corretamente).
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ico': 'image/x-icon',
};

function inferContentType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Upload recursivo de todos arquivos de um diretório local pro Supabase Storage.
 * Retorna Map<localPath, publicSupabaseUrl> pra reescrita de URLs no HTML.
 *
 * onProgress recebe (done, total) a cada arquivo enviado — pra o SSE stream
 * conseguir emitir uma barra durante a fase upload (que domina o tempo).
 */
async function uploadDirectoryToSupabase(
  localDir: string,
  supabasePath: string,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, string>> {
  const supabase = getSupabaseAdmin();
  const urlMap = new Map<string, string>();

  // Primeiro walk pra contar total (walk 2x é OK: readdir é I/O barato local).
  async function count(dir: string): Promise<number> {
    let n = 0;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) n += await count(full);
      else if (entry.isFile()) n += 1;
    }
    return n;
  }
  const total = await count(localDir);
  let done = 0;

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const remotePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(fullPath, remotePath);
      } else if (entry.isFile()) {
        const fileBuffer = await readFile(fullPath);
        const contentType = inferContentType(entry.name);
        const finalRemotePath = `${supabasePath}/${remotePath}`;
        const { error } = await supabase.storage
          .from(SUPABASE_BUCKET)
          .upload(finalRemotePath, fileBuffer, {
            contentType,
            upsert: true,
            cacheControl: '31536000, immutable',
          });
        if (error) {
          throw new Error(
            `Supabase upload failed for ${finalRemotePath}: ${error.message}`,
          );
        }
        const { data: publicData } = supabase.storage
          .from(SUPABASE_BUCKET)
          .getPublicUrl(finalRemotePath);
        urlMap.set(fullPath, publicData.publicUrl);
        done += 1;
        onProgress?.(done, total);
      }
    }
  }

  await walk(localDir, '');
  return urlMap;
}

/**
 * Resolve Meta Pixel config a partir de landing_pixels + landing_variants
 * (Fase D.1). Query o primeiro pixel ATIVO com provider='meta' pra esse
 * landing_page. Se não configurado, retorna null → cloner pula injeção.
 *
 * Pega dados de conteúdo (ViewContent params) do landing_page + landing_variants:
 *   - contentName: landingPage.title
 *   - contentIds: array de ids das variantes ativas
 *   - value: preço da primeira variante (approximation)
 *   - currency: landingPage.currency ?? 'USD'
 *
 * V1 UI só configura meta provider; TikTok/Google Ads/Pinterest ficam pra depois.
 */
async function resolvePixelConfig(
  db: ReturnType<typeof createClient>['db'],
  landingPageId: string,
): Promise<PixelConfig | null> {
  const [existingPixel] = await db
    .select()
    .from(landingPixels)
    .where(and(eq(landingPixels.landingPageId, landingPageId), eq(landingPixels.isActive, true)))
    .limit(1);

  // Sem pixel próprio → pixel de Configurações → Tracking (sem gravar cópia em
  // landing_pixels: a landing passa a seguir o pixel global).
  let pixelRow = existingPixel;
  if (!pixelRow) {
    // Story 23.1b · pixel global da loja da landing (lib/landing-global-pixel.ts).
    const globalPx = await resolveLandingGlobalPixel(db, landingPageId, { ordered: true });
    if (globalPx && /^\d{13,17}$/.test(globalPx.pixelId)) {
      pixelRow = {
        provider: 'meta',
        pixelId: globalPx.pixelId,
        eventsEnabled: ['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase'],
        eventTestCode: null,
      } as unknown as typeof existingPixel;
    }
  }

  if (!pixelRow) return null;
  if (pixelRow.provider !== 'meta') return null;

  const [pageRow] = await db
    .select({ title: landingPages.title, currency: landingPages.currency })
    .from(landingPages)
    .where(eq(landingPages.id, landingPageId))
    .limit(1);

  const variants = await db
    .select({ id: landingVariants.id, price: landingVariants.price })
    .from(landingVariants)
    .where(eq(landingVariants.landingPageId, landingPageId))
    .limit(10);

  const events = Array.isArray(pixelRow.eventsEnabled)
    ? (pixelRow.eventsEnabled as string[])
    : ['PageView'];

  const firstPrice = variants[0]?.price;
  const parsedValue = firstPrice != null ? Number(firstPrice) : null;

  return {
    pixelId: pixelRow.pixelId,
    eventsEnabled: events,
    eventTestCode: pixelRow.eventTestCode ?? null,
    contentIds: variants.length > 0 ? variants.map((v) => v.id) : undefined,
    contentName: pageRow?.title ?? null,
    contentType: variants.length > 0 ? 'product' : null,
    value: parsedValue != null && Number.isFinite(parsedValue) ? parsedValue : null,
    currency: pageRow?.currency ?? 'USD',
  };
}

export async function processLandingLabClone(
  job: Job<LandingLabCloneJobData>,
): Promise<{ ok: true; bytes: number; assetsCount: number; latencyMs: number }> {
  const { landingPageId, url, htmlOverride } = job.data;
  const startedAt = Date.now();

  logger.info(
    {
      jobId: job.id,
      landingPageId,
      url,
      mode: htmlOverride ? 'html-only' : 'url',
      htmlBytes: htmlOverride?.length ?? 0,
    },
    'landinglab.squad0.clone: started',
  );

  const { db, sql } = createClient({
    databaseUrl:
      process.env['DATABASE_URL'] ??
      'postgresql://blackshop:changeme@localhost:5432/blackshop',
  });

  // Tmp dir efêmero — usado só como buffer local antes de subir pra Supabase.
  const tmpDir = join(tmpdir(), `clone-${landingPageId}-${randomUUID().slice(0, 8)}`);
  const supabasePath = `landings/${landingPageId}`;

  // Emite eventos custom via job.updateProgress — QueueEvents propaga p/ SSE.
  // Payload é serializado em JSON pelo BullMQ e retransmitido em real-time.
  const emit = async (payload: Record<string, unknown>): Promise<void> => {
    try {
      await job.updateProgress(payload);
    } catch (err) {
      // updateProgress falha não deve derrubar o job — só perde 1 evento SSE.
      logger.warn({ jobId: job.id, err }, 'updateProgress failed (non-fatal)');
    }
  };

  try {
    await emit({ phase: 'clone:started', at: Date.now() });

    // 0. Resolve Meta Pixel config (Fase D.1). Query landing_pixels ativo pra
    //    esse landing_page. Se não configurado, pixelConfig = null → cloner
    //    pula injeção (no-op). Só permite meta provider (V1 UI limitada).
    const pixelConfig = await resolvePixelConfig(db, landingPageId).catch((err) => {
      logger.warn(
        { jobId: job.id, landingPageId, err },
        'resolvePixelConfig failed — clonando sem pixel (non-fatal)',
      );
      return null;
    });
    if (pixelConfig) {
      logger.info(
        { jobId: job.id, landingPageId, pixelId: pixelConfig.pixelId, events: pixelConfig.eventsEnabled },
        'landinglab.squad0.clone: injetando Meta Pixel',
      );
    }

    // 0.1. Puxa currency da landing pra fixes-injector reescrever product JSON.
    const [pageCurrencyRow] = await db
      .select({
        currency: landingPages.currency,
        marketId: landingPages.marketId,
        cloneMetadata: landingPages.cloneMetadata,
        checkoutProvider: landingPages.checkoutProvider,
        ctaConfig: landingPages.ctaConfig,
      })
      .from(landingPages)
      .where(eq(landingPages.id, landingPageId))
      .limit(1);
    // Story 16.3: re-clone de landing `external` → injector sem script legado de checkout e
    // tracker do Sphere só com opt-in (`cta_config.externalCheckout.allowSphereTracker`).
    const checkoutProvider = normalizeCheckoutProvider(pageCurrencyRow?.checkoutProvider);
    const allowSphereTracker =
      checkoutProvider === 'external' && readExternalCheckoutConfig(pageCurrencyRow?.ctaConfig).allowSphereTracker === true;
    // Story 15.2: clone novo nasce com moeda provisória ('USD' +
    // currency_source='placeholder'). Nesse caso o cloner preserva a moeda da
    // origem (currency null) e gravamos a detectada. Mercado ou moeda escolhida
    // pelo usuário nunca são sobrescritos.
    const currencyIsPlaceholder =
      !pageCurrencyRow?.marketId &&
      (pageCurrencyRow?.cloneMetadata as { currency_source?: string } | null)?.currency_source ===
        'placeholder';
    const currency = currencyIsPlaceholder ? null : (pageCurrencyRow?.currency ?? null);

    // 1. Roda o cloner (Playwright + downloader + rewriter + sanitizer).
    //    Escreve assets no filesystem local (tmp). Rewriter usa
    //    publicPathPrefix como base — depois reescrevemos com URLs Supabase.
    const cloneInput: CloneInput = {
      landingId: landingPageId,
      url,
      storageRoot: tmpDir,
      publicPathPrefix: `/_clone_placeholder_${landingPageId}`,
      pixelConfig,
      currency,
      checkoutProvider,
      allowSphereTracker,
      ...(htmlOverride ? { htmlOverride } : {}),
      onProgress: (event) => {
        logger.debug(
          { jobId: job.id, landingPageId, phase: event.phase },
          `clone phase: ${event.phase}`,
        );
        // Passa fase do cloner adiante como { phase: 'clone:<subphase>', ... }.
        // Spread PRIMEIRO pra que nossa key 'phase' sobrescreva a do event.
        void emit({ ...event, phase: `clone:${event.phase}` });
      },
    };

    const cloneResult = await cloneLanding(cloneInput);

    if (cloneResult.aborted) {
      throw new Error(`Clone aborted at phase ${cloneResult.abortedAt ?? 'unknown'}`);
    }

    // Fidelity gate consumer (2026-09-28) — não bloqueia apply-bundle nem publish.
    // Operador vê no log e decide re-clonar via wizard se relevante.
    // Persistência: fidelity_verdict/findings vão em clone_metadata (JSONB, additive).
    if (cloneResult.fidelityBlocked) {
      logger.warn(
        {
          jobId: job.id,
          landingPageId,
          fidelityVerdict: cloneResult.fidelityVerdict,
          fidelityFindings: cloneResult.fidelityFindings,
        },
        'landinglab.squad0.clone: FIDELITY BLOCKED — clone tem artefatos críticos (browser-extension/CSS missing). Revisar antes de publicar.',
      );
    } else if (cloneResult.fidelityDegraded) {
      logger.warn(
        {
          jobId: job.id,
          landingPageId,
          fidelityVerdict: cloneResult.fidelityVerdict,
          fidelityFindings: cloneResult.fidelityFindings,
        },
        'landinglab.squad0.clone: FIDELITY DEGRADED — clone tem findings não-críticos (scripts não-frozen/placeholders). Prosseguindo com apply-bundle.',
      );
    }

    // 2. Upload todos assets pro Supabase Storage.
    logger.info(
      { jobId: job.id, landingPageId, assetsCount: cloneResult.assets.length },
      'landinglab.squad0.clone: uploading assets to Supabase',
    );
    await emit({ phase: 'upload:started', total: cloneResult.assets.length });

    const uploadMap = await uploadDirectoryToSupabase(tmpDir, supabasePath, (done, total) => {
      // Emite a cada 5 arquivos ou no último — evita spam de eventos SSE.
      if (done === total || done % 5 === 0) {
        void emit({ phase: 'upload:progress', done, total });
      }
    });
    await emit({ phase: 'upload:done', count: uploadMap.size });

    // 3. Reescreve URLs no HTML: troca /_clone_placeholder_{id}/... pelas
    //    URLs públicas do Supabase.
    let finalHtml = cloneResult.html;
    for (const [localPath, publicUrl] of uploadMap) {
      // Deriva o path "public" que estava no HTML (relativo ao storageRoot)
      const relPath = localPath.replace(`${tmpDir}/`, '');
      const placeholderUrl = `${cloneInput.publicPathPrefix}/${relPath}`;
      // Substitui todas as ocorrências no HTML
      finalHtml = finalHtml.split(placeholderUrl).join(publicUrl);
    }

    // 4. Extrai URLs de imagem finais pra media_urls (só content-type image/*).
    const imageUrls = cloneResult.assets
      .filter((a) => a.contentType.startsWith('image/'))
      .map((a) => {
        const localFilePath = join(tmpDir, a.publicUrl.replace(cloneInput.publicPathPrefix + '/', ''));
        return uploadMap.get(localFilePath) ?? a.publicUrl;
      })
      .filter((u): u is string => Boolean(u));

    // 4.1. Wizard V2 Fatia 1 — detecção automática de marca origem.
    //      Cascata metadata → Gemini fallback. Non-blocking (falha vira null).
    //      Custo típico: $0 (metadata) até $0.0002 (Gemini). Latência: <100ms metadata, ~1s Gemini.
    let detectedBrand: string | null = null;
    try {
      const brandResult = await detectBrand(finalHtml);
      detectedBrand = brandResult.brand;
      logger.info(
        {
          jobId: job.id,
          landingPageId,
          brand: brandResult.brand,
          source: brandResult.source,
          confidence: brandResult.confidence,
          costUsd: brandResult.costUsd,
        },
        'landinglab.squad0.clone: brand detected',
      );
    } catch (err) {
      logger.warn({ jobId: job.id, err }, 'landinglab.squad0.clone: brand detection failed (non-fatal)');
    }

    // 4.2. Wizard V2 Fatia 2 — OCR + Vision metadata FOI DESACOPLADO pra
    //   job separado (landinglab.image-metadata) enfileirado APÓS o UPDATE
    //   da landing_pages abaixo. Motivos:
    //   - OCR+Vision demoram 5-10 min pra landings com 300 imagens
    //   - Vercel Runtime timeout (5min) causava erro de conexão no browser
    //   - Landing fica utilizavel imediato; wizard mostra spinner se metadata
    //     ainda nao completou
    //
    //   image_ocr_metadata continua NULL neste UPDATE. Job image-metadata
    //   preenche depois via UPDATE separado.
    const imageOcrMetadata: Array<Record<string, unknown>> = [];

    // ─────────────────────────────────────────────────────────────────
    // Clone Source Preservation — Fase 9E.1 CLOSURE (27/09/2026)
    //
    // ORDEM CORRETA: persist clone-initial ANTES do UPDATE em html_body.
    //
    // Contrato garantido:
    //   clone-initial.sha256 === html_body inicial persistido (sempre)
    //
    // Cenários:
    //   1. Primeira execução: INSERT clone-initial(finalHtml) → UPDATE html_body=finalHtml
    //      → clone-initial === html_body ✅
    //   2. Retry com mesmo HTML: já existe clone-initial com mesmo sha
    //      → created=false, diverged=false → UPDATE html_body=finalHtml
    //      → clone-initial === html_body ✅
    //   3. Retry com HTML DIFERENTE: existe clone-initial com sha diferente
    //      → created=false, diverged=true → THROW. UPDATE html_body NÃO acontece.
    //      → html_body preserva versão anterior. Bloqueia downstream.
    //
    // Bug pré-CLOSURE: persist rodava DEPOIS do UPDATE. Retry divergente
    // sobrescrevia html_body com HTML novo mesmo preservando snapshot antigo.
    // Snapshot ficava fiel MAS html_body divergia → contrato quebrado.
    // ─────────────────────────────────────────────────────────────────
    const cloneInitialSha = createHash('sha256').update(finalHtml).digest('hex');
    const cloneInitialResult = await persistCloneInitialSnapshot(
      db as never,
      landingHtmlSnapshots,
      and(
        eq(landingHtmlSnapshots.landingPageId, landingPageId),
        eq(landingHtmlSnapshots.reason, 'clone-initial'),
      ),
      landingPageId,
      {
        createdAt: new Date().toISOString(),
        bytes: finalHtml.length,
        sha256: cloneInitialSha,
        htmlBody: finalHtml,
        reason: 'clone-initial',
        actor: `worker/clone:${job.id ?? 'unknown'}`,
      },
    );

    if (!cloneInitialResult.ok) {
      // Erro de infra (DB down, race grave). Job throw → BullMQ retry (attempts=3).
      // UPDATE html_body NÃO acontece. Downstream NÃO enfileirado.
      logger.error(
        {
          jobId: job.id,
          landingPageId,
          error: cloneInitialResult.error,
        },
        'landinglab.squad0.clone: FAILED to preserve clone-initial source — throwing to retry',
      );
      throw new Error(
        `Clone source preservation failed for landing ${landingPageId}: ${cloneInitialResult.error}`,
      );
    }

    if (cloneInitialResult.diverged) {
      // Retry gerou HTML diferente do snapshot preservado.
      // Snapshot original PRESERVADO. UPDATE html_body NÃO deve acontecer
      // (senão html_body ficaria divergente do source). Throw pra bloquear
      // tudo — comportamento intencional pra manter contrato:
      //   clone-initial.sha256 === html_body inicial
      //
      // BullMQ retry pode ajudar se divergência foi por network flakiness
      // (mesmo URL agora retorna mesmo HTML → sha bate → OK). Se persistir,
      // operator deve inspecionar via landing_html_snapshots.
      logger.error(
        {
          jobId: job.id,
          landingPageId,
          preservedSha: cloneInitialResult.currentSha,
          newSha: cloneInitialSha,
          bytes: finalHtml.length,
        },
        'landinglab.squad0.clone: clone-initial DIVERGED on retry — original preserved, blocking UPDATE + downstream',
      );
      throw new Error(
        `Clone-initial divergence for landing ${landingPageId}: preserved sha ${cloneInitialResult.currentSha?.slice(0, 12)}, new sha ${cloneInitialSha.slice(0, 12)}. UPDATE bloqueado pra manter contrato clone-initial === html_body.`,
      );
    }

    logger.info(
      {
        jobId: job.id,
        landingPageId,
        cloneInitialSha,
        bytes: finalHtml.length,
        created: cloneInitialResult.created,
      },
      cloneInitialResult.created
        ? 'landinglab.squad0.clone: clone-initial source preserved (new)'
        : 'landinglab.squad0.clone: clone-initial source already existed with same sha (idempotent retry)',
    );

    // 5. UPDATE landing_pages com resultado.
    // Wizard V2: brand_from (detectado auto) + image_ocr_metadata populados.
    await db
      .update(landingPages)
      .set({
        htmlBody: finalHtml,
        mediaUrls: imageUrls,
        title: cloneResult.title || 'Landing clonada',
        sourceUrl: url,
        sourceType: 'other_url',
        generationMode: 'cloned',
        clonedAt: new Date(),
        // Story 15.2: moeda detectada na origem substitui a provisória.
        ...(currencyIsPlaceholder && cloneResult.detectedCurrency
          ? { currency: cloneResult.detectedCurrency }
          : {}),
        cloneMetadata: {
          currency_source: currencyIsPlaceholder
            ? cloneResult.detectedCurrency
              ? 'detected'
              : 'placeholder'
            : 'kept',
          detected_currency: cloneResult.detectedCurrency ?? null,
          source_url: cloneResult.finalUrl,
          bytes: cloneResult.bytes,
          latency_ms: cloneResult.latencyMs,
          assets_ok: cloneResult.assets.length,
          assets_failed: cloneResult.failedAssets.length,
          images_count: imageUrls.length,
          trace: cloneResult.trace,
          supabase_bucket: SUPABASE_BUCKET,
          supabase_path: supabasePath,
          // Fidelity gate consumer (2026-09-28) — additive fields in JSONB.
          // Operator UI/queries podem filtrar landings BLOCKED/DEGRADED via ->>'fidelity_verdict'.
          fidelity_verdict: cloneResult.fidelityVerdict ?? null,
          fidelity_blocked: cloneResult.fidelityBlocked ?? false,
          fidelity_degraded: cloneResult.fidelityDegraded ?? false,
          fidelity_findings: cloneResult.fidelityFindings ?? [],
          // Observability metrics (2026-09-29) — não afeta verdict, só debug/tuning.
          fidelity_metrics: cloneResult.fidelityMetrics ?? null,
        },
        // Wizard V2 Fatia 1: marca detectada pré-preenche o step "Marca".
        // Só sobrescreve se ainda não estiver setada (respeita edições manuais).
        ...(detectedBrand ? { brandFrom: detectedBrand } : {}),
        // Wizard V2 Fatia 2: metadata OCR pra grid de seleção.
        imageOcrMetadata: imageOcrMetadata as never,
        // Bundle Engine V2 (set/2026): flag + adapter metadata.
        // useNewBundleEngine=true SÓ quando adapter detectou >= 1 oferta.
        // Bepurex/legacy sem detecção ficam com flag=false (fluxo antigo intacto).
        useNewBundleEngine:
          cloneResult.bundleAdapter != null &&
          cloneResult.bundleAdapter !== 'none' &&
          (cloneResult.bundleOffers?.length ?? 0) > 0,
        bundleAdapter: cloneResult.bundleAdapter ?? 'none',
        bundleAdapterNotes: cloneResult.bundleAdapterNotes ?? null,
        updatedAt: new Date(),
      })
      .where(eq(landingPages.id, landingPageId));

    // Bundle Engine V2 — persistir ofertas detectadas. Substitui rows
    // antigas (delete-then-insert) pra reclones idempotentes.
    if (cloneResult.bundleOffers && cloneResult.bundleOffers.length > 0) {
      try {
        await db.delete(landingBundleOffers).where(eq(landingBundleOffers.landingPageId, landingPageId));
        await db.insert(landingBundleOffers).values(
          cloneResult.bundleOffers.map((o) => ({
            landingPageId,
            position: o.position,
            title: o.title,
            qty: o.qty,
            priceCents: o.priceCents,
            compareAtCents: o.compareAtCents ?? null,
            saveText: o.saveText ?? null,
            badge: o.badge ?? null,
            variantId: null, // usuário mapeia pro variant Shopify DELE no painel
            isPreselected: o.isPreselected,
            bullets: o.bullets ?? [], // Story 25.1
          })),
        );
        logger.info(
          { landingPageId, adapter: cloneResult.bundleAdapter, count: cloneResult.bundleOffers.length },
          'clone: bundle offers persisted (Engine V2)',
        );
      } catch (err) {
        logger.warn({ landingPageId, err }, 'clone: falha ao persistir bundle offers (não-fatal)');
      }
    }

    // 5.1. Wizard V2 — enfileira job image-metadata em background (OCR + Vision).
    //   Roda ~5-10 min, atualiza image_ocr_metadata quando termina. Non-fatal.
    try {
      const connectionString = process.env['REDIS_URL'];
      if (connectionString) {
        const imageMetaQueue = new Queue('landinglab.image-metadata', {
          connection: new Redis(connectionString, { maxRetriesPerRequest: null }),
        });
        await imageMetaQueue.add(
          'ImageMetadataJob',
          {
            landingPageId,
            brandOrigin: detectedBrand,
            sourceLanguage: cloneResult.detectedLanguage ?? 'en',
            imageUrls,
          },
          {
            jobId: `image-metadata-${landingPageId}-${Date.now()}`,
            attempts: 2,
            removeOnComplete: { age: 3600, count: 100 },
            removeOnFail: { age: 86400 },
          },
        );
        logger.info(
          { jobId: job.id, landingPageId, images: imageUrls.length },
          'clone: image-metadata job enqueued (background)',
        );
      }
    } catch (err) {
      logger.warn({ jobId: job.id, err }, 'clone: failed to enqueue image-metadata (non-fatal)');
    }

    // 6. Chain: se o Wizard pediu tradução, enfileira translate-text agora
    //    (que por sua vez enfileira translate-images se initial_translate_images).
    //    Falhas aqui não invalidam o clone — apenas marcam warning na landing.
    const [chainRow] = await db
      .select({
        initialTargetLanguage: landingPages.initialTargetLanguage,
        initialTranslateImages: landingPages.initialTranslateImages,
        brandFrom: landingPages.brandFrom,
        brandTo: landingPages.brandTo,
      })
      .from(landingPages)
      .where(eq(landingPages.id, landingPageId))
      .limit(1);

    let translationChained = false;
    if (chainRow?.initialTargetLanguage) {
      const queue = getTranslateTextQueue();
      if (queue) {
        try {
          await db
            .update(landingPages)
            .set({
              translationStatus: 'text_pending',
              translationProgress: dsql`jsonb_build_object(
                'phase', 'text:queued',
                'lastUpdatedAt', ${new Date().toISOString()}::text
              )`,
              updatedAt: new Date(),
            })
            .where(eq(landingPages.id, landingPageId));

          await queue.add(
            'TranslateTextJob',
            {
              landingPageId,
              targetLanguage: chainRow.initialTargetLanguage,
              sourceLanguage: 'auto',
              brandFrom: (chainRow.brandFrom as string | null) ?? null,
              brandTo: (chainRow.brandTo as string | null) ?? null,
            },
            {
              jobId: `translate-text-${landingPageId}-${Date.now()}`,
              attempts: 2,
              backoff: { type: 'exponential', delay: 5_000 },
              removeOnComplete: { age: 3600, count: 100 },
              removeOnFail: { age: 86400 },
            },
          );
          translationChained = true;
          logger.info(
            {
              jobId: job.id,
              landingPageId,
              targetLanguage: chainRow.initialTargetLanguage,
              translateImages: chainRow.initialTranslateImages,
            },
            'landinglab.squad0.clone: translate-text chain enqueued',
          );
        } catch (err) {
          logger.warn(
            { jobId: job.id, landingPageId, err },
            'landinglab.squad0.clone: failed to enqueue translate-text chain (non-fatal)',
          );
          await db
            .update(landingPages)
            .set({
              translationStatus: 'failed',
              translationProgress: dsql`jsonb_build_object(
                'phase', 'error',
                'message', 'Clone OK mas falhou ao enfileirar tradução',
                'lastUpdatedAt', ${new Date().toISOString()}::text
              )`,
            })
            .where(eq(landingPages.id, landingPageId))
            .catch(() => {});
        }
      }
    }

    await emit({
      phase: 'complete',
      bytes: cloneResult.bytes,
      assetsCount: cloneResult.assets.length,
      imagesCount: imageUrls.length,
      translationChained,
      latencyMs: Date.now() - startedAt,
    });

    const latencyMs = Date.now() - startedAt;
    logger.info(
      {
        jobId: job.id,
        landingPageId,
        bytes: cloneResult.bytes,
        assetsCount: cloneResult.assets.length,
        latencyMs,
      },
      'landinglab.squad0.clone: completed',
    );

    return {
      ok: true,
      bytes: cloneResult.bytes,
      assetsCount: cloneResult.assets.length,
      latencyMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { jobId: job.id, landingPageId, err, message },
      'landinglab.squad0.clone: failed',
    );
    await emit({ phase: 'error', message });
    // Persiste clone_status='failed' — UI deriva lifecycle sem depender de htmlBody.
    // Se BullMQ fizer retry, o route.ts já reescreveu clone_metadata com
    // clone_status='cloning' antes de enfileirar (SB-08).
    try {
      await db
        .update(landingPages)
        .set({
          cloneMetadata: { clone_status: 'failed', clone_error: message },
          updatedAt: new Date(),
        })
        .where(eq(landingPages.id, landingPageId));
    } catch (persistErr) {
      logger.warn({ jobId: job.id, persistErr }, 'clone: failed to persist clone_status=failed (non-fatal)');
    }
    // Rethrow pra BullMQ marcar job como failed (aciona retry conforme
    // DEFAULT_JOB_OPTIONS do worker).
    throw err;
  } finally {
    // Cleanup: apaga tmp dir (assets já foram uploaded pro Supabase).
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      logger.warn(
        { jobId: job.id, tmpDir, err: cleanupErr },
        'landinglab.squad0.clone: cleanup failed (non-fatal)',
      );
    }
    await sql.end();
  }
}
