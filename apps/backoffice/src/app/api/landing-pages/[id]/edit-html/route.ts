// POST /api/landing-pages/[id]/edit-html
//
// Endpoint único pra edições no htmlBody de uma landing.
// Aceita "operations" — cada seção do Editor Panel envia sua operação:
//
//   { operation: 'set-price-currency', price: '39.90', currency: 'EUR' }
//   { operation: 'set-bundle-prices', bundles: [{ id: 'A', price: '29.90' }, ...] }
//   { operation: 'reorder-carousel-images', imageIndexOrder: [2, 0, 1, 3, ...] }
//   { operation: 'replace-carousel-image', slotIndex: 2, newImageUrl: 'https://...' }
//   { operation: 'update-cta-urls', mappings: [{ oldHref: '...', newHref: '...' }, ...] }
//
// Todas operações são idempotentes (aplicar 2x = mesmo resultado).
// Retorna { ok, message, updatedFields[] }.

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import * as cheerio from 'cheerio';
import { landingPages } from '@blackshop/db';

import { enqueueApplyBundle } from '@/lib/enqueue-apply-bundle';
import { getDb } from '@/lib/landing-db';
import { requireAdminRequest } from '@/lib/admin/auth-guard';
import {
  applySetPriceCurrency,
  type HandlerResult,
  type SetPriceCurrencyOp,
} from '@/lib/landing-currency-html';

const STORE_ID = 'l0i';

export const runtime = 'nodejs';
export const maxDuration = 20;

interface SetBundlePricesOp {
  operation: 'set-bundle-prices';
  bundles: Array<{ id: string; price: string }>;
}

interface ReorderCarouselImagesOp {
  operation: 'reorder-carousel-images';
  imageIndexOrder: number[]; // ex: [2, 0, 1, 3] — nova ordem baseada em index atual
}

interface ReplaceCarouselImageOp {
  operation: 'replace-carousel-image';
  slotIndex: number;
  newImageUrl: string;
}

interface UpdateCtaUrlsOp {
  operation: 'update-cta-urls';
  mappings: Array<{ oldHref: string; newHref: string }>;
}

type Operation =
  | SetPriceCurrencyOp
  | SetBundlePricesOp
  | ReorderCarouselImagesOp
  | ReplaceCarouselImageOp
  | UpdateCtaUrlsOp;

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;

  const landingId = params.id;
  if (!landingId) {
    return NextResponse.json({ ok: false, message: 'landing id obrigatório' }, { status: 400 });
  }

  let body: Operation;
  try {
    body = (await req.json()) as Operation;
  } catch {
    return NextResponse.json({ ok: false, message: 'JSON inválido' }, { status: 400 });
  }

  const db = getDb();
  const [row] = await db
    .select({
      htmlBody: landingPages.htmlBody,
      currency: landingPages.currency,
      price: landingPages.price,
      marketId: landingPages.marketId,
    })
    .from(landingPages)
    .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)))
    .limit(1);
  if (!row) {
    return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });
  }

  let html = row.htmlBody;
  const updatedFields: string[] = [];
  const dbPatch: Record<string, unknown> = { updatedAt: new Date() };
  // Fix Fase 8E (26/09/2026): quando currency muda, precisa reprocessar
  // via worker apply-bundle. Sem isso, bundle cards (.kaching-bundles__bar-price)
  // ficam com símbolo da currency antiga porque este endpoint só reescreve
  // seletores .money/.price-item/[data-price]/.cta-price + product-json.
  // Bug real ocorreu 26/09: USD→EUR mudou banco mas HTML dos bundles ficou $.
  let currencyChanged = false;

  try {
    if (body.operation === 'set-price-currency') {
      // Story 15.2: com mercado definido, a moeda vem do mercado (fonte única).
      if (
        row.marketId &&
        body.currency &&
        body.currency.toUpperCase() !== (row.currency ?? '').toUpperCase()
      ) {
        return NextResponse.json(
          {
            ok: false,
            message: 'A moeda desta landing é definida pelo mercado. Altere na seção Mercado e checkout.',
          },
          { status: 409 },
        );
      }
      const r = applySetPriceCurrency(html, body, row.currency, row.price);
      html = r.html;
      updatedFields.push(...r.updatedFields);
      Object.assign(dbPatch, r.dbPatch);
      // Detecta se currency realmente mudou (não só o preço na mesma moeda)
      const newCurrency = (body.currency ?? row.currency).toUpperCase();
      const oldCurrency = (row.currency ?? '').toUpperCase();
      currencyChanged = newCurrency !== oldCurrency;
    } else if (body.operation === 'set-bundle-prices') {
      const r = applySetBundlePrices(html, body);
      html = r.html;
      updatedFields.push(...r.updatedFields);
    } else if (body.operation === 'reorder-carousel-images') {
      const r = applyReorderCarouselImages(html, body);
      html = r.html;
      updatedFields.push(...r.updatedFields);
    } else if (body.operation === 'replace-carousel-image') {
      const r = applyReplaceCarouselImage(html, body);
      html = r.html;
      updatedFields.push(...r.updatedFields);
    } else if (body.operation === 'update-cta-urls') {
      const r = applyUpdateCtaUrls(html, body);
      html = r.html;
      updatedFields.push(...r.updatedFields);
    } else {
      return NextResponse.json(
        { ok: false, message: `Operation não suportada: ${String((body as { operation?: string }).operation)}` },
        { status: 400 },
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, message: `Erro ao aplicar edição: ${msg}` }, { status: 500 });
  }

  // Persistir HTML atualizado + campos DB derivados (currency, price)
  await db
    .update(landingPages)
    .set({ htmlBody: html, ...dbPatch })
    .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)));

  // Fix Fase 8E: se currency mudou, enfileirar apply-bundle pra reprocessar
  // bundle cards (.kaching-bundles__bar-price) com currency nova via worker.
  // Sem isso, os cards permanecem com símbolo antigo pois este endpoint não
  // cobre esses seletores (por design — bundle rendering é responsabilidade
  // do worker, conforme arquitetura canônica Fase 2).
  let reprocessing = false;
  let reprocessJobId: string | undefined;
  let reprocessDeduped = false;
  let reprocessSkippedReason: string | undefined;
  if (currencyChanged) {
    const enqueue = await enqueueApplyBundle(landingId, 'edit-html:set-price-currency');
    reprocessing = enqueue.queued;
    reprocessJobId = enqueue.jobId;
    reprocessDeduped = enqueue.deduped ?? false;
    if (!enqueue.queued) reprocessSkippedReason = enqueue.reason;
  }

  return NextResponse.json({
    ok: true,
    message: `${updatedFields.length} alteração(ões) aplicada(s).`,
    updatedFields,
    reprocessing,
    jobId: reprocessJobId,
    deduped: reprocessDeduped,
    reprocessSkipped: reprocessSkippedReason,
  });
}

