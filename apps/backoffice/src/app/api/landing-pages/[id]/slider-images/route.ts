// GET  /api/landing-pages/:id/slider-images
//        → lista URLs das <img> do slider principal do produto (ordem preservada).
// POST /api/landing-pages/:id/slider-images
//        multipart:
//          - orderedUrls: JSON<string[]> (ordem exata desejada das imagens existentes)
//          - newFiles: File[] (uploads novos — adicionados após ordered)
//        → substitui completamente o conteúdo do swiper-wrapper (main+thumbs)
//          com slides na ordem exata. Persiste html_body.
//
// Usa CHEERIO (parser DOM real) — regex era frágil demais pra HTML aninhado.
// Cheerio garante que só o main slider é modificado, thumbs seguem em paralelo,
// e outros swiper-wrappers da página (timeline, doctors-see, customer-notice)
// ficam intocados.

import crypto from 'node:crypto';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { landingPages } from '@blackshop/db/schema-landinglab-core';

import { enqueueApplyBundle } from '@/lib/enqueue-apply-bundle';
import { getDb } from '@/lib/landing-db';
import { requireAdminRequest } from '@/lib/admin/auth-guard';

const STORE_ID = 'l0i';
const BUCKET = 'cloned-landings';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface Ctx {
  params: { id: string };
}

// Detecta tema do HTML e retorna extract/rewrite functions.
// Selectors específicos garantem que só a galeria principal é afetada.
interface ThemeAdapter {
  name: string;
  detect: ($: cheerio.CheerioAPI) => boolean;
  // Retorna URLs das imagens do slider principal, na ordem do DOM
  extractSliderUrls: ($: cheerio.CheerioAPI) => string[];
  // Reescreve slider (main + thumbs) com nova ordem. Modifica $ in-place.
  rewriteSlider: ($: cheerio.CheerioAPI, orderedUrls: string[]) => void;
}

// Aurivita — usa .cc-pdp__main (main slider) + .cc-pdp__thumbs (thumbnails).
// Cada slide é <div class="swiper-slide cc-pdp__main-slide"><img ...></div>
// Thumbs são <div class="swiper-slide cc-pdp__thumb"><img ...></div>
const AURIVITA_ADAPTER: ThemeAdapter = {
  name: 'cc-pdp',
  detect: ($) => $('.cc-pdp__main .cc-pdp__main-slide, .cc-pdp__main-wrap').length > 0,
  extractSliderUrls: ($) => {
    const urls: string[] = [];
    const seen = new Set<string>();
    $('.cc-pdp__main .cc-pdp__main-slide img').each((_, el) => {
      const src = $(el).attr('src');
      if (!src || !src.includes('supabase.co') || src.startsWith('data:')) return;
      if (seen.has(src)) return;
      seen.add(src);
      urls.push(src);
    });
    return urls;
  },
  rewriteSlider: ($, orderedUrls) => {
    // ── Main slider: escolhe o .swiper-wrapper DENTRO de .cc-pdp__main
    const mainWrapper = $('.cc-pdp__main .swiper-wrapper').first();
    if (mainWrapper.length > 0) {
      const mainHtml = orderedUrls
        .map((url, idx) => {
          const active = idx === 0 ? ' swiper-slide-active ll-active-main' : idx === 1 ? ' swiper-slide-next' : '';
          return `<div class="swiper-slide cc-pdp__main-slide${active}" role="group" aria-label="${idx + 1} / ${orderedUrls.length}"><div class="cc-pdp__badges"></div><img src="${escapeAttr(url)}" alt="Product image ${idx + 1}" loading="eager" class="cc-pdp__main-image"></div>`;
        })
        .join('\n');
      mainWrapper.empty().html(mainHtml);
    }

    // ── Thumbs slider: mesmo pattern com class cc-pdp__thumb
    const thumbsWrapper = $('.cc-pdp__thumbs .swiper-wrapper, .cc-pdp__thumbs-wrap .swiper-wrapper').first();
    if (thumbsWrapper.length > 0) {
      const thumbsHtml = orderedUrls
        .map((url, idx) => {
          const active = idx === 0 ? ' swiper-slide-active ll-active-thumb' : '';
          return `<div class="swiper-slide cc-pdp__thumb${active}"><img src="${escapeAttr(url)}" alt="Thumb ${idx + 1}" loading="lazy" class="cc-pdp__thumb-image"></div>`;
        })
        .join('\n');
      thumbsWrapper.empty().html(thumbsHtml);
    }
  },
};

