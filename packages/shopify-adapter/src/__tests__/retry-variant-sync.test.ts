// Story 18.3b · AC1 — caracterização do retry (`existingProductGid`) do RealShopifyAdapter DE VERDADE
// contra uma Shopify simulada por HTTP (com estado). O `fetch` falso responde por nome da operação,
// aplica `productVariantsBulkUpdate/Create/Delete` de verdade e guarda cada mutação com suas variáveis,
// na ordem. Molde: reconcile-tag.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShopifyProductPayload, ShopifyVariantInput } from '../adapter.interface.js';
import { RealShopifyAdapter } from '../real.adapter.js';

const ORIGINAL_FETCH = global.fetch;
const TOKEN = 'shpat_SEGREDO_ADMIN_TOKEN';
const PRODUCT_GID = 'gid://shopify/Product/500';
const vgid = (n: number | string): string => `gid://shopify/ProductVariant/${n}`;

interface FakeVariant {
  id: string;
  price: string;
  compareAtPrice: string | null;
  sku: string;
  inventoryPolicy: string;
  options: string[];
}
interface FakeProduct {
  id: string;
  title: string;
  optionNames: string[];
  variants: FakeVariant[];
  tags: string[];
  mediaCount: number;
}
interface Mutation {
  op: string;
  variables: Record<string, unknown>;
}
interface FakeOptions {
  /** `getProductState` responde como as Shopify simuladas antigas (sem pageInfo nem selectedOptions). */
  legacyState?: boolean;
  /** `variants(first: 100)` diz que há mais páginas. */
  hasNextPage?: boolean;
  /** Mutação que falha: `userErrors` (200 com erro de negócio) ou status HTTP. */
  failOn?: Record<string, 'userErrors' | number>;
}

/** SKU da família do produto (`BS-abc123-NNN`), estável por combinação de opções. */
const skuOf = (opts: readonly string[]): string => `BS-abc123-${[...opts.join('/')].reduce((a, c) => a + c.charCodeAt(0), 0)}`;

const json = (data: unknown): Response =>
  new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });

function seedProduct(variants: Array<{ id: number; options: string[]; price?: string }>): FakeProduct {
  return {
    id: PRODUCT_GID,
    title: 'Camisa',
    optionNames: ['Cor', 'Tamanho'],
    variants: variants.map((v) => ({
      id: vgid(v.id),
      price: v.price ?? '100.00',
      compareAtPrice: null,
      sku: `BS-abc123-${v.id}`, // família de SKU do produto no BlackShop (publish.processor: BS-xxxxxx-NNN)
      inventoryPolicy: 'DENY',
      options: v.options,
    })),
    tags: [],
    mediaCount: 1,
  };
}