// ─── Handlers de operação ─────────────────────────────────────────────────

/**
 * SET-BUNDLE-PRICES: atualiza preços dentro do kaching-bundles-config JSON.
 * Cada bundle é identificado por um ID (posicional ou custom do JSON).
 */
function applySetBundlePrices(html: string, op: SetBundlePricesOp): HandlerResult {
  const $ = cheerio.load(html);
  const updatedFields: string[] = [];

  // Kaching guarda bundles em kaching-bundles-config → bundles[].price OR
  // em kaching-bundles-deal-block-settings → deals[].price
  $('script[id="kaching-bundles-config"], script.kaching-bundles-deal-block-settings').each((_, el) => {
    const rawContent = $(el).html() || '';
    if (!rawContent.trim().startsWith('{') && !rawContent.trim().startsWith('[')) return;
    try {
      const data = JSON.parse(rawContent) as Record<string, unknown>;
      let touched = false;
      // Estrutura pode ser bundles[] OR deals[] OR similar
      for (const key of ['bundles', 'deals', 'offers']) {
        const arr = data[key];
        if (!Array.isArray(arr)) continue;
        for (let i = 0; i < arr.length; i++) {
          const bundle = arr[i] as Record<string, unknown>;
          if (!bundle || typeof bundle !== 'object') continue;
          const bundleId = String(bundle['id'] ?? bundle['dealId'] ?? bundle['name'] ?? i);
          const patch = op.bundles.find((b) => b.id === bundleId);
          if (!patch) continue;
          const priceNum = Number(patch.price);
          if (!Number.isFinite(priceNum)) continue;
          bundle['price'] = Math.round(priceNum * 100); // cents
          touched = true;
          updatedFields.push(`bundle-${bundleId}=${patch.price}`);
        }
      }
      if (touched) {
        $(el).text(JSON.stringify(data));
      }
    } catch {
      // silêncio
    }
  });

  return { html: $.html(), updatedFields };
}

/**
 * REORDER-CAROUSEL-IMAGES: reordena os slides principais + thumbs do carrossel
 * de produto (padrão .pss-main-slide + .pss-thumb com data-index, ou
 * Broadcast theme: [data-image-gallery-type="product"] com img.shop-main-image).
 */
