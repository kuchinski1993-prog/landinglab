// GET /api/landing-pages/[id]/detect-editable
//
// Inspeciona htmlBody da landing e retorna structs pras 4 seções do Editor:
//   - price: { current, currency }
//   - bundles: [{ id, name?, price, position }]
//   - carouselImages: [{ index, src, alt }]
//   - ctas: [{ href, text, tag }] (apenas <a> hrefs distintos que parecem CTA)

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import * as cheerio from 'cheerio';
import { landingPages } from '@blackshop/db';

import { getDb } from '@/lib/landing-db';
import { requireAdminRequest } from '@/lib/admin/auth-guard';

const STORE_ID = 'l0i';

export const runtime = 'nodejs';
export const maxDuration = 15;

interface DetectedPrice {
  current: string;
  currency: string;
}
interface DetectedBundle {
  id: string;
  title: string | null;
  subtitle: string | null;
  /** Quantity total (soma buy+get pra deals BOGO). */
  totalQuantity: number;
  /** Descrição do desconto em texto (ex: "SAVE 33%", "Buy 2 get 1 free"). */
  discountDescription: string;
  /** Preço estimado em cents (baseado em preço-base do produto × totalQuantity - discount). */
  estimatedPriceCents: number;
  position: number;
}
interface DetectedCarouselImage {
  index: number;
  src: string;
  alt: string;
}
interface DetectedCta {
  href: string;
  text: string;
  count: number;
}