function fakeShopify(product: FakeProduct, opts: FakeOptions = {}) {
  const mutations: Mutation[] = [];
  const queries: string[] = [];
  let nextId = 900;
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const kind = /^\s*(mutation|query)\s+(\w+)/.exec(body.query);
    const op = kind?.[2] ?? '?';
    const v = body.variables;
    if (kind?.[1] === 'mutation') mutations.push({ op, variables: structuredClone(v) });
    else queries.push(op);

    const failure = opts.failOn?.[op];
    if (typeof failure === 'number') return new Response('upstream boom', { status: failure });
    const userErrors = failure === 'userErrors' ? [{ field: ['variants'], message: `${op} recusado` }] : [];

    switch (op) {
      case 'getProductState':
        return json({
          product: {
            id: product.id,
            title: product.title,
            handle: 'camisa',
            status: 'ACTIVE',
            options: product.optionNames.map((name, i) => ({ id: `gid://shopify/ProductOption/${i}`, name })),
            variants: opts.legacyState
              ? { edges: product.variants.map((pv) => ({ node: { id: pv.id } })) }
              : {
                  edges: product.variants.map((pv) => ({
                    node: { id: pv.id, sku: pv.sku, selectedOptions: pv.options.map((value, i) => ({ name: product.optionNames[i] ?? `O${i}`, value })) },
                  })),
                  pageInfo: { hasNextPage: opts.hasNextPage ?? false },
                },
            media: { edges: Array.from({ length: Math.min(product.mediaCount, 1) }, (_, i) => ({ node: { id: `m${i}` } })) },
          },
        });
      case 'getProductVariants':
        return json({
          product: {
            id: product.id,
            variants: {
              edges: product.variants.map((pv) => ({
                node: { id: pv.id, selectedOptions: pv.options.map((value, i) => ({ name: product.optionNames[i] ?? `O${i}`, value })) },
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      case 'tagsRemove':
        product.tags = product.tags.filter((t) => !(v['tags'] as string[]).includes(t));
        return json({ tagsRemove: { userErrors: [] } });
      case 'productUpdate': {
        const input = v['input'] as { title: string };
        product.title = input.title;
        return json({ productUpdate: { product: { id: product.id, title: input.title, handle: 'camisa' }, userErrors: [] } });
      }
      case 'productVariantsBulkUpdate': {
        if (userErrors.length) return json({ productVariantsBulkUpdate: { productVariants: [], userErrors } });
        const inputs = v['variants'] as Array<Record<string, unknown>>;
        const missing = inputs.filter((i) => !product.variants.some((pv) => pv.id === i['id']));
        if (missing.length) {
          return json({
            productVariantsBulkUpdate: { productVariants: [], userErrors: [{ field: ['variants'], message: `Variant ${String(missing[0]!['id'])} does not exist` }] },
          });
        }
        for (const i of inputs) {
          const target = product.variants.find((pv) => pv.id === i['id'])!;
          target.price = String(i['price']);
          if ('compareAtPrice' in i) target.compareAtPrice = (i['compareAtPrice'] as string | null) ?? null;
          if (typeof i['inventoryPolicy'] === 'string') target.inventoryPolicy = i['inventoryPolicy'];
        }
        return json({ productVariantsBulkUpdate: { productVariants: inputs.map((i) => ({ id: i['id'] })), userErrors: [] } });
      }
      case 'productVariantsBulkCreate': {
        if (userErrors.length) return json({ productVariantsBulkCreate: { productVariants: [], userErrors } });
        const inputs = v['variants'] as Array<{
          price: string;
          compareAtPrice?: string | null;
          inventoryItem?: { sku?: string };
          inventoryPolicy?: string;
          optionValues?: Array<{ optionName: string; name: string }>;
        }>;
        const created = inputs.map((i) => {
          const variant: FakeVariant = {
            id: vgid(++nextId),
            price: i.price,
            compareAtPrice: i.compareAtPrice ?? null,
            sku: i.inventoryItem?.sku ?? '',
            inventoryPolicy: i.inventoryPolicy ?? 'DENY',
            options: (i.optionValues ?? []).map((o) => o.name),
          };
          product.variants.push(variant);
          return variant;
        });
        return json({ productVariantsBulkCreate: { productVariants: created.map((c) => ({ id: c.id })), userErrors: [] } });
      }
      case 'productVariantsBulkDelete': {
        if (userErrors.length) return json({ productVariantsBulkDelete: { product: null, userErrors } });
        const ids = v['variantsIds'] as string[];
        product.variants = product.variants.filter((pv) => !ids.includes(pv.id));
        return json({ productVariantsBulkDelete: { product: { id: product.id }, userErrors: [] } });
      }
      default:
        return json({});
    }
  });
  return { product, mutations, queries, fetchMock };
}

function adapter(): RealShopifyAdapter {
  const a = new RealShopifyAdapter(TOKEN, 'loja.myshopify.com', { throttleDelayMs: 1, timeoutMs: 1_000 });
  (a as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => undefined;
  return a;
}

/** Variante do payload. `mirror` ausente = chamador que não conhece o vínculo (campo não vai). */
function pv(opts: [string, string], price: string, mirror?: string | null, extra: Partial<ShopifyVariantInput> = {}): ShopifyVariantInput {
  const variant = {
    title: `${opts[0]} / ${opts[1]}`,
    price,
    sku: skuOf(opts),
    inventoryPolicy: 'DENY' as const,
    optionValues: [...opts],
    ...extra,
    ...(mirror !== undefined && { mirrorVariantId: mirror }),
  };
  return variant;
}

function retryPayload(variants: ShopifyVariantInput[]): ShopifyProductPayload {
  return { title: 'Camisa', variants, optionNames: ['Cor', 'Tamanho'], images: [], existingProductGid: PRODUCT_GID };
}

const PRODUCT_UPDATE: Mutation = {
  op: 'productUpdate',
  variables: { input: { id: PRODUCT_GID, title: 'Camisa', descriptionHtml: '', vendor: '', productType: '' } },
};
const bulkUpdate = (inputs: Array<Record<string, unknown>>): Mutation => ({
  op: 'productVariantsBulkUpdate',
  variables: { productId: PRODUCT_GID, variants: inputs },
});
const priceInput = (id: number | string, price: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: vgid(id),
  price,
  ...extra,
  inventoryPolicy: 'DENY',
});
const bulkDelete = (ids: number[]): Mutation => ({
  op: 'productVariantsBulkDelete',
  variables: { productId: PRODUCT_GID, variantsIds: ids.map(vgid) },
});
const bulkCreate = (inputs: Array<{ price: string; sku: string; opts: [string, string] }>): Mutation => ({
  op: 'productVariantsBulkCreate',
  variables: {
    productId: PRODUCT_GID,
    variants: inputs.map((i) => ({
      price: i.price,
      inventoryItem: { sku: i.sku },
      inventoryPolicy: 'DENY',
      optionValues: [
        { optionName: 'Cor', name: i.opts[0] },
        { optionName: 'Tamanho', name: i.opts[1] },
      ],
    })),
  },
});

const S3 = (): FakeProduct =>
  seedProduct([
    { id: 101, options: ['Preto', 'M'] },
    { id: 102, options: ['Preto', 'G'] },
    { id: 103, options: ['Branco', 'M'], price: '110.00' },
  ]);

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

// ── Golden de não-regressão (AC1 a, b, f): as listas de mutações ficam IDÊNTICAS depois da correção ──
const GOLDEN_A: Mutation[] = [
  PRODUCT_UPDATE,
  bulkUpdate([priceInput(101, '150.00', { compareAtPrice: '199.00' }), priceInput(102, '151.00'), priceInput(103, '152.00')]),
];
const GOLDEN_B: Mutation[] = [
  PRODUCT_UPDATE,
  bulkUpdate([priceInput(101, '100.00'), priceInput(102, '100.00'), priceInput(103, '110.00')]),
  bulkCreate([{ price: '115.00', sku: skuOf(['Branco', 'G']), opts: ['Branco', 'G'] }]),
];

describe('AC1 · caracterização do retry com a Shopify simulada por HTTP', () => {
  it('(a) só preço (3→3, mesma ordem): um bulkUpdate por id — golden', async () => {
    const shop = fakeShopify(S3());
    global.fetch = shop.fetchMock as unknown as typeof fetch;
    const res = await adapter().createProduct(
      retryPayload([
        pv(['Preto', 'M'], '150.00', vgid(101), { compareAtPrice: '199.00' }),
        pv(['Preto', 'G'], '151.00', '102'),
        pv(['Branco', 'M'], '152.00', vgid(103)),
      ]),
    );
    expect(shop.mutations).toStrictEqual(GOLDEN_A);
    expect(res.variantIds).toStrictEqual(['101', '102', '103']);
  });

  it('(b) variante nova no fim: update das 3 + um bulkCreate da nova — golden', async () => {
    const shop = fakeShopify(S3());
    global.fetch = shop.fetchMock as unknown as typeof fetch;
    const res = await adapter().createProduct(
      retryPayload([
        pv(['Preto', 'M'], '100.00', vgid(101)),
        pv(['Preto', 'G'], '100.00', vgid(102)),
        pv(['Branco', 'M'], '110.00', vgid(103)),
        pv(['Branco', 'G'], '115.00', null),
      ]),
    );
    expect(shop.mutations).toStrictEqual(GOLDEN_B);
    expect(res.variantIds).toStrictEqual(['101', '102', '103', '901']);
  });

  // (c), (d), (e) registravam o defeito (1º commit: "hoje: …"); a correção os transforma nos ACs 2, 4 e 5.
  it('(c) → AC2 · variante do meio removida: update por id de s1 e s3, delete de s2, devolve [s1, s3]; repetir converge', async () => {
    const shop = fakeShopify(S3());
    global.fetch = shop.fetchMock as unknown as typeof fetch;
    const payload = retryPayload([pv(['Preto', 'M'], '100.00', vgid(101)), pv(['Branco', 'M'], '120.00', vgid(103))]);
    const res = await adapter().createProduct(payload);
    expect(shop.mutations).toStrictEqual([
      PRODUCT_UPDATE,
      bulkUpdate([priceInput(101, '100.00'), priceInput(103, '120.00')]),
      bulkDelete([102]),
    ]);
    // Nenhuma mutação, em momento algum, grava preço em s2.
    expect(shop.mutations.some((m) => JSON.stringify(m.variables).includes(`"id":"${vgid(102)}","price"`))).toBe(false);
    expect(res.variantIds).toStrictEqual(['101', '103']);
    expect(shop.product.variants.map((x) => [x.id, x.price])).toStrictEqual([
      [vgid(101), '100.00'],
      [vgid(103), '120.00'],
    ]);

    // Idempotência: a segunda execução idêntica não cria nem remove nada.
    shop.mutations.length = 0;
    const again = await adapter().createProduct(payload);
    expect(shop.mutations).toStrictEqual([PRODUCT_UPDATE, bulkUpdate([priceInput(101, '100.00'), priceInput(103, '120.00')])]);
    expect(again.variantIds).toStrictEqual(['101', '103']);
  });

  it('(d) → AC4 · ordem trocada: cada preço vai para o id do seu vínculo; variantIds na ordem do payload', async () => {
    const shop = fakeShopify(S3());
    global.fetch = shop.fetchMock as unknown as typeof fetch;
    const res = await adapter().createProduct(
      retryPayload([
        pv(['Branco', 'M'], '130.00', vgid(103)),
        pv(['Preto', 'M'], '110.00', vgid(101)),
        pv(['Preto', 'G'], '120.00', vgid(102)),
      ]),
    );
    expect(shop.mutations).toStrictEqual([
      PRODUCT_UPDATE,
      bulkUpdate([priceInput(103, '130.00'), priceInput(101, '110.00'), priceInput(102, '120.00')]),
    ]);
    expect(res.variantIds).toStrictEqual(['103', '101', '102']);
  });

  it('(e) → AC5 · variante nova no meio: criada; as existentes atualizadas por id', async () => {
    const shop = fakeShopify(
      seedProduct([
        { id: 101, options: ['Preto', 'M'] },
        { id: 102, options: ['Preto', 'G'] },
      ]),
    );
    global.fetch = shop.fetchMock as unknown as typeof fetch;
    const res = await adapter().createProduct(
      retryPayload([pv(['Preto', 'M'], '100.00', vgid(101)), pv(['Branco', 'G'], '140.00', null), pv(['Preto', 'G'], '105.00', vgid(102))]),
    );
    expect(shop.mutations).toStrictEqual([
      PRODUCT_UPDATE,
      bulkUpdate([priceInput(101, '100.00'), priceInput(102, '105.00')]),
      bulkCreate([{ price: '140.00', sku: skuOf(['Branco', 'G']), opts: ['Branco', 'G'] }]),
    ]);
    expect(res.variantIds).toStrictEqual(['101', '901', '102']);
  });
});

// ── (f) chamador que não conhece o vínculo (LandingLab, mock, testes antigos) — golden posicional ──
const GOLDEN_F_PRICE: Mutation[] = [PRODUCT_UPDATE, bulkUpdate([priceInput(101, '150.00'), priceInput(102, '151.00'), priceInput(103, '152.00')])];
const GOLDEN_F_MIDDLE: Mutation[] = [PRODUCT_UPDATE, bulkUpdate([priceInput(101, '100.00'), priceInput(102, '120.00')])];
const GOLDEN_F_END: Mutation[] = GOLDEN_B;

describe('AC1 (f) / AC10 · sem mirrorVariantId em nenhuma variante = caminho antigo (posicional), golden', () => {
  it.each([
    ['só preço', [pv(['Preto', 'M'], '150.00'), pv(['Preto', 'G'], '151.00'), pv(['Branco', 'M'], '152.00')], GOLDEN_F_PRICE, ['101', '102', '103']],
    ['do meio removida', [pv(['Preto', 'M'], '100.00'), pv(['Branco', 'M'], '120.00')], GOLDEN_F_MIDDLE, ['101', '102', '103']],
    [
      'nova no fim',
      [pv(['Preto', 'M'], '100.00'), pv(['Preto', 'G'], '100.00'), pv(['Branco', 'M'], '110.00'), pv(['Branco', 'G'], '115.00')],
      GOLDEN_F_END,
      ['101', '102', '103', '901'],
    ],
  ] as const)('%s', async (_name, variants, golden, ids) => {
    const shop = fakeShopify(S3());
    global.fetch = shop.fetchMock as unknown as typeof fetch;
    const res = await adapter().createProduct(retryPayload([...variants]));
    expect(shop.mutations).toStrictEqual(golden);
    expect(res.variantIds).toStrictEqual(ids);
  });

  it('Shopify simulada antiga (getProductState sem pageInfo nem selectedOptions) continua funcionando', async () => {
    const shop = fakeShopify(S3(), { legacyState: true });
    global.fetch = shop.fetchMock as unknown as typeof fetch;
    const res = await adapter().createProduct(retryPayload([pv(['Preto', 'M'], '150.00'), pv(['Preto', 'G'], '151.00'), pv(['Branco', 'M'], '152.00')]));
    expect(shop.mutations).toStrictEqual(GOLDEN_F_PRICE);
    expect(res.variantIds).toStrictEqual(['101', '102', '103']);
  });
});

// ── AC3, AC5, AC6 · casamento por vínculo, opções e "Default Title" ──
describe('AC3/AC5/AC6 · casamento e execução', () => {
  it('AC3 · adicionar no fim: update das 3 por id, um create com optionValues e sku, sem delete; ids na ordem do payload', async () => {
    const shop = fakeShopify(S3());
    global.fetch = shop.fetchMock as unknown as typeof fetch;
    const res = await adapter().createProduct(
      retryPayload([
        pv(['Preto', 'M'], '100.00', vgid(101)),
        pv(['Preto', 'G'], '100.00', vgid(102)),
        pv(['Branco', 'M'], '110.00', vgid(103)),
        pv(['Branco', 'G'], '115.00', null),
      ]),
    );
    expect(shop.mutations.map((m) => m.op)).toStrictEqual(['productUpdate', 'productVariantsBulkUpdate', 'productVariantsBulkCreate']);
    expect(res.variantIds).toStrictEqual(['101', '102', '103', '901']);
    expect(shop.product.variants.at(-1)).toMatchObject({ sku: skuOf(['Branco', 'G']), options: ['Branco', 'G'], price: '115.00' });
  });

  it('AC5 · remove P e adiciona GG no mesmo salvar: GG criada, s1 removida, s1 nunca recebe o preço de GG', async () => {
    const shop = fakeShopify(
      seedProduct([
        { id: 101, options: ['Preto', 'P'] },
        { id: 102, options: ['Preto', 'M'] },
      ]),
    );
    global.fetch = shop.fetchMock as unknown as typeof fetch;
    const res = await adapter().createProduct(retryPayload([pv(['Preto', 'M'], '120.00', vgid(102)), pv(['Preto', 'GG'], '130.00', null)]));
    expect(shop.mutations).toStrictEqual([
      PRODUCT_UPDATE,
      bulkUpdate([priceInput(102, '120.00')]),
      bulkCreate([{ price: '130.00', sku: skuOf(['Preto', 'GG']), opts: ['Preto', 'GG'] }]),
      bulkDelete([101]),
    ]);
    expect(res.variantIds).toStrictEqual(['102', '901']);
  });

  it('AC6 · vínculo null ou velho casa por opções normalizadas ("Bege/M" ↔ "bege / m"); sem par → criada', async () => {
    const shop = fakeShopify(
      seedProduct([
        { id: 101, options: ['bege', ' m '] },
        { id: 102, options: ['Off_White', 'G'] },
      ]),
    );
    global.fetch = shop.fetchMock as unknown as typeof fetch;
    const res = await adapter().createProduct(
      retryPayload([
        pv(['Bege', 'M'], '90.00', null),
        pv(['Off-White', 'G'], '95.00', vgid(999999)), // vínculo que não existe mais na Shopify
        pv(['Azul', 'G'], '99.00', null),
      ]),
    );
    expect(shop.mutations).toStrictEqual([
      PRODUCT_UPDATE,
      bulkUpdate([priceInput(101, '90.00'), priceInput(102, '95.00')]),
      bulkCreate([{ price: '99.00', sku: skuOf(['Azul', 'G']), opts: ['Azul', 'G'] }]),
    ]);
    expect(res.variantIds).toStrictEqual(['101', '102', '901']);
  });

  it('AC6 · produto de 1 variante nos dois lados casa mesmo com opções divergentes ("Default Title")', async () => {
    const product = seedProduct([{ id: 101, options: ['Default Title'] }]);
    product.optionNames = ['Title'];
    const shop = fakeShopify(product);
    global.fetch = shop.fetchMock as unknown as typeof fetch;
    const res = await adapter().createProduct({
      title: 'Camisa',
      variants: [{ title: 'Default', price: '80.00', sku: 'BS-1-001', mirrorVariantId: null }],
      images: [],
      existingProductGid: PRODUCT_GID,
    });
    expect(shop.mutations).toStrictEqual([PRODUCT_UPDATE, bulkUpdate([{ id: vgid(101), price: '80.00' }])]);
    expect(res.variantIds).toStrictEqual(['101']);
  });

  it('shell sem opções (1ª tentativa caiu antes do passo 3): a variante padrão vira a 1ª do payload, nada é recusado', async () => {
    const product = seedProduct([{ id: 101, options: ['Default Title'] }]);
    product.optionNames = [];
    const shop = fakeShopify(product);
    // productOptionsCreate: a Shopify dá à variante padrão os primeiros valores de cada opção.
    const base = shop.fetchMock.getMockImplementation()!;
    shop.fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { options: Array<{ name: string; values: Array<{ name: string }> }> };
      };
      if (/mutation productOptionsCreate/.test(body.query)) {
        shop.mutations.push({ op: 'productOptionsCreate', variables: structuredClone(body.variables) });
        product.optionNames = body.variables.options.map((o) => o.name);
        product.variants[0]!.options = body.variables.options.map((o) => o.values[0]!.name);
        return json({ productOptionsCreate: { product: { id: product.id, options: [] }, userErrors: [] } });
      }
      return base(url, init);
    });
    global.fetch = shop.fetchMock as unknown as typeof fetch;
    const res = await adapter().createProduct({
      ...retryPayload([pv(['Preto', 'M'], '100.00', null), pv(['Preto', 'G'], '101.00', null)]),
      existingProductGid: '500',
    });
    expect(shop.mutations.map((m) => m.op)).toStrictEqual([
      'productUpdate',
      'productOptionsCreate',
      'productVariantsBulkUpdate',
      'productVariantsBulkCreate',
    ]);
    expect(res.variantIds).toStrictEqual(['101', '901']);
    expect(shop.product.variants.map((x) => [x.options.join('/'), x.price])).toStrictEqual([
      ['Preto/M', '100.00'],
      ['Preto/G', '101.00'],
    ]);
  });

  it('removeOrphans=false: órfã fica na Shopify, só log warn com os ids', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const shop = fakeShopify(S3());
    global.fetch = shop.fetchMock as unknown as typeof fetch;
    const a = new RealShopifyAdapter(TOKEN, 'loja.myshopify.com', { throttleDelayMs: 1, removeOrphans: false });
    const res = await a.createProduct(retryPayload([pv(['Preto', 'M'], '100.00', vgid(101)), pv(['Branco', 'M'], '120.00', vgid(103))]));
    expect(shop.mutations.map((m) => m.op)).toStrictEqual(['productUpdate', 'productVariantsBulkUpdate']);
    expect(res.variantIds).toStrictEqual(['101', '103']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('órfãs mantidas'), { productId: '500', orphanVariantIds: ['102'] });
  });
});

// ── AC7 · propriedades com sementes fixas ──
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(rand: () => number, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
const COLORS = ['Preto', 'Branco', 'Azul', 'Bege'];
const SIZES = ['P', 'M', 'G', 'GG'];

describe('AC7 · propriedades (I1–I5) — 250 cenários gerados com sementes fixas', () => {
  it('remoção, adição, embaralhamento e vínculos null/velhos: preço no id do vínculo, sem órfãs, ids na ordem do payload, idempotente', async () => {
    let refused = 0;
    let checked = 0;
    for (let seed = 1; seed <= 250; seed++) {
      const rand = mulberry32(seed);
      const combos = shuffle(rand, COLORS.flatMap((c) => SIZES.map((s) => [c, s] as [string, string])));
      const remoteCount = 1 + Math.floor(rand() * 6);
      const remoteCombos = combos.slice(0, remoteCount);
      const shop = fakeShopify(seedProduct(remoteCombos.map((opts, i) => ({ id: 101 + i, options: opts }))));
      global.fetch = shop.fetchMock as unknown as typeof fetch;

      // Mantidas (com vínculo, sem vínculo ou com vínculo velho) + novas (combinações fora do remoto).
      const kept = remoteCombos.map((opts, i) => ({ opts, remoteId: String(101 + i) as string | null })).filter(() => rand() < 0.7);
      const fresh = combos.slice(remoteCount, remoteCount + Math.floor(rand() * 3)).map((opts) => ({ opts, remoteId: null as string | null }));
      const entries = shuffle(rand, [...kept, ...fresh]).map((e, k) => {
        const r = rand();
        const mirror = e.remoteId === null ? null : r < 0.25 ? null : r < 0.35 ? vgid(888000 + k) : r < 0.7 ? vgid(e.remoteId) : e.remoteId;
        return { ...e, price: `${100 + Math.floor(rand() * 900)}.00`, mirror };
      });
      if (entries.length === 0) continue;
      const payload = retryPayload(entries.map((e) => pv(e.opts, e.price, e.mirror)));

      if (kept.length === 0 && (entries.length > 1 || remoteCount > 1)) {
        // Nada casa num produto de várias variantes → recusa sem escrever (Decisão 4c).
        await expect(adapter().createProduct(payload)).rejects.toMatchObject({ code: 'shopify.variant_plan_no_match' });
        expect(shop.mutations).toStrictEqual([]);
        refused++;
        continue;
      }

      const res = await adapter().createProduct(payload);
      checked++;
      const finalById = new Map(shop.product.variants.map((x) => [x.id, x]));
      const r3 = kept.length === 0; // 1 variante dos dois lados: casou por R3 (opções divergentes)
      const orphanIds = r3 ? [] : remoteCombos.map((_, i) => vgid(101 + i)).filter((id) => !kept.some((k) => vgid(k.remoteId!) === id));
      // I1 · o preço gravado em cada id remoto é o do payload cujo vínculo (ou opções) é aquele id.
      for (const e of entries) {
        if (e.remoteId !== null) expect(finalById.get(vgid(e.remoteId))?.price, `seed ${seed}`).toBe(e.price);
      }
      // I2 · nenhum preço gravado em variante órfã.
      const updatedIds = shop.mutations
        .filter((m) => m.op === 'productVariantsBulkUpdate')
        .flatMap((m) => (m.variables['variants'] as Array<{ id: string }>).map((i) => i.id));
      for (const id of orphanIds) expect(updatedIds, `seed ${seed}`).not.toContain(id);
      // I3 · conjunto final = casadas + novas, sem órfãs.
      expect(shop.product.variants.length, `seed ${seed}`).toBe(entries.length);
      for (const id of orphanIds) expect(finalById.has(id), `seed ${seed}`).toBe(false);
      // I4 · variantIds com o comprimento e na ordem do payload.
      expect(res.variantIds!.length, `seed ${seed}`).toBe(entries.length);
      entries.forEach((e, i) => {
        const v = finalById.get(vgid(res.variantIds![i]!))!;
        if (!r3) expect(v.options, `seed ${seed}`).toStrictEqual(e.opts);
        expect(v.price, `seed ${seed}`).toBe(e.price);
      });
      // I5 · repetir só reenvia os mesmos preços.
      const before = structuredClone(shop.product.variants);
      shop.mutations.length = 0;
      const again = await adapter().createProduct(payload);
      expect(shop.mutations.map((m) => m.op), `seed ${seed}`).toStrictEqual(['productUpdate', 'productVariantsBulkUpdate']);
      expect(shop.product.variants, `seed ${seed}`).toStrictEqual(before);
      expect(again.variantIds, `seed ${seed}`).toStrictEqual(res.variantIds);
    }
    expect(refused).toBeGreaterThan(0);
    expect(checked + refused).toBeGreaterThanOrEqual(200);
  });
});

// ── AC8 · plano recusado = zero escrita ──
describe('AC8 · plano recusado lança ShopifyVariantPlanError sem nenhuma mutação', () => {
  it.each([
    [
      '(a) dois com o mesmo vínculo',
      {},
      [pv(['Preto', 'M'], '100.00', vgid(101)), pv(['Preto', 'G'], '100.00', '101')],
      'shopify.variant_plan_duplicate_mirror',
      /mesma variante da Shopify/,
    ],
    [
      '(b) remoto com mais de 100 variantes (hasNextPage)',
      { hasNextPage: true },
      [pv(['Preto', 'M'], '100.00', vgid(101))],
      'shopify.variant_plan_remote_truncated',
      /mais de 100 variantes/,
    ],
    [
      '(c) nenhuma casa num produto de várias variantes',
      {},
      [pv(['Verde', 'P'], '100.00', null), pv(['Verde', 'M'], '100.00', vgid(777))],
      'shopify.variant_plan_no_match',
      /nenhuma das 2 variante/,
    ],
  ] as const)('%s', async (_name, fakeOpts, variants, code, message) => {
    const shop = fakeShopify(S3(), fakeOpts);
    global.fetch = shop.fetchMock as unknown as typeof fetch;
    const onShellCreated = vi.fn(async () => undefined);
    const err = await adapter()
      .createProduct({ ...retryPayload([...variants]), reconcileTag: 'bs-product-1', onShellCreated })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'ShopifyVariantPlanError', code });
    const msg = (err as Error).message;
    expect(msg).toMatch(message);
    expect(msg).toMatch(/Nada foi alterado na Shopify/);
    expect(msg).toMatch(/publique de novo/);
    expect(msg).not.toContain(TOKEN);
    expect(msg).not.toMatch(/https?:\/\//);
    expect(shop.mutations).toStrictEqual([]); // nem tagsRemove, nem productUpdate, nem update/create/delete
    expect(onShellCreated).not.toHaveBeenCalled();
    expect(shop.product.variants.map((x) => x.price)).toStrictEqual(['100.00', '100.00', '110.00']);
  });

  it('caminho antigo (sem vínculo) com hasNextPage não é recusado — comportamento de hoje', async () => {
    const shop = fakeShopify(S3(), { hasNextPage: true });
    global.fetch = shop.fetchMock as unknown as typeof fetch;
    await adapter().createProduct(retryPayload([pv(['Preto', 'M'], '150.00'), pv(['Preto', 'G'], '151.00'), pv(['Branco', 'M'], '152.00')]));
    expect(shop.mutations).toStrictEqual(GOLDEN_F_PRICE);
  });
});

// ── QA 18.3b · órfã que NÃO é do BlackShop (criada à mão só na Shopify) nunca é apagada ──
describe('QA 18.3b · órfã fora da família de SKU do produto (criada à mão na Shopify)', () => {
  const handMade = (sku: string): FakeProduct => {
    const product = S3();
    product.variants[1]!.sku = sku; // s2 criada à mão na Shopify, sem vínculo com o BlackShop
    return product;
  };

  it.each([['SKU vazio', ''], ['SKU de outro padrão', 'MANUAL-PRETO-G'], ['SKU de outro produto BlackShop', 'BS-ffffff-002']])(
    '%s: plano recusado (variant_plan_foreign_orphan), zero mutação, s2 continua na Shopify',
    async (_name, sku) => {
      const shop = fakeShopify(handMade(sku));
      global.fetch = shop.fetchMock as unknown as typeof fetch;
      const onShellCreated = vi.fn(async () => undefined);
      const err = await adapter()
        .createProduct({
          ...retryPayload([pv(['Preto', 'M'], '100.00', vgid(101)), pv(['Branco', 'M'], '120.00', vgid(103))]),
          reconcileTag: 'bs-product-1',
          onShellCreated,
        })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ name: 'ShopifyVariantPlanError', code: 'shopify.variant_plan_foreign_orphan' });
      const msg = (err as Error).message;
      expect(msg).toMatch(/102/);
      expect(msg).toMatch(/Remova-a\(s\) na Shopify/);
      expect(msg).toMatch(/Nada foi alterado na Shopify/);
      expect(msg).not.toContain(TOKEN);
      expect(msg).not.toMatch(/https?:\/\//);
      expect(shop.mutations).toStrictEqual([]);
      expect(onShellCreated).not.toHaveBeenCalled();
      expect(shop.product.variants.map((x) => x.id)).toStrictEqual([vgid(101), vgid(102), vgid(103)]);
    },
  );

  it('órfã do BlackShop é removida mesmo com outra variante à mão casada por opções (adotada, não apagada)', async () => {
    const product = handMade('');
    const shop = fakeShopify(product);
    global.fetch = shop.fetchMock as unknown as typeof fetch;
    // s2 (à mão, Preto/G) casa por opções com uma variante nova do payload → adotada; s3 (BlackShop) é órfã → removida.
    const res = await adapter().createProduct(retryPayload([pv(['Preto', 'M'], '100.00', vgid(101)), pv(['Preto', 'G'], '105.00', null)]));
    expect(shop.mutations).toStrictEqual([PRODUCT_UPDATE, bulkUpdate([priceInput(101, '100.00'), priceInput(102, '105.00')]), bulkDelete([103])]);
    expect(res.variantIds).toStrictEqual(['101', '102']);
  });

  it('removeOrphans=false: órfã à mão não recusa nada — só o warn de sempre', async () => {
    const shop = fakeShopify(handMade(''));
    global.fetch = shop.fetchMock as unknown as typeof fetch;
    const a = new RealShopifyAdapter(TOKEN, 'loja.myshopify.com', { throttleDelayMs: 1, removeOrphans: false });
    const res = await a.createProduct(retryPayload([pv(['Preto', 'M'], '100.00', vgid(101)), pv(['Branco', 'M'], '120.00', vgid(103))]));
    expect(shop.mutations.map((m) => m.op)).toStrictEqual(['productUpdate', 'productVariantsBulkUpdate']);
    expect(res.variantIds).toStrictEqual(['101', '103']);
  });
});

