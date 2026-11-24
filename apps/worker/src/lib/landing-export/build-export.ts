// Export da landing em dois formatos (pedido do operador, nov/2026 — "como o PageFly fazia"):
//
//   1. Zip HTML portátil: index.html + assets/ baixados + offers.json + landing-offers.js +
//      CLAUDE.md. Abre em qualquer hospedagem estática; o cliente edita com o Claude Code dele.
//   2. Zip de tema Shopify: layout/landinglab.liquid + sections/landinglab-*.liquid +
//      snippets (o HTML em partes) + templates/product.landinglab.json + assets/ll-*.
//      As ofertas saem das variantes reais do produto (blocos "Oferta" no editor de tema).
//
// Nos dois: sai tudo que é do BlackShop (checkout, consentimento, pixel) e da loja de origem
// (QuickCEP, pixels/analytics Shopify, exit-interstitial…). Vão junto o guarda anti-wipe e a
// camada de compatibilidade do Dawn, que fazem a landing funcionar fora da loja de origem.

import { createHash } from 'node:crypto';

import { minorUnitsToMajor } from '@blackshop/pricing';
import { EDITS_MANIFEST_ATTR, editsRuntimeScriptFor } from '@blackshop/shared/landing-edits-runtime';
import { ANTI_WIPE_GUARD_SCRIPT } from '@blackshop/shared/landing-html/anti-wipe-guard';
import { sanitizeInlineCss, sanitizeLandingHtml } from '@blackshop/shared/landing-html/sanitize-landing-html';
import { THEME_GLOBALS_SHIM_SCRIPT } from '@blackshop/shared/landing-html/theme-globals-shim';
import {
  applySystemOffers,
  SYSTEM_OFFERS_ATTR,
  type LandingOfferView,
  type OffersSource,
} from '@blackshop/shared/landing-offers';
import * as cheerio from 'cheerio';

import { portableClaudeMd, shopifyClaudeMd } from './docs.js';
import { LANDING_OFFERS_JS } from './offers-runtime.js';
import { buildZip, type ZipEntry } from './zip.js';

export interface ExportLanding {
  id: string;
  slug: string;
  title: string;
  htmlBody: string;
  customCss: string | null;
  currency: string;
  sourceUrl: string | null;
  locale: string | null;
  /** Story 25.2 — `system`: o bloco original sai e entra o bloco do sistema (mesmo da 25.1). */
  offersSource: OffersSource;
}

export interface ExportOffer {
  position: number;
  title: string;
  qty: number;
  priceCents: number;
  compareAtCents: number | null;
  badge: string | null;
  saveText: string | null;
  variantId: string | null;
  isPreselected: boolean;
  bullets: string[];
  /** Link de checkout da oferta (25.1); tem prioridade sobre o carrinho da variante. */
  checkoutUrl: string | null;
}

export interface ExportOptions {
  /** Loja Shopify das variantes (checkoutUrl = https://{loja}/cart/{variante}:1). null = sem link. */
  storeDomain: string | null;
  fetchImpl?: typeof fetch;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  now?: Date;
}

export interface ExportResult {
  html: Buffer;
  shopify: Buffer;
  stats: { assets: number; assetBytes: number; failed: number; skipped: number; removedScripts: number };
}

