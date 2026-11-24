// Story 24.1 · gerador puro do feed RSS 2.0 (namespace g:) de um catálogo Meta.
//
// Fonte única dos campos de cada item: `metaCatalogItemFields` alimenta o XML daqui e, na 24.4, o
// payload da Catalog API — feed e API nunca divergem. Sem I/O e sem dados do leitor: o corpo depende
// só do catálogo e dos itens (regra 3 do epic: mesmo corpo para qualquer user-agent, IP ou referer).
//
// Formato: especificação Google Shopping aceita pela Meta. Campos da Meta sem equivalente no Google
// (vídeo) vão sem prefixo, como na referência da Meta: `<video><url/><tag/></video>`, até 20 por item
// (video[0].url..video[19].url — developers.facebook.com/docs/marketing-api/catalog/reference).
// stripHtml no estilo do /feed.xml da vitrine (apps/storefront/src/app/feed.xml/route.ts, que não muda);
// aqui o texto é escapado por entidade (sem CDATA), então `]]>` no título não fecha nada.

export const META_FEED_MAX_ADDITIONAL_IMAGES = 10;
export const META_FEED_MAX_VIDEOS = 20;

// Story 24.5 · "imagem branca": marcador gravado em `images` pelos itens criados em lote pelo botão
// "Criar 5 produtos". Não é URL, então nunca chega à Meta: item com o marcador na imagem principal fica
// fora do feed e do envio pela API até o operador trocar a imagem (regra 2 do epic: nada de item
// placeholder na Meta). Nas imagens adicionais, o marcador é simplesmente ignorado.
export const META_CATALOG_BLANK_IMAGE = 'blank:white';

/** true = a imagem principal ainda é a branca (o item não vai para a Meta). */
export function isMetaCatalogBlankItem(item: { images: readonly string[] }): boolean {
  return item.images[0] === META_CATALOG_BLANK_IMAGE;
}

export interface MetaFeedCatalog {
  id: string;
  name: string;
  brand: string | null;
  currency: string;
}

export interface MetaFeedItem {
  retailerId: string;
  title: string;
  description: string;
  priceMinor: number;
  salePriceMinor: number | null;
  images: readonly string[];
  videos: ReadonlyArray<{ url: string; tag?: string }>;
  destinationUrl: string;
  utm: Partial<Record<'source' | 'medium' | 'campaign' | 'content' | 'term', string>>;
  availability: string;
}

/** Campos de um item como a Meta os recebe (nomes da especificação). */
export interface MetaItemFields {
  id: string;
  title: string;
  description: string;
  link: string;
  image_link: string;
  additional_image_link: string[];
  video: Array<{ url: string; tag?: string }>;
  price: string;
  sale_price?: string;
  availability: string;
  condition: 'new';
  brand: string;
}

// Caracteres de controle proibidos no XML 1.0 (exceto tab, LF e CR).
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