export async function GET(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;

  const landingId = params.id;
  const db = getDb();
  const [row] = await db
    .select({
      htmlBody: landingPages.htmlBody,
      currency: landingPages.currency,
      price: landingPages.price,
    })
    .from(landingPages)
    .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)))
    .limit(1);
  if (!row) {
    return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });
  }

  const html = row.htmlBody;
  const $ = cheerio.load(html);

  // ─── Price ───
  const price: DetectedPrice = {
    current: row.price,
    currency: row.currency,
  };

  // ─── Bundles (Kaching dealBars) ───
  // Kaching não armazena preço absoluto — só regras de desconto. Preço final é
  // calculado como: base_price × totalQuantity × (1 - effective_discount).
  // Deduplicamos por dealBar.id (Kaching frequentemente duplica o script).
  //
  // Suporta dois formatos Kaching:
  //   Legacy: <script class="kaching-bundles-deal-block-settings">{...JSON...}</script>
  //   Modern: <kaching-bundles-block config="{...HTML-entity-encoded JSON...}">
  const bundles: DetectedBundle[] = [];
  const basePriceCents = Math.round(Number(row.price) * 100);
  const seenBundleIds = new Set<string>();

  function parseKachingDealBars(data: Record<string, unknown>, idOffset: number): void {
    const dealBars = data['dealBars'] ?? data['bundles'] ?? data['deals'];
    if (!Array.isArray(dealBars)) return;

    dealBars.forEach((bar, i) => {
      if (!bar || typeof bar !== 'object') return;
      const b = bar as Record<string, unknown>;
      const id = String(b['id'] ?? (idOffset + i));
      if (seenBundleIds.has(id)) return;
      seenBundleIds.add(id);

      const title = typeof b['title'] === 'string' ? b['title'].trim() : null;
      const subtitle = typeof b['subtitle'] === 'string' ? b['subtitle'].trim() : null;

      const quantity = typeof b['quantity'] === 'number' ? b['quantity'] : null;
      const discountType = typeof b['discountType'] === 'string' ? b['discountType'] : null;
      const discountValue = typeof b['discountValue'] === 'number' ? b['discountValue'] : 0;

      const buyQuantity = typeof b['buyQuantity'] === 'number' ? b['buyQuantity'] : null;
      const getQuantity = typeof b['getQuantity'] === 'number' ? b['getQuantity'] : null;
      const getDiscountType = typeof b['getDiscountType'] === 'string' ? b['getDiscountType'] : null;
      const getDiscountValue = typeof b['getDiscountValue'] === 'number' ? b['getDiscountValue'] : 0;

      let totalQuantity = 0;
      let estimatedPriceCents = 0;
      let discountDescription = '';

      if (buyQuantity != null && getQuantity != null) {
        totalQuantity = buyQuantity + getQuantity;
        const paidPortion = buyQuantity * basePriceCents;
        const freeDiscount = getDiscountType === 'percentage'
          ? (getDiscountValue / 100) * getQuantity * basePriceCents
          : getDiscountType === 'fixed_amount' ? getDiscountValue * 100 * getQuantity : 0;
        estimatedPriceCents = Math.max(0, paidPortion - freeDiscount);
        discountDescription = getDiscountType === 'percentage' && getDiscountValue === 100
          ? `Buy ${buyQuantity}, get ${getQuantity} FREE`
          : `Buy ${buyQuantity}, get ${getQuantity} at ${getDiscountValue}% off`;
      } else if (quantity != null) {
        totalQuantity = quantity;
        const gross = quantity * basePriceCents;
        const discountAmount = discountType === 'percentage'
          ? (discountValue / 100) * gross
          : discountType === 'fixed_amount'
            ? discountValue * 100
            : 0;
        estimatedPriceCents = Math.max(0, gross - discountAmount);
        discountDescription = discountValue > 0
          ? (discountType === 'percentage' ? `${discountValue}% off` : `-${discountValue.toFixed(2)}`)
          : 'No discount';
      }

      bundles.push({ id, title, subtitle, totalQuantity, discountDescription, estimatedPriceCents, position: i });
    });
  }

  // Legacy format: <script class="kaching-bundles-deal-block-settings">{JSON}</script>
  $('script.kaching-bundles-deal-block-settings').each((scriptIdx, el) => {
    const raw = $(el).html() || '';
    if (!raw.trim().startsWith('{')) return;
    try {
      parseKachingDealBars(JSON.parse(raw) as Record<string, unknown>, scriptIdx * 100);
    } catch { /* silêncio */ }
  });

  // Modern format: <kaching-bundles-block config="{HTML-entity-encoded JSON}">
  // cheerio decodifica entities automaticamente ao ler atributos.
  $('kaching-bundles-block[config], kaching-bundles-block[deal-block]').each((elIdx, el) => {
    const raw = $(el).attr('config') ?? $(el).attr('deal-block') ?? '';
    if (!raw) return;
    // Fallback para double-encoded entities (alguns temas escapam duas vezes)
    const decoded = raw.includes('&quot;')
      ? raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      : raw;
    try {
      parseKachingDealBars(JSON.parse(decoded) as Record<string, unknown>, (elIdx + 10) * 100);
    } catch { /* silêncio */ }
  });

  // ─── Carousel images (Klensia pss-* + fallback Shopify padrão) ───
  const carouselImages: DetectedCarouselImage[] = [];
  const seenIndexes = new Set<number>();
  $('.pss-main-slide').each((_, el) => {
    const indexStr = $(el).attr('data-index');
    const index = indexStr ? Number(indexStr) : -1;
    if (index < 0 || seenIndexes.has(index)) return;
    seenIndexes.add(index);
    const img = $(el).find('img').first();
    const src = img.attr('src') ?? '';
    const alt = img.attr('alt') ?? '';
    if (src) carouselImages.push({ index, src, alt });
  });

  // Detecção semântica — Chemistry Club / Broadcast theme e variantes que usam
  // data-image-gallery-type="product" + data-media-id. Independente de posição
  // na página: detecta pela semântica dos atributos, não pela posição vertical.
  // Cada wrapper div.shop-image-zoom-wrapper é um slot da galeria.
  if (carouselImages.length === 0) {
    $('[data-image-gallery-type="product"]').each((_, wrapper) => {
      const $w = $(wrapper);
      // Descarta wrappers de thumbnail (class contém "thumb" ou "thumbnail")
      const cls = ($w.attr('class') ?? '').toLowerCase();
      if (/thumb/.test(cls)) return;
      const img = $w.find('img').first();
      const src = img.attr('src') ?? img.attr('data-src') ?? '';
      const alt = img.attr('alt') ?? '';
      if (!src) return;
      carouselImages.push({ index: carouselImages.length, src, alt });
    });
    // Fallback direto por classe (sem wrapper): .shop-main-image
    if (carouselImages.length === 0) {
      $('img.shop-main-image').each((i, el) => {
        const $img = $(el);
        const src = $img.attr('src') ?? $img.attr('data-src') ?? '';
        const alt = $img.attr('alt') ?? '';
        if (src && i < 20) carouselImages.push({ index: i, src, alt });
      });
    }
  }

  // Fallback multi-tema: cobre Shopify Dawn, Kaching, Aurivita, Bepurex,
  // Debutify, Booster e outros temas que não usam .pss-main-slide.
  if (carouselImages.length === 0) {
    const fallbackSel = [
      'media-gallery img',
      '.product-media img',
      '.product__media img',
      '.product__media-item img',
      '.product-single__media img',
      '.product-images img',
      '.product-featured-media img',
      '.cc-pdp__main-slide img',
      '.swiper-slide img',
      '.gallery__image',
    ].join(', ');
    $(fallbackSel).each((i, el) => {
      // Suporta lazy-load: prioriza src, fallback para data-src / data-lazy-src
      const src = $(el).attr('src') ?? $(el).attr('data-src') ?? $(el).attr('data-lazy-src') ?? '';
      const alt = $(el).attr('alt') ?? '';
      if (src && i < 20) carouselImages.push({ index: i, src, alt });
    });
  }

  // ─── CTAs (todos <a href>) ───
  const ctaMap = new Map<string, DetectedCta>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')?.trim() ?? '';
    if (!href || href === '#' || href.startsWith('#') || href.startsWith('mailto:')
      || href.startsWith('tel:') || href.startsWith('javascript:')) return;
    // Filtrar assets (css/js/font)
    if (/\.(css|js|woff2?|ttf|otf|eot|png|jpg|jpeg|gif|webp|svg|ico)(\?|$)/i.test(href)) return;

    const text = $(el).text().trim().slice(0, 80);
    const existing = ctaMap.get(href);
    if (existing) {
      existing.count += 1;
      if (!existing.text && text) existing.text = text;
    } else {
      ctaMap.set(href, { href, text, count: 1 });
    }
  });
  const ctas = Array.from(ctaMap.values()).sort((a, b) => {
    // Priorizar CTAs com texto e maior contagem
    if (a.text && !b.text) return -1;
    if (!a.text && b.text) return 1;
    return b.count - a.count;
  }).slice(0, 30);

  return NextResponse.json({
    ok: true,
    price,
    bundles,
    carouselImages,
    ctas,
  });
}
