// LandingLab · Export da landing (zip HTML portátil + zip de tema Shopify).
//
// Roda no worker porque os pacotes passam fácil do limite de resposta da Vercel (4,5 MB):
// baixa os assets, monta os dois zips e sobe no bucket privado `landing-exports`.
// O backoffice lista os arquivos e gera links assinados na hora de baixar.
//
// Caminho: landing-exports/{landingPageId}/{timestamp}-{html|shopify}.zip

import { createClient, landingBundleOffers, landingMarkets, landingPages } from '@blackshop/db';
import type { Job } from 'bullmq';
import { normalizeOffersSource, type OffersSource } from '@blackshop/shared/landing-offers';
import { asc, eq } from 'drizzle-orm';

import { buildLandingExport, landingSlug } from '../lib/landing-export/build-export.js';
import { logger } from '../logger.js';
import { getSupabaseAdmin } from '../supabase.js';

export const LANDING_EXPORTS_BUCKET = 'landing-exports';

export interface LandingExportJobData {
  landingPageId: string;
}

export interface LandingExportResult {
  landingPageId: string;
  files: Array<{ format: 'html' | 'shopify'; path: string; bytes: number }>;
  stats: { assets: number; assetBytes: number; failed: number; skipped: number; removedScripts: number };
}

export async function processLandingExport(job: Job<LandingExportJobData>): Promise<LandingExportResult> {
  const { landingPageId } = job.data;
  if (!landingPageId || !/^[0-9a-f-]{36}$/i.test(landingPageId)) throw new Error('landingPageId inválido');

  const { db, sql } = createClient({
    databaseUrl: process.env['DATABASE_URL'] ?? 'postgresql://blackshop:changeme@localhost:5432/blackshop',
  });
  try {
    const [row] = await db
      .select({
        id: landingPages.id,
        slug: landingPages.slug,
        title: landingPages.title,
        htmlBody: landingPages.htmlBody,
        customCss: landingPages.customCss,
        currency: landingPages.currency,
        sourceUrl: landingPages.sourceUrl,
        contentLanguage: landingPages.contentLanguage,
        checkoutProvider: landingPages.checkoutProvider,
        marketLocale: landingMarkets.locale,
      })
      .from(landingPages)
      .leftJoin(landingMarkets, eq(landingMarkets.id, landingPages.marketId))
      .where(eq(landingPages.id, landingPageId))
      .limit(1);
    if (!row) throw new Error(`Landing ${landingPageId} não encontrada`);
    if (!row.htmlBody || row.htmlBody.trim().length < 100) throw new Error('Landing sem HTML para exportar');

    const baseOffers = await db
      .select({
        position: landingBundleOffers.position,
        title: landingBundleOffers.title,
        qty: landingBundleOffers.qty,
        priceCents: landingBundleOffers.priceCents,
        compareAtCents: landingBundleOffers.compareAtCents,
        badge: landingBundleOffers.badge,
        saveText: landingBundleOffers.saveText,
        variantId: landingBundleOffers.variantId,
        isPreselected: landingBundleOffers.isPreselected,
      })
      .from(landingBundleOffers)
      .where(eq(landingBundleOffers.landingPageId, landingPageId))
      .orderBy(asc(landingBundleOffers.position));

    // Story 25.2 — modo, bullets e link (colunas da 0115) numa consulta à parte: sem a migration,
    // o export segue no modo "página" sem bullets nem link próprio, como antes.
    let offersSource: OffersSource = 'page';
    const extras = new Map<number, { bullets: string[]; checkoutUrl: string | null }>();
    try {
      const [page] = await db
        .select({ offersSource: landingPages.offersSource })
        .from(landingPages)
        .where(eq(landingPages.id, landingPageId))
        .limit(1);
      const rows = await db
        .select({
          position: landingBundleOffers.position,
          bullets: landingBundleOffers.bullets,
          checkoutUrl: landingBundleOffers.checkoutUrl,
        })
        .from(landingBundleOffers)
        .where(eq(landingBundleOffers.landingPageId, landingPageId));
      offersSource = normalizeOffersSource(page?.offersSource);
      for (const r of rows) extras.set(r.position, { bullets: r.bullets ?? [], checkoutUrl: r.checkoutUrl });
    } catch (err) {
      logger.warn({ landingPageId, err: (err as Error).message }, 'export: colunas da 0115 indisponíveis, modo página');
    }
    const offers = baseOffers.map((o) => ({
      ...o,
      bullets: extras.get(o.position)?.bullets ?? [],
      checkoutUrl: extras.get(o.position)?.checkoutUrl ?? null,
    }));

    await job.updateProgress({ step: 'assets' });
    // Mesma loja que o storefront usa para o /cart/{variante}:1. Só faz sentido no checkout Shopify.
    const storeDomain =
      row.checkoutProvider === 'shopify'
        ? (process.env['SHOPIFY_STORE_DOMAIN']?.trim() || 'authentic-10069.myshopify.com')
        : null;
    const landing = {
      id: row.id,
      slug: row.slug,
      title: row.title,
      htmlBody: row.htmlBody,
      customCss: row.customCss,
      currency: row.currency,
      sourceUrl: row.sourceUrl,
      locale: row.marketLocale ?? row.contentLanguage ?? null,
      offersSource,
    };
    const result = await buildLandingExport(landing, offers, { storeDomain });

    await job.updateProgress({ step: 'upload' });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = landingSlug(landing);
    const storage = getSupabaseAdmin().storage.from(LANDING_EXPORTS_BUCKET);
    const files: LandingExportResult['files'] = [];
    for (const [format, data] of [
      ['html', result.html],
      ['shopify', result.shopify],
    ] as const) {
      const path = `${landingPageId}/${stamp}-${slug}-${format}.zip`;
      const { error } = await storage.upload(path, data, { contentType: 'application/zip', upsert: false });
      if (error) throw new Error(`Upload ${format} falhou: ${error.message}`);
      files.push({ format, path, bytes: data.length });
    }

    logger.info({ jobId: job.id, landingPageId, files, stats: result.stats }, 'landinglab.export: done');
    return { landingPageId, files, stats: result.stats };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}