// Bepurex / Kaching — <media-gallery> com <li class="product__media-item">
const MEDIA_GALLERY_ADAPTER: ThemeAdapter = {
  name: 'media-gallery',
  detect: ($) => $('media-gallery').length > 0,
  extractSliderUrls: ($) => {
    const urls: string[] = [];
    const seen = new Set<string>();
    $('media-gallery img').each((_, el) => {
      const src = $(el).attr('src');
      if (!src || !src.includes('supabase.co') || src.startsWith('data:')) return;
      if (seen.has(src)) return;
      seen.add(src);
      urls.push(src);
    });
    return urls;
  },
  rewriteSlider: ($, orderedUrls) => {
    const gallery = $('media-gallery').first();
    if (gallery.length === 0) return;
    const inner = orderedUrls
      .map(
        (url, idx) =>
          `<li class="product__media-item"><img src="${escapeAttr(url)}" alt="Media ${idx + 1}" loading="${idx === 0 ? 'eager' : 'lazy'}"></li>`,
      )
      .join('\n');
    gallery.empty().html(inner);
  },
};

// Chemistry Club / Broadcast theme — usa .shop-image-zoom-wrapper com
// data-image-gallery-type="product" + data-media-id. Galeria pode aparecer
// em qualquer posição na página (não necessariamente no topo).
const BROADCAST_ADAPTER: ThemeAdapter = {
  name: 'broadcast-shop',
  detect: ($) => $('[data-image-gallery-type="product"]').length > 0,
  extractSliderUrls: ($) => {
    const urls: string[] = [];
    const seen = new Set<string>();
    $('[data-image-gallery-type="product"]').each((_, wrapper) => {
      const $w = $(wrapper);
      const cls = ($w.attr('class') ?? '').toLowerCase();
      if (/thumb/.test(cls)) return;
      const img = $w.find('img.shop-main-image').first();
      const src = img.attr('src') ?? img.attr('data-src') ?? '';
      if (!src || !src.includes('supabase.co') || src.startsWith('data:')) return;
      if (seen.has(src)) return;
      seen.add(src);
      urls.push(src);
    });
    return urls;
  },
  rewriteSlider: ($, orderedUrls) => {
    // Coleta todos os wrappers da galeria (não-thumbnail) em ordem
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrappers: any[] = [];
    $('[data-image-gallery-type="product"]').each((_, wrapper) => {
      const cls = ($(wrapper).attr('class') ?? '').toLowerCase();
      if (!/thumb/.test(cls)) wrappers.push(wrapper);
    });
    // Reescreve src de cada wrapper na nova ordem
    orderedUrls.forEach((url, idx) => {
      const wrapper = wrappers[idx];
      if (!wrapper) return;
      const $wrapper = $(wrapper);
      const $img = $wrapper.find('img.shop-main-image').first();
      if ($img.length > 0) {
        $img.attr('src', escapeAttr(url));
        $img.attr('loading', idx === 0 ? 'eager' : 'lazy');
        $img.removeAttr('data-src');
        $img.removeAttr('srcset');
        $img.removeAttr('data-srcset');
      }
    });
    // Remove wrappers excedentes se nova lista for menor
    for (let i = orderedUrls.length; i < wrappers.length; i++) {
      const wrapper = wrappers[i];
      if (wrapper) $(wrapper).remove();
    }
  },
};

const ADAPTERS: ThemeAdapter[] = [AURIVITA_ADAPTER, MEDIA_GALLERY_ADAPTER, BROADCAST_ADAPTER];

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function detectAdapter($: cheerio.CheerioAPI): ThemeAdapter | null {
  for (const a of ADAPTERS) {
    if (a.detect($)) return a;
  }
  return null;
}

export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;

  const db = getDb();
  const [row] = await db
    .select({ htmlBody: landingPages.htmlBody })
    .from(landingPages)
    .where(and(eq(landingPages.id, params.id), eq(landingPages.storeId, STORE_ID)))
    .limit(1);
  if (!row) {
    return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });
  }
  const $ = cheerio.load(row.htmlBody);
  const adapter = detectAdapter($);
  const urls = adapter ? adapter.extractSliderUrls($) : [];
  const images = urls.map((u) => ({
    url: u,
    filename: u.split('/').pop()?.split('?')[0] ?? u,
  }));
  return NextResponse.json({ ok: true, images, theme: adapter?.name ?? null });
}

interface UploadedImage {
  url: string;
  path: string;
  bytes: number;
  mime: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function uploadNewFile(
  supa: any,
  landingId: string,
  file: File,
): Promise<UploadedImage> {
  const buf = Buffer.from(await file.arrayBuffer());
  const mime = file.type || 'image/jpeg';
  const ext = /webp/i.test(mime)
    ? 'webp'
    : /png/i.test(mime)
      ? 'png'
      : /gif/i.test(mime)
        ? 'gif'
        : 'jpg';
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const objectPath = `landings/${landingId}/${landingId}/${hash}.${ext}`;

  const { error } = await supa.storage.from(BUCKET).upload(objectPath, buf, {
    contentType: mime,
    upsert: true,
    cacheControl: '31536000, immutable',
  });
  if (error) throw new Error(`Supabase upload falhou: ${error.message}`);

  const publicUrl = `${process.env['SUPABASE_URL']}/storage/v1/object/public/${BUCKET}/${objectPath}`;
  return { url: publicUrl, path: objectPath, bytes: buf.length, mime };
}

export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;