// ── AC9 · falha no meio é recuperável ──
describe('AC9 · falha no meio', () => {
  const removeMiddle = () => retryPayload([pv(['Preto', 'M'], '100.00', vgid(101)), pv(['Branco', 'M'], '120.00', vgid(103))]);

  it('(a) delete com userErrors lança depois dos updates; a segunda execução só remove o órfão', async () => {
    const shop = fakeShopify(S3(), { failOn: { productVariantsBulkDelete: 'userErrors' } });
    global.fetch = shop.fetchMock as unknown as typeof fetch;
    await expect(adapter().createProduct(removeMiddle())).rejects.toThrow(
      /^Product \(id=500\) variant removal failed: productVariantsBulkDelete recusado$/,
    );
    expect(shop.mutations.map((m) => m.op)).toStrictEqual(['productUpdate', 'productVariantsBulkUpdate', 'productVariantsBulkDelete']);
    expect(shop.product.variants.map((x) => [x.id, x.price])).toStrictEqual([
      [vgid(101), '100.00'],
      [vgid(102), '100.00'],
      [vgid(103), '120.00'],
    ]);

    // Segunda execução com a Shopify já nesse estado: os preços já estão certos; a única mudança é a remoção.
    const healthy = fakeShopify(shop.product);
    global.fetch = healthy.fetchMock as unknown as typeof fetch;
    const res = await adapter().createProduct(removeMiddle());
    expect(healthy.mutations).toStrictEqual([
      PRODUCT_UPDATE,
      bulkUpdate([priceInput(101, '100.00'), priceInput(103, '120.00')]),
      bulkDelete([102]),
    ]);
    expect(res.variantIds).toStrictEqual(['101', '103']);
  });

  it('(b) create com userErrors lança antes de remover qualquer coisa', async () => {
    const shop = fakeShopify(
      seedProduct([
        { id: 101, options: ['Preto', 'P'] },
        { id: 102, options: ['Preto', 'M'] },
      ]),
      { failOn: { productVariantsBulkCreate: 'userErrors' } },
    );
    global.fetch = shop.fetchMock as unknown as typeof fetch;
    await expect(
      adapter().createProduct(retryPayload([pv(['Preto', 'M'], '120.00', vgid(102)), pv(['Preto', 'GG'], '130.00', null)])),
    ).rejects.toThrow(/extra variants creation failed/);
    expect(shop.mutations.map((m) => m.op)).toStrictEqual(['productUpdate', 'productVariantsBulkUpdate', 'productVariantsBulkCreate']);
    expect(shop.product.variants.map((x) => x.id)).toStrictEqual([vgid(101), vgid(102)]);
  });

  it('(c) 5xx numa mutação propaga o erro do cliente HTTP e nada é removido depois', async () => {
    const shop = fakeShopify(S3(), { failOn: { productVariantsBulkUpdate: 500 } });
    global.fetch = shop.fetchMock as unknown as typeof fetch;
    await expect(adapter().createProduct(removeMiddle())).rejects.toThrow(/Shopify Admin API error 500/);
    expect(shop.mutations.map((m) => m.op)).toStrictEqual(['productUpdate', 'productVariantsBulkUpdate']);
    expect(shop.product.variants).toHaveLength(3);
  });
});

// ── AC13 · logs ──
describe('AC13 · logs do plano e da remoção', () => {
  it('um info com o plano (contagens) e um warn com os ids removidos — sem token nem URL', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const shop = fakeShopify(S3());
    global.fetch = shop.fetchMock as unknown as typeof fetch;
    await adapter().createProduct(retryPayload([pv(['Preto', 'M'], '100.00', vgid(101)), pv(['Branco', 'M'], '120.00', vgid(103))]));
    const planLogs = info.mock.calls.filter((c) => c[0] === '[ShopifyAdapter] step 3/4 — variant plan');
    expect(planLogs).toStrictEqual([['[ShopifyAdapter] step 3/4 — variant plan', { productId: '500', update: 2, create: 0, remove: 1 }]]);
    expect(warn).toHaveBeenCalledWith('[ShopifyAdapter] step 3d/4 — removendo variantes órfãs (apagadas no BlackShop)', {
      productId: '500',
      removedVariantIds: ['102'],
    });
    const all = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toMatch(/https?:\/\//);
  });
});