// Scripts que não podem ir no pacote: BlackShop (checkout/consentimento/pixel) e loja de origem.
const STRIP_SCRIPT_PATTERNS: RegExp[] = [
  /__LL_/,
  /landing-checkout/i,
  /landinglab/i,
  /authenlondon\.com/i,
  /quickcep/i,
  /exit-interstitial/i,
  /jsdeliver\.cloud/i,
  /facebook-pixel/i,
  /fbq\(/,
  /web-pixels/i,
  /webPixelsManager/,
  /shopifycloud\/(?:consent-tracking-api|privacy-banner|perf-kit|shopify-perf-kit|storefront-forms-hcaptcha)/i,
  /shop\.app\/|shop-js|shopify-features/i,
  /ShopifyAnalytics|Shopify\.analytics/,
  /trekkie|monorail/i,
  /_STREAMLOG/,
];

const ASSET_EXT = /\.(css|js|mjs|png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mov|json)$/i;

function normalizeUrl(raw: string | undefined, base: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v || /^(data:|blob:|#|mailto:|tel:|javascript:)/i.test(v)) return null;
  if (v.startsWith('//')) return `https:${v}`;
  if (/^https?:\/\//i.test(v)) return v;
  if (!base) return null;
  try {
    return new URL(v, base).toString();
  } catch {
    return null;
  }
}

function extFromType(type: string | null): string {
  const t = (type ?? '').toLowerCase();
  if (t.includes('css')) return '.css';
  if (t.includes('javascript')) return '.js';
  if (t.includes('webp')) return '.webp';
  if (t.includes('png')) return '.png';
  if (t.includes('jpeg')) return '.jpg';
  if (t.includes('gif')) return '.gif';
  if (t.includes('svg')) return '.svg';
  if (t.includes('avif')) return '.avif';
  if (t.includes('woff2')) return '.woff2';
  if (t.includes('woff')) return '.woff';
  if (t.includes('mp4')) return '.mp4';
  return '';
}

export function assetFileName(url: string, contentType: string | null): string {
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 10);
  let base = '';
  try {
    base = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  } catch {
    base = '';
  }
  base = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(-60);
  if (!ASSET_EXT.test(base)) base = `${base || 'asset'}${extFromType(contentType) || '.bin'}`;
  return `${hash}-${base}`;
}

function toOfferView(o: ExportOffer): LandingOfferView {
  return {
    position: o.position,
    title: o.title,
    qty: o.qty,
    priceCents: o.priceCents,
    compareAtCents: o.compareAtCents,
    saveText: o.saveText,
    badge: o.badge,
    bullets: o.bullets,
    checkoutUrl: o.checkoutUrl,
    variantId: o.variantId,
    isPreselected: o.isPreselected,
  };
}

/**
 * Story 25.2 (AC 1) — modo "sistema": bloco original fora, bloco do sistema no lugar (depois do
 * sanitize, como no storefront). Sem posição marcada ou sem ofertas, fica o modo "página".
 */
export function applyExportOffersSource(
  html: string,
  landing: ExportLanding,
  offers: ExportOffer[],
): { html: string; source: OffersSource } {
  if (landing.offersSource !== 'system') return { html, source: 'page' };
  const views = [...offers].sort((a, b) => a.position - b.position).map(toOfferView);
  const r = applySystemOffers(html, views, {
    currency: landing.currency,
    locale: landing.locale,
    lang: landing.locale?.split('-')[0] ?? null,
  });
  return r.applied ? { html: r.html, source: 'system' } : { html, source: 'page' };
}

/** Remove o que é do BlackShop e da loja de origem. Devolve o documento cheerio e quantos scripts saíram. */
export function cleanLandingHtml(
  landing: ExportLanding,
  offers: ExportOffer[] = [],
): { $: cheerio.CheerioAPI; removedScripts: number; source: OffersSource } {
  const { html, source } = applyExportOffersSource(sanitizeLandingHtml(landing.htmlBody), landing, offers);
  const $ = cheerio.load(html);
  let removedScripts = 0;
  $('script').each((_, el) => {
    const s = $(el);
    // O script do bloco do sistema (seleção do card) é nosso e precisa ficar.
    if (s.closest(`[${SYSTEM_OFFERS_ATTR}]`).length) return;
    // Receitas do editor visual (Story 26.1): o runtime das edições lê no zip também.
    if (s.is(`[${EDITS_MANIFEST_ATTR}]`)) return;
    // Nomes dos atributos + id: os scripts do BlackShop se marcam por id (__LL_*) ou data-landinglab-*.
    const attrs = `${Object.keys(el.attribs ?? {}).join(' ')} ${s.attr('id') ?? ''}`;
    const probe = `${s.attr('src') ?? ''}\n${attrs}\n${s.html() ?? ''}`;
    if (STRIP_SCRIPT_PATTERNS.some((re) => re.test(probe))) {
      s.remove();
      removedScripts++;
    }
  });
  $('noscript').each((_, el) => {
    if (/facebook\.com\/tr|googletagmanager/i.test($(el).html() ?? '')) $(el).remove();
  });
  // Widgets em iframe srcdoc (ex.: chat QuickCEP) trazem os scripts escapados no atributo.
  $('iframe[srcdoc]').each((_, el) => {
    if (STRIP_SCRIPT_PATTERNS.some((re) => re.test($(el).attr('srcdoc') ?? ''))) $(el).remove();
  });
  // Dicas de conexão (pixel, monorail, loja de origem) e oembed da loja de origem: sem uso fora dela.
  $('link[rel~="preconnect"], link[rel~="dns-prefetch"], link[rel="alternate"][type*="oembed"]').remove();
  // Login/conta do cliente só existem na loja de origem.
  $('a[href*="/customer_authentication"], a[href*="/account/login"], a[href$="/account"]').attr('href', '#');
  $('meta[name="robots"], link[rel="canonical"], meta[property="og:url"]').remove();
  $('[data-landinglab-subs-widget], #ll-consent, [id^="ll-consent"]').remove();
  if (landing.customCss) $('head').append(`<style>${sanitizeInlineCss(landing.customCss)}</style>`);
  return { $, removedScripts, source };
}

// ─── Assets ────────────────────────────────────────────────────────────────

interface Downloaded {
  name: string;
  data: Buffer;
  isCss: boolean;
}

class AssetBundler {
  readonly byUrl = new Map<string, Downloaded | null>();
  failed = 0;
  skipped = 0;
  totalBytes = 0;

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly maxFileBytes: number,
    private readonly maxTotalBytes: number,
  ) {}

  async fetchAll(urls: Iterable<string>): Promise<void> {
    const queue = [...new Set(urls)].filter((u) => !this.byUrl.has(u));
    const worker = async () => {
      for (let u = queue.shift(); u; u = queue.shift()) await this.fetchOne(u);
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  }

  private async fetchOne(url: string): Promise<void> {
    this.byUrl.set(url, null);
    if (this.totalBytes >= this.maxTotalBytes) {
      this.skipped++;
      return;
    }
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000), redirect: 'follow' });
      if (!res.ok) {
        this.failed++;
        return;
      }
      const len = Number(res.headers.get('content-length') ?? '0');
      if (len > this.maxFileBytes) {
        this.skipped++;
        return;
      }
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > this.maxFileBytes || this.totalBytes + data.length > this.maxTotalBytes) {
        this.skipped++;
        return;
      }
      const type = res.headers.get('content-type');
      const name = assetFileName(url, type);
      this.totalBytes += data.length;
      this.byUrl.set(url, { name, data, isCss: /\.css$/i.test(name) || /css/i.test(type ?? '') });
    } catch {
      this.failed++;
    }
  }

  /** Baixa o que os CSS referenciam (fontes, imagens, @import) — até 2 níveis. */
  async fetchCssDeps(): Promise<void> {
    for (let depth = 0; depth < 2; depth++) {
      const deps: string[] = [];
      for (const [url, d] of this.byUrl) {
        if (d?.isCss) deps.push(...cssUrls(d.data.toString('utf8'), url));
      }
      const fresh = deps.filter((u) => !this.byUrl.has(u));
      if (!fresh.length) return;
      await this.fetchAll(fresh);
    }
  }

  /** Reescreve url() dos CSS para o nome do arquivo (todos ficam na mesma pasta). */
  rewriteCss(prefix: string): void {
    for (const [url, d] of this.byUrl) {
      if (!d?.isCss) continue;
      const css = d.data.toString('utf8');
      d.data = Buffer.from(rewriteCssUrls(css, url, (abs) => this.local(abs, prefix)), 'utf8');
    }
  }

  local(abs: string, prefix: string): string | null {
    const d = this.byUrl.get(abs);
    return d ? `${prefix}${d.name}` : null;
  }

  files(prefix: string): ZipEntry[] {
    const seen = new Set<string>();
    const out: ZipEntry[] = [];
    for (const d of this.byUrl.values()) {
      if (!d || seen.has(d.name)) continue;
      seen.add(d.name);
      out.push({ path: `${prefix}${d.name}`, data: d.data });
    }
    return out;
  }
}

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/g;