  const db = getDb();
  const [row] = await db
    .select({ htmlBody: landingPages.htmlBody })
    .from(landingPages)
    .where(and(eq(landingPages.id, params.id), eq(landingPages.storeId, STORE_ID)))
    .limit(1);
  if (!row) {
    return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, message: 'multipart/form-data esperado' }, { status: 400 });
  }

  const orderedRaw = formData.get('orderedUrls') ?? formData.get('keepUrls');
  if (typeof orderedRaw !== 'string') {
    return NextResponse.json({ ok: false, message: 'orderedUrls obrigatório' }, { status: 400 });
  }
  let orderedUrls: string[];
  try {
    const parsed: unknown = JSON.parse(orderedRaw);
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
      throw new Error('orderedUrls deve ser array de strings');
    }
    orderedUrls = parsed;
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: `orderedUrls inválido: ${err instanceof Error ? err.message : 'unknown'}` },
      { status: 400 },
    );
  }

  const newFiles = formData.getAll('newFiles').filter((v): v is File => v instanceof File);

  // Upload novas imagens
  let uploads: UploadedImage[] = [];
  if (newFiles.length > 0) {
    const supaUrl = process.env['SUPABASE_URL'];
    const supaKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
    if (!supaUrl || !supaKey) {
      return NextResponse.json(
        { ok: false, message: 'Supabase env vars ausentes no backoffice' },
        { status: 500 },
      );
    }
    const supa = createSupabaseClient(supaUrl, supaKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    try {
      uploads = await Promise.all(
        newFiles.map((f) => uploadNewFile(supa, params.id, f)),
      );
    } catch (err) {
      return NextResponse.json(
        { ok: false, message: err instanceof Error ? err.message : 'Upload falhou' },
        { status: 500 },
      );
    }
  }

  // Ordem final: existentes ordenadas + uploads novos
  const finalOrder = [...orderedUrls, ...uploads.map((u) => u.url)];

  if (finalOrder.length === 0) {
    return NextResponse.json(
      { ok: false, message: 'Landing precisa ter ao menos 1 imagem' },
      { status: 400 },
    );
  }

  // Parse com cheerio, reescreve, serializa
  const $ = cheerio.load(row.htmlBody);
  const adapter = detectAdapter($);
  if (!adapter) {
    return NextResponse.json(
      { ok: false, message: 'Tema da landing não reconhecido' },
      { status: 400 },
    );
  }

  const originalUrls = adapter.extractSliderUrls($);
  adapter.rewriteSlider($, finalOrder);
  const newHtml = $.html();

  // Sanity check: HTML novo tem os slides que enviamos?
  const $verify = cheerio.load(newHtml);
  const verifyUrls = adapter.extractSliderUrls($verify);
  if (verifyUrls.length !== finalOrder.length) {
    return NextResponse.json(
      {
        ok: false,
        message: `Verificação pós-rewrite falhou: esperava ${finalOrder.length} slides, HTML resultante tem ${verifyUrls.length}. Rewrite NÃO foi persistido.`,
        expected: finalOrder.length,
        got: verifyUrls.length,
      },
      { status: 500 },
    );
  }

  await db
    .update(landingPages)
    .set({
      htmlBody: newHtml,
      updatedAt: new Date(),
    })
    .where(and(eq(landingPages.id, params.id), eq(landingPages.storeId, STORE_ID)));

  // Re-enqueue apply-bundle pra worker reprocessar HTML: injetar de novo o
  // script data-landinglab-manual-carousel (que faz slider funcionar sem
  // Swiper JS). O rewrite substituiu os slides mas o script antigo já
  // rodou (dataset.llManualInit) — precisamos reset pra novos slides.
  const enqueue = await enqueueApplyBundle(params.id, 'slider-images');
  const applyBundleEnqueued = enqueue.queued;

  return NextResponse.json({
    ok: true,
    theme: adapter.name,
    totalImages: finalOrder.length,
    removed: originalUrls.filter((u) => !finalOrder.includes(u)).length,
    added: uploads.length,
    reordered:
      originalUrls.length > 0 &&
      JSON.stringify(originalUrls) !== JSON.stringify(finalOrder.slice(0, originalUrls.length)),
    newUrls: uploads.map((u) => u.url),
    applyBundleEnqueued,
    message: applyBundleEnqueued
      ? `Slider atualizado: ${finalOrder.length} imagens. Reprocessamento agendado (~15s).`
      : `Slider atualizado: ${finalOrder.length} imagens no total.`,
  });
}