export function xmlEscape(value: string): string {
  return value
    .replace(XML_INVALID, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 4900 + EUR → "49.00 EUR". Centavos inteiros: sem ponto flutuante. */
export function formatMetaPrice(minor: number, currency: string): string {
  const units = Math.trunc(minor / 100);
  const cents = String(Math.abs(minor % 100)).padStart(2, '0');
  return `${units}.${cents} ${currency}`;
}

const UTM_KEYS = ['source', 'medium', 'campaign', 'content', 'term'] as const;

/** Aplica o UTM do item à URL de destino (sobrescreve utm_* existentes; mantém o resto da query). */
export function applyUtm(destinationUrl: string, utm: MetaFeedItem['utm']): string {
  const url = new URL(destinationUrl);
  for (const key of UTM_KEYS) {
    const value = utm[key]?.trim();
    if (value) url.searchParams.set(`utm_${key}`, value);
  }
  return url.toString();
}

export function metaCatalogItemFields(catalog: MetaFeedCatalog, item: MetaFeedItem): MetaItemFields {
  const [main, ...rest] = item.images.filter((u) => u !== META_CATALOG_BLANK_IMAGE);
  const description = stripHtml(item.description) || item.title;
  const fields: MetaItemFields = {
    id: item.retailerId,
    title: item.title,
    description,
    link: applyUtm(item.destinationUrl, item.utm),
    image_link: main ?? '',
    additional_image_link: rest.slice(0, META_FEED_MAX_ADDITIONAL_IMAGES),
    video: item.videos.slice(0, META_FEED_MAX_VIDEOS).map((v) => (v.tag ? { url: v.url, tag: v.tag } : { url: v.url })),
    price: formatMetaPrice(item.priceMinor, catalog.currency),
    availability: item.availability,
    condition: 'new',
    brand: catalog.brand?.trim() || catalog.name,
  };
  if (item.salePriceMinor !== null && item.salePriceMinor < item.priceMinor) {
    fields.sale_price = formatMetaPrice(item.salePriceMinor, catalog.currency);
  }
  return fields;
}

function el(name: string, value: string): string {
  return `<${name}>${xmlEscape(value)}</${name}>`;
}

function itemXml(f: MetaItemFields): string {
  const parts = [
    el('g:id', f.id),
    el('g:title', f.title),
    el('g:description', f.description),
    el('g:link', f.link),
    el('g:image_link', f.image_link),
    ...f.additional_image_link.map((u) => el('g:additional_image_link', u)),
    ...f.video.map((v) => `<video>${el('url', v.url)}${v.tag ? el('tag', v.tag) : ''}</video>`),
    el('g:price', f.price),
    ...(f.sale_price ? [el('g:sale_price', f.sale_price)] : []),
    el('g:availability', f.availability),
    el('g:condition', f.condition),
    el('g:brand', f.brand),
  ];
  return `<item>\n${parts.map((p) => `      ${p}`).join('\n')}\n    </item>`;
}

/** XML completo do feed. Determinístico: mesma entrada → mesmos bytes. Itens com imagem branca ficam de fora. */
export function buildMetaCatalogFeed(catalog: MetaFeedCatalog, items: readonly MetaFeedItem[]): string {
  const body = items
    .filter((item) => !isMetaCatalogBlankItem(item))
    .map((item) => `    ${itemXml(metaCatalogItemFields(catalog, item))}`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">',
    '  <channel>',
    `    ${el('title', catalog.name)}`,
    `    ${el('description', catalog.name)}`,
    ...(body ? [body] : []),
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

// ── Story 24.4 · payload da Catalog API (items_batch, item_type=PRODUCT_ITEM) ─────────────────────
// Os campos são EXATAMENTE os de metaCatalogItemFields (os mesmos nomes do feed: id, title, link,
// image_link, price "49.00 EUR"…) — a única fonte. DELETE de PRODUCT_ITEM leva só o `id`
// (developers.facebook.com/docs/marketing-api/reference/product-catalog/items_batch).

export const META_ITEMS_BATCH_MAX_REQUESTS = 5000;

export type MetaItemsBatchRequest =
  | { method: 'UPDATE'; data: MetaItemFields }
  | { method: 'DELETE'; data: { id: string } };

/** UPDATE com allow_upsert: cria o item se ele ainda não existe no catálogo da Meta. */
export function metaCatalogUpsertRequest(catalog: MetaFeedCatalog, item: MetaFeedItem): MetaItemsBatchRequest {
  return { method: 'UPDATE', data: metaCatalogItemFields(catalog, item) };
}

export function metaCatalogDeleteRequest(retailerId: string): MetaItemsBatchRequest {
  return { method: 'DELETE', data: { id: retailerId } };
}

// ── Story 24.6 · o mesmo feed em CSV (a Meta aceita CSV, TSV e XML) ───────────────────────────────
// Mesmos campos de metaCatalogItemFields e o mesmo filtro da imagem branca do XML. Cabeçalho com os
// nomes da especificação da Meta; várias imagens adicionais vão numa célula separadas por vírgula e os
// vídeos em colunas video[N].url / video[N].tag (só quantas o item com mais vídeos usar). RFC 4180:
// célula com vírgula, aspas ou quebra de linha vai entre aspas, com as aspas internas duplicadas.

const CSV_BASE_COLUMNS = [
  'id',
  'title',
  'description',
  'availability',
  'condition',
  'price',
  'sale_price',
  'link',
  'image_link',
  'additional_image_link',
  'brand',
] as const;

export function csvCell(value: string): string {
  const clean = value.replace(XML_INVALID, '');
  return /[",\r\n]/.test(clean) ? `"${clean.replace(/"/g, '""')}"` : clean;
}

/** CSV completo do feed. Determinístico: mesma entrada → mesmos bytes. Itens com imagem branca ficam de fora. */
export function buildMetaCatalogCsv(catalog: MetaFeedCatalog, items: readonly MetaFeedItem[]): string {
  const rows = items.filter((item) => !isMetaCatalogBlankItem(item)).map((item) => metaCatalogItemFields(catalog, item));
  const videoCols = Math.max(0, ...rows.map((f) => f.video.length));
  const header = [...CSV_BASE_COLUMNS];
  const videoHeader: string[] = [];
  for (let i = 0; i < videoCols; i++) videoHeader.push(`video[${i}].url`, `video[${i}].tag`);
  const lines = rows.map((f) => {
    const base = [
      f.id,
      f.title,
      f.description,
      f.availability,
      f.condition,
      f.price,
      f.sale_price ?? '',
      f.link,
      f.image_link,
      f.additional_image_link.join(','),
      f.brand,
    ];
    const videos: string[] = [];
    for (let i = 0; i < videoCols; i++) videos.push(f.video[i]?.url ?? '', f.video[i]?.tag ?? '');
    return [...base, ...videos].map(csvCell).join(',');
  });
  return [[...header, ...videoHeader].join(','), ...lines, ''].join('\n');
}