function cssUrls(css: string, base: string | null): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(CSS_URL_RE)) {
    const abs = normalizeUrl(m[2] ?? m[4], base);
    if (abs) out.push(abs);
  }
  return out;
}

function rewriteCssUrls(css: string, base: string | null, map: (abs: string) => string | null): string {
  return css.replace(CSS_URL_RE, (full, q1: string, u1: string, q3: string, u3: string) => {
    const raw = u1 ?? u3;
    const abs = normalizeUrl(raw, base);
    const local = abs ? map(abs) : null;
    if (!local) return abs && abs !== raw ? full.replace(raw, abs) : full;
    return u1 !== undefined ? `url(${q1}${local}${q1})` : `@import ${q3}${local}${q3}`;
  });
}

/** srcset → só o maior candidato (evita baixar 10 larguras da mesma imagem). */
function largestSrcset(srcset: string): string | undefined {
  let best: { url: string; w: number } | undefined;
  for (const part of srcset.split(',')) {
    const [url, size] = part.trim().split(/\s+/);
    if (!url) continue;
    const w = size ? parseFloat(size) * (size.endsWith('x') ? 1000 : 1) : 0;
    if (!best || w >= best.w) best = { url, w };
  }
  return best?.url;
}

type AssetRef =
  | { kind: 'attr'; el: cheerio.Cheerio<never>; attr: string; abs: string }
  | { kind: 'srcset'; el: cheerio.Cheerio<never>; attr: string; abs: string }
  | { kind: 'css'; el: cheerio.Cheerio<never>; attr: string | null; css: string };