function applyReorderCarouselImages(html: string, op: ReorderCarouselImagesOp): HandlerResult {
  const $ = cheerio.load(html);
  const updatedFields: string[] = [];

  // Broadcast theme (Chemistry Club): reordena trocando srcs nos wrappers existentes
  if ($('[data-image-gallery-type="product"]').length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrappers: any[] = [];
    $('[data-image-gallery-type="product"]').each((_, wrapper) => {
      // Filtra apenas containers que possuem img.shop-main-image filho direto/descendente.
      // O atributo data-image-gallery-type="product" aparece tanto no div-wrapper
      // quanto no img filho — sem este guard o array fica com o dobro de entradas.
      if ($(wrapper).find('img.shop-main-image').length > 0) wrappers.push(wrapper);
    });
    if (wrappers.length > 0 && wrappers.length === op.imageIndexOrder.length) {
      const originalSrcs = wrappers.map((w) => $(w).find('img.shop-main-image').first().attr('src') ?? '');
      op.imageIndexOrder.forEach((oldIdx, newIdx) => {
        const $img = $(wrappers[newIdx]).find('img.shop-main-image').first();
        if ($img.length > 0) {
          $img.attr('src', originalSrcs[oldIdx] ?? '');
          $img.attr('loading', newIdx === 0 ? 'eager' : 'lazy');
        }
      });
      updatedFields.push('broadcast-gallery-reordered');
    }
    return { html: $.html(), updatedFields };
  }

  for (const containerSelector of ['pss-main-slide', 'pss-thumb']) {
    // Coleta elementos ordenados pelo data-index atual
    const items = $(`.${containerSelector}`).toArray();
    if (items.length === 0) continue;
    if (items.length !== op.imageIndexOrder.length) {
      throw new Error(
        `Reorder falhou: HTML tem ${items.length} slides de ${containerSelector}, mas order tem ${op.imageIndexOrder.length}`,
      );
    }
    // Cria novo array na ordem desejada
    const reordered = op.imageIndexOrder.map((oldIdx) => items[oldIdx]);
    // Atualiza data-index dos elementos + insere na nova ordem
    const parent = $(items[0]!).parent();
    for (let newIdx = 0; newIdx < reordered.length; newIdx++) {
      const el = reordered[newIdx]!;
      $(el).attr('data-index', String(newIdx));
      // Reappend ao parent na ordem correta
      parent.append(el);
    }
    updatedFields.push(`${containerSelector}-reordered`);
  }

  return { html: $.html(), updatedFields };
}

/**
 * REPLACE-CAROUSEL-IMAGE: substitui src da imagem em um slot específico
 * (main slide + thumb correspondente, ou Broadcast theme por índice posicional).
 */
function applyReplaceCarouselImage(html: string, op: ReplaceCarouselImageOp): HandlerResult {
  const $ = cheerio.load(html);
  const updatedFields: string[] = [];

  // Broadcast theme (Chemistry Club): substitui por índice posicional nos wrappers
  if ($('[data-image-gallery-type="product"]').length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrappers: any[] = [];
    $('[data-image-gallery-type="product"]').each((_, wrapper) => {
      // Filtra apenas containers com img.shop-main-image filho — evita duplicação
      // causada por o atributo existir tanto no div-wrapper quanto no img filho.
      if ($(wrapper).find('img.shop-main-image').length > 0) wrappers.push(wrapper);
    });
    const wrapper = wrappers[op.slotIndex];
    if (wrapper) {
      const $img = $(wrapper).find('img.shop-main-image').first();
      if ($img.length > 0) {
        $img.attr('src', op.newImageUrl);
        $img.attr('loading', op.slotIndex === 0 ? 'eager' : 'lazy');
        $img.removeAttr('srcset');
        $img.removeAttr('data-srcset');
        $img.removeAttr('data-src');
        updatedFields.push(`broadcast-gallery-${op.slotIndex}`);
      }
    }
    return { html: $.html(), updatedFields };
  }

  for (const containerSelector of ['pss-main-slide', 'pss-thumb']) {
    const el = $(`.${containerSelector}[data-index="${op.slotIndex}"]`).first();
    if (el.length === 0) continue;
    // Substitui src de todas imgs dentro
    el.find('img').each((_, imgEl) => {
      $(imgEl).attr('src', op.newImageUrl);
      $(imgEl).removeAttr('srcset'); // srcset apontava pra CDN original
      $(imgEl).removeAttr('data-srcset');
    });
    updatedFields.push(`${containerSelector}-${op.slotIndex}`);
  }

  return { html: $.html(), updatedFields };
}

/**
 * UPDATE-CTA-URLS: substitui href de <a> ou <button formaction> por novo destino.
 * Feita por match exato (oldHref → newHref) — evita colateral.
 */
function applyUpdateCtaUrls(html: string, op: UpdateCtaUrlsOp): HandlerResult {
  let updatedHtml = html;
  const updatedFields: string[] = [];
  for (const mapping of op.mappings) {
    if (!mapping.oldHref || !mapping.newHref) continue;
    const escaped = mapping.oldHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`href="${escaped}"`, 'g');
    const before = updatedHtml.length;
    updatedHtml = updatedHtml.replace(regex, `href="${mapping.newHref}"`);
    if (updatedHtml.length !== before) {
      updatedFields.push(`cta ${mapping.oldHref.slice(0, 40)} → ${mapping.newHref.slice(0, 40)}`);
    }
  }
  return { html: updatedHtml, updatedFields };
}