function collectRefs($: cheerio.CheerioAPI, base: string | null): AssetRef[] {
  const refs: AssetRef[] = [];
  const push = (sel: string, attr: string) => {
    $(sel).each((_, node) => {
      const el = $(node) as unknown as cheerio.Cheerio<never>;
      const abs = normalizeUrl(el.attr(attr), base);
      if (abs) refs.push({ kind: 'attr', el, attr, abs });
    });
  };
  push('img[src]', 'src');
  push('img[data-src]', 'data-src');
  push('source[src]', 'src');
  push('video[src]', 'src');
  push('video[poster]', 'poster');
  push('script[src]', 'src');
  push('link[href]', 'href');
  $('img[srcset], source[srcset], img[data-srcset]').each((_, node) => {
    const el = $(node) as unknown as cheerio.Cheerio<never>;
    for (const attr of ['srcset', 'data-srcset']) {
      const v = el.attr(attr);
      const abs = v ? normalizeUrl(largestSrcset(v), base) : null;
      if (abs) refs.push({ kind: 'srcset', el, attr, abs });
    }
  });
  $('style').each((_, node) => {
    const el = $(node) as unknown as cheerio.Cheerio<never>;
    refs.push({ kind: 'css', el, attr: null, css: el.html() ?? '' });
  });
  $('[style*="url("]').each((_, node) => {
    const el = $(node) as unknown as cheerio.Cheerio<never>;
    refs.push({ kind: 'css', el, attr: 'style', css: el.attr('style') ?? '' });
  });
  // link[href] só vale para recursos (CSS, ícone, preload) — não para navegação.
  return refs.filter((r) => {
    if (r.kind !== 'attr' || r.attr !== 'href') return true;
    const rel = (r.el.attr('rel') ?? '').toLowerCase();
    return /stylesheet|icon|preload|modulepreload/.test(rel) || ASSET_EXT.test(new URL(r.abs).pathname);
  });
}

function applyRefs(refs: AssetRef[], base: string | null, map: (abs: string) => string | null): void {
  for (const r of refs) {
    if (r.kind === 'attr') {
      const local = map(r.abs);
      r.el.attr(r.attr, local ?? r.abs);
    } else if (r.kind === 'srcset') {
      const local = map(r.abs);
      if (local) r.el.attr(r.attr, local);
    } else {
      const css = rewriteCssUrls(r.css, base, map);
      if (r.attr) r.el.attr(r.attr, css);
      else r.el.text(css);
    }
  }
}

// ─── Ofertas ───────────────────────────────────────────────────────────────

export interface OffersFile {
  currency: string;
  locale: string | null;
  /** Modo efetivo das ofertas no pacote (`system` só quando o bloco do sistema entrou). */
  source: OffersSource;
  offers: Array<{
    title: string;
    qty: number;
    price: number;
    compareAt: number | null;
    badge: string | null;
    saveText: string | null;
    bullets: string[];
    variantId: string | null;
    checkoutUrl: string;
    preselected: boolean;
  }>;
}

/** Link da oferta: o configurado na oferta; senão o carrinho da variante na loja; senão ''. */
function offerCheckoutUrl(o: ExportOffer, storeDomain: string | null): string {
  const own = o.checkoutUrl?.trim();
  if (own) return own;
  return o.variantId && storeDomain ? `https://${storeDomain}/cart/${o.variantId}:1` : '';
}

export function buildOffersFile(
  landing: ExportLanding,
  offers: ExportOffer[],
  storeDomain: string | null,
  source: OffersSource = 'page',
): OffersFile {
  return {
    currency: landing.currency,
    locale: landing.locale,
    source,
    offers: [...offers]
      .sort((a, b) => a.position - b.position)
      .map((o) => ({
        title: o.title,
        qty: o.qty,
        price: minorUnitsToMajor(o.priceCents, landing.currency),
        compareAt: o.compareAtCents != null ? minorUnitsToMajor(o.compareAtCents, landing.currency) : null,
        badge: o.badge,
        saveText: o.saveText,
        bullets: o.bullets ?? [],
        variantId: o.variantId,
        checkoutUrl: offerCheckoutUrl(o, storeDomain),
        preselected: o.isPreselected,
      })),
  };
}

const jsonInScript = (v: unknown) => JSON.stringify(v, null, 2).replace(/</g, '\\u003c');

// ─── Shopify (Liquid) ──────────────────────────────────────────────────────

const SHOPIFY_ASSET_EXT = /\.(css|js|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|eot)$/i;
const SHOPIFY_MAX_ASSET_BYTES = 20 * 1024 * 1024;
const ASSET_TOKEN = (name: string) => `__LLASSET__${name}__`;
const ASSET_TOKEN_RE = /__LLASSET__([A-Za-z0-9._-]+)__/g;
const SNIPPET_MAX = 200 * 1024;

/** HTML literal → Liquid: tudo em {% raw %}, só os assets viram asset_url. */
export function toLiquid(html: string): string {
  const safe = html.replace(/\{%-?\s*(?:end)?raw\s*-?%\}/g, '');
  const body = safe.replace(ASSET_TOKEN_RE, (_, name: string) => `{% endraw %}{{ '${name}' | asset_url }}{% raw %}`);
  return `{% raw %}${body}{% endraw %}`;
}

/** Corta em pedaços (< 200 KB, sempre depois de um '>') para caber no limite de arquivo do tema. */
export function splitHtml(html: string, max = SNIPPET_MAX): string[] {
  const parts: string[] = [];
  let rest = html;
  while (Buffer.byteLength(rest, 'utf8') > max) {
    let cut = rest.lastIndexOf('>', Math.floor(max / 2)) + 1;
    if (cut <= 0) cut = Math.floor(max / 2);
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

function snippetFiles(html: string, base: string): { render: string; files: ZipEntry[] } {
  const files = splitHtml(html).map((part, i) => ({ path: `snippets/${base}-${i + 1}.liquid`, data: toLiquid(part) }));
  const render = files.map((_, i) => `{% render '${base}-${i + 1}' %}`).join('\n');
  return { render, files };
}

export function shopifyOffersScript(source: OffersSource = 'page'): string {
  return `<script>
  window.__LL_OFFERS__ = {
    "currency": {{ cart.currency.iso_code | json }},
    "locale": {{ request.locale.iso_code | json }},
    "source": ${JSON.stringify(source)},
    "offers": [
    {%- for block in section.blocks -%}
      {%- assign v = product.selected_or_first_available_variant -%}
      {%- for pv in product.variants -%}
        {%- assign pid = pv.id | append: '' -%}
        {%- if pid == block.settings.variant_id -%}{%- assign v = pv -%}{%- endif -%}
      {%- endfor -%}
      {
        "title": {{ block.settings.title | json }},
        "qty": {{ block.settings.qty | default: 1 | json }},
        "badge": {{ block.settings.badge | json }},
        "bullets": [
          {%- assign ll_bullets = block.settings.bullets | newline_to_br | split: '<br />' -%}
          {%- assign ll_first = true -%}
          {%- for b in ll_bullets -%}{%- assign bt = b | strip_newlines | strip -%}{%- if bt != blank -%}{% unless ll_first %},{% endunless %}{{ bt | json }}{%- assign ll_first = false -%}{%- endif -%}{%- endfor -%}
        ],
        "variantId": {{ v.id | json }},
        "price": {{ v.price | divided_by: 100.0 | json }},
        "priceFormatted": {{ v.price | money | json }},
        "compareAt": {% if v.compare_at_price > v.price %}{{ v.compare_at_price | divided_by: 100.0 | json }}{% else %}null{% endif %},
        "compareAtFormatted": {% if v.compare_at_price > v.price %}{{ v.compare_at_price | money | json }}{% else %}null{% endif %},
        "checkoutUrl": {% if block.settings.checkout_url != blank %}{{ block.settings.checkout_url | strip | json }}{% else %}{{ '/cart/' | append: v.id | append: ':1' | json }}{% endif %},
        "preselected": {{ block.settings.preselected | json }}
      }{% unless forloop.last %},{% endunless %}
    {%- endfor -%}
    ]
  };
</script>`;
}

function sectionSchema(title: string): string {
  const name = `LL ${title}`.slice(0, 25);
  return JSON.stringify(
    {
      name,
      tag: 'div',
      class: 'landinglab-section',
      blocks: [
        {
          type: 'offer',
          name: 'Oferta',
          settings: [
            { type: 'text', id: 'title', label: 'Título' },
            { type: 'number', id: 'qty', label: 'Quantidade', default: 1 },
            {
              type: 'text',
              id: 'variant_id',
              label: 'ID da variante',
              info: 'ID numérico da variante deste produto. Vazio ou inválido = variante selecionada.',
            },
            { type: 'text', id: 'badge', label: 'Selo' },
            {
              type: 'textarea',
              id: 'bullets',
              label: 'Bullets',
              info: 'Um por linha (até 8). Aparecem na lista de benefícios do card.',
            },
            {
              type: 'text',
              id: 'checkout_url',
              label: 'Link',
              info: 'Opcional. Link de checkout desta oferta (Stripe, Hotmart…). Tem prioridade sobre a variante.',
            },
            { type: 'checkbox', id: 'preselected', label: 'Pré-selecionada', default: false },
          ],
        },
      ],
      presets: [{ name }],
    },
    null,
    2,
  );
}

export function landingSlug(landing: ExportLanding): string {
  const s = (landing.slug || landing.title || 'landing')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || landing.id.slice(0, 8);
}

// ─── Montagem ──────────────────────────────────────────────────────────────

// Story 26.2: edições do editor visual (link do botão, texto travado) — antes do script de ofertas.
function headInjection(editsScript: string, offersScriptTag: string): string {
  return `\n${ANTI_WIPE_GUARD_SCRIPT}\n${THEME_GLOBALS_SHIM_SCRIPT}\n${editsScript}\n${offersScriptTag}\n`;
}

export async function buildLandingExport(
  landing: ExportLanding,
  offers: ExportOffer[],
  opts: ExportOptions,
): Promise<ExportResult> {
  const base = landing.sourceUrl;
  const bundler = new AssetBundler(
    opts.fetchImpl ?? fetch,
    opts.maxFileBytes ?? 25 * 1024 * 1024,
    opts.maxTotalBytes ?? 180 * 1024 * 1024,
  );
  const slug = landingSlug(landing);

  // Um único download para os dois formatos.
  const { $: probe, removedScripts, source } = cleanLandingHtml(landing, offers);
  const editsScript = editsRuntimeScriptFor(probe.html());
  const offersFile = buildOffersFile(landing, offers, opts.storeDomain, source);
  const probeRefs = collectRefs(probe, base);
  await bundler.fetchAll(
    probeRefs.flatMap((r) => (r.kind === 'css' ? cssUrls(r.css, base) : [r.abs])),
  );
  await bundler.fetchCssDeps();
  const cssOriginals = new Map<string, Buffer>();
  for (const [url, d] of bundler.byUrl) if (d?.isCss) cssOriginals.set(url, d.data);

  // ── Formato 1: zip HTML ──
  bundler.rewriteCss('');
  const htmlDoc = probe;
  applyRefs(probeRefs, base, (abs) => bundler.local(abs, 'assets/'));
  htmlDoc('head').prepend(
    headInjection(
      editsScript,
      `<script id="ll-offers-inline" type="application/json">${jsonInScript(offersFile)}</script>\n<script src="landing-offers.js" defer></script>`,
    ),
  );
  const portableEntries: ZipEntry[] = [
    { path: 'index.html', data: htmlDoc.html() },
    { path: 'offers.json', data: `${JSON.stringify(offersFile, null, 2)}\n` },
    { path: 'landing-offers.js', data: LANDING_OFFERS_JS },
    { path: 'CLAUDE.md', data: portableClaudeMd(landing, offersFile, !!editsScript) },
    ...bundler.files('assets/'),
  ];

  // ── Formato 2: tema Shopify ──
  for (const [url, data] of cssOriginals) {
    const d = bundler.byUrl.get(url);
    if (d) d.data = data;
  }
  // Tema Shopify: assets/ é plano, até 20 MB por arquivo e não aceita vídeo — esses ficam no link original.
  for (const [url, d] of bundler.byUrl) {
    if (!d) continue;
    if (!SHOPIFY_ASSET_EXT.test(d.name) || d.data.length > SHOPIFY_MAX_ASSET_BYTES) bundler.byUrl.set(url, null);
    else d.name = `ll-${d.name}`;
  }
  bundler.rewriteCss('');
  const { $: shop } = cleanLandingHtml(landing, offers);
  const shopRefs = collectRefs(shop, base);
  applyRefs(shopRefs, base, (abs) => {
    const d = bundler.byUrl.get(abs);
    return d ? ASSET_TOKEN(d.name) : null;
  });
  shop('head title, head meta[name="description"]').remove();
  const headHtml = shop('head').html() ?? '';
  const bodyEl = shop('body');
  const bodyAttrs = Object.entries(bodyEl.get(0)?.attribs ?? {})
    .map(([k, v]) => ` ${k}="${v.replace(/"/g, '&quot;')}"`)
    .join('');
  const htmlAttrs = Object.entries(shop('html').get(0)?.attribs ?? {})
    .filter(([k]) => k !== 'lang')
    .map(([k, v]) => ` ${k}="${v.replace(/"/g, '&quot;')}"`)
    .join('');
  const headParts = snippetFiles(headHtml, `landinglab-${slug}-head`);
  const bodyParts = snippetFiles(bodyEl.html() ?? '', `landinglab-${slug}-body`);

  const layout = `<!doctype html>
<html lang="{{ request.locale.iso_code }}"${htmlAttrs}>
<head>
${ANTI_WIPE_GUARD_SCRIPT}
${THEME_GLOBALS_SHIM_SCRIPT}
${editsScript}
<title>{{ page_title }}</title>
{%- if page_description -%}<meta name="description" content="{{ page_description | escape }}">{%- endif -%}
<link rel="canonical" href="{{ canonical_url }}">
${headParts.render}
{{ content_for_header }}
<script src="{{ 'll-landing-offers.js' | asset_url }}" defer></script>
</head>
<body${bodyAttrs}>
{{ content_for_layout }}
</body>
</html>
`;
  const section = `{%- comment -%} Gerado pelo BlackShop (LandingLab) — ver CLAUDE.md {%- endcomment -%}
${bodyParts.render}
${shopifyOffersScript(source)}

{% schema %}
${sectionSchema(landing.title)}
{% endschema %}
`;
  const blocks: Record<string, { type: 'offer'; settings: Record<string, unknown> }> = {};
  const sorted = [...offers].sort((a, b) => a.position - b.position);
  offersFile.offers.forEach((o, i) => {
    blocks[`offer-${i + 1}`] = {
      type: 'offer',
      settings: {
        title: o.title,
        qty: o.qty,
        variant_id: o.variantId ?? '',
        badge: o.badge ?? '',
        bullets: o.bullets.join('\n'),
        // Só o link próprio da oferta: o carrinho da variante o Liquid monta na loja de destino.
        checkout_url: sorted[i]?.checkoutUrl?.trim() ?? '',
        preselected: o.preselected,
      },
    };
  });
  const template = {
    layout: 'landinglab',
    sections: { main: { type: `landinglab-${slug}`, blocks, block_order: Object.keys(blocks) } },
    order: ['main'],
  };
  const shopifyEntries: ZipEntry[] = [
    { path: 'layout/landinglab.liquid', data: layout },
    { path: `sections/landinglab-${slug}.liquid`, data: section },
    ...headParts.files,
    ...bodyParts.files,
    { path: 'templates/product.landinglab.json', data: `${JSON.stringify(template, null, 2)}\n` },
    { path: 'assets/ll-landing-offers.js', data: LANDING_OFFERS_JS },
    { path: 'CLAUDE.md', data: shopifyClaudeMd(landing, slug, !!editsScript) },
    ...bundler.files('assets/'),
  ];

  const assetFiles = bundler.files('');
  return {
    html: buildZip(portableEntries, opts.now),
    shopify: buildZip(shopifyEntries, opts.now),
    stats: {
      assets: assetFiles.length,
      assetBytes: bundler.totalBytes,
      failed: bundler.failed,
      skipped: bundler.skipped,
      removedScripts,
    },
  };
}
