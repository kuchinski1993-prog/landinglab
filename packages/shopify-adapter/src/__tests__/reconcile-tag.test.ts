// Story 18.3 · QA REQ-001 — marcador de reconciliação gravado JÁ no productCreate.
// A Shopify simulada guarda o shell a partir do input REAL que createProduct envia (variante
// "Default Title" sem SKU), então os testes provam o cenário de timeout incerto de verdade.
import { UpstreamTimeoutError } from '@blackshop/shared/http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MockShopifyAdapter } from '../mock.adapter.js';
import { RealShopifyAdapter } from '../real.adapter.js';

const ORIGINAL_FETCH = global.fetch;
const TOKEN = 'shpat_SEGREDO_ADMIN_TOKEN';
const TAG = 'bs-product-11111111-2222-3333-4444-555555555555';

interface Shell {
  id: string;
  handle: string;
  tags: string[];
  variantSkus: Array<string | null>;
}

function adapter(timeoutMs = 1_000): RealShopifyAdapter {
  const a = new RealShopifyAdapter(TOKEN, 'loja.myshopify.com', { throttleDelayMs: 1, timeoutMs });
  (a as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => undefined;
  return a;
}

const json = (data: unknown): Response =>
  new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });

function fakeShopify(opts: { createTimesOut: boolean }) {
  const shells: Shell[] = [];
  const ops: Array<{ op: string; variables: Record<string, unknown> }> = [];
  const fetchMock = vi.fn((_url: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const op = /(?:mutation|query)\s+(\w+)/.exec(body.query)?.[1] ?? '?';
    const v = body.variables;
    ops.push({ op, variables: v });
    if (op === 'productCreate') {
      const input = v['input'] as { title: string; tags?: string[] };
      // A Shopify cria o shell mesmo quando a resposta se perde.
      const shell: Shell = { id: `gid://shopify/Product/${700 + shells.length}`, handle: 'camisa', tags: input.tags ?? [], variantSkus: [null] };
      shells.push(shell);
      if (opts.createTimesOut) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      }
      return Promise.resolve(
        json({
          productCreate: {
            product: { id: shell.id, title: input.title, handle: shell.handle, status: 'ACTIVE', variants: { edges: [] } },
            userErrors: [],
          },
        }),
      );
    }
    if (op === 'findProductByTag') {
      const tag = /^tag:'(.*)'$/.exec(String(v['query']))?.[1] ?? '';
      return Promise.resolve(json({ products: { edges: shells.filter((p) => p.tags.includes(tag)).map((p) => ({ node: p })) } }));
    }
    if (op === 'findProductByVariantSku') {
      const sku = /^sku:"(.*)"$/.exec(String(v['query']))?.[1];
      const edges = shells.flatMap((p) =>
        p.variantSkus.filter((s) => s === sku).map((s) => ({ node: { sku: s, product: { id: p.id, handle: p.handle } } })),
      );
      return Promise.resolve(json({ productVariants: { edges } }));
    }
    if (op === 'tagsRemove') {
      const shell = shells.find((p) => p.id === v['id']);
      if (shell) shell.tags = shell.tags.filter((t) => !(v['tags'] as string[]).includes(t));
      return Promise.resolve(json({ tagsRemove: { userErrors: [] } }));
    }
    if (op === 'getProductState') {
      const shell = shells.find((p) => p.id === v['id']);
      return Promise.resolve(
        json({
          product: shell
            ? { id: shell.id, title: 'Camisa', handle: shell.handle, status: 'ACTIVE', options: [], variants: { edges: [] }, media: { edges: [] } }
            : null,
        }),
      );
    }
    if (op === 'productUpdate') {
      return Promise.resolve(json({ productUpdate: { product: { id: 'x', title: 'Camisa', handle: 'camisa' }, userErrors: [] } }));
    }
    return Promise.resolve(json({}));
  });
  return { shells, ops, fetchMock };
}

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe('marcador de reconciliação no shell (QA REQ-001)', () => {
  it('input real do productCreate leva a tag; timeout incerto → shell SEM SKU achado pela tag → retry sem productCreate', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const shopify = fakeShopify({ createTimesOut: true });
    global.fetch = shopify.fetchMock as unknown as typeof fetch;
    const a = adapter(30);
    const onShellCreated = vi.fn(async () => undefined);

    const err = await a
      .createProduct({
        title: 'Camisa',
        variants: [{ title: 'Default', price: '10.00', sku: 'BS-111111-001' }],
        images: [],
        reconcileTag: TAG,
        onShellCreated,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamTimeoutError);
    expect((err as UpstreamTimeoutError).uncertain).toBe(true);
    expect(onShellCreated).not.toHaveBeenCalled();
    const createInput = shopify.ops.find((o) => o.op === 'productCreate')!.variables['input'] as Record<string, unknown>;
    expect(createInput['tags']).toEqual([TAG]);
    expect(createInput).not.toHaveProperty('variants'); // o shell não leva SKU
    expect(shopify.shells).toHaveLength(1);

    // Pela SKU não acha (é o bug do gate); pela tag acha exatamente 1.
    expect(await a.findProductByVariantSku('BS-111111-001')).toEqual([]);
    const found = await a.findProductByTag(TAG);
    expect(found).toEqual([{ productId: '700', handle: 'camisa' }]);

    const creates = shopify.ops.filter((o) => o.op === 'productCreate').length;
    const result = await a.createProduct({ title: 'Camisa', variants: [], images: [], existingProductGid: found[0]!.productId, reconcileTag: TAG });
    expect(result.id).toBe('700');
    expect(shopify.ops.filter((o) => o.op === 'productCreate').length).toBe(creates);
    expect(shopify.shells).toHaveLength(1);
    expect(shopify.shells[0]!.tags).toEqual([]); // marcador removido antes de publicar
  });

  it('1ª tentativa ok: tag no productCreate e removida logo depois do onShellCreated', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const shopify = fakeShopify({ createTimesOut: false });
    global.fetch = shopify.fetchMock as unknown as typeof fetch;
    const persisted: string[] = [];
    await adapter().createProduct({
      title: 'Camisa',
      variants: [],
      images: [],
      reconcileTag: TAG,
      onShellCreated: async (id) => void persisted.push(id),
    });
    expect(persisted).toEqual(['700']);
    const createIdx = shopify.ops.findIndex((o) => o.op === 'productCreate');
    const removeIdx = shopify.ops.findIndex((o) => o.op === 'tagsRemove');
    expect(removeIdx).toBeGreaterThan(createIdx);
    expect(shopify.ops[removeIdx]!.variables).toEqual({ id: 'gid://shopify/Product/700', tags: [TAG] });
    expect(shopify.shells[0]!.tags).toEqual([]);
  });

  it('sem reconcileTag: shell sem tags e nenhum tagsRemove (comportamento antigo)', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const shopify = fakeShopify({ createTimesOut: false });
    global.fetch = shopify.fetchMock as unknown as typeof fetch;
    await adapter().createProduct({ title: 'Camisa', variants: [], images: [] });
    expect(shopify.ops.find((o) => o.op === 'productCreate')!.variables['input']).not.toHaveProperty('tags');
    expect(shopify.ops.some((o) => o.op === 'tagsRemove')).toBe(false);
  });

  it('onShellCreated falhando: a tag NÃO sai (o shell continua achável)', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const shopify = fakeShopify({ createTimesOut: false });
    global.fetch = shopify.fetchMock as unknown as typeof fetch;
    await expect(
      adapter().createProduct({
        title: 'C',
        variants: [],
        images: [],
        reconcileTag: TAG,
        onShellCreated: async () => Promise.reject(new Error('db fora')),
      }),
    ).rejects.toThrow('db fora');
    expect(shopify.shells[0]!.tags).toEqual([TAG]);
  });

  it('findProductByTag: comparação exata, deduplica, termo por variável sem aspas', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        products: {
          edges: [
            { node: { id: 'gid://shopify/Product/1', handle: 'a', tags: [TAG] } },
            { node: { id: 'gid://shopify/Product/1', handle: 'a', tags: [TAG] } },
            { node: { id: 'gid://shopify/Product/2', handle: 'b', tags: [`${TAG}-x`] } },
          ],
        },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await adapter().findProductByTag(TAG)).toEqual([{ productId: '1', handle: 'a' }]);
    await adapter().findProductByTag(`bs-'x"y\\z`);
    const body = JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body)) as {
      query: string;
      variables: { query: string };
    };
    expect(body.query).toContain('products(first: 20, query: $query)');
    expect(body.variables.query).toBe("tag:'bs-xyz'");
  });

  it('tagsRemove com userErrors: só avisa, não derruba o publish', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let call = 0;
    global.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return json({
          productCreate: {
            product: { id: 'gid://shopify/Product/9', title: 't', handle: 'h', status: 'ACTIVE', variants: { edges: [] } },
            userErrors: [],
          },
        });
      }
      return json({ tagsRemove: { userErrors: [{ message: 'nope' }] } });
    }) as unknown as typeof fetch;
    const res = await adapter().createProduct({ title: 't', variants: [], images: [], reconcileTag: TAG });
    expect(res.id).toBe('9');
    expect(warn).toHaveBeenCalledWith('[ShopifyAdapter] marcador de reconciliação não removido', expect.anything());
  });

  it('tagsRemove lançando (rede): só avisa', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let call = 0;
    global.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return json({
          productCreate: {
            product: { id: 'gid://shopify/Product/9', title: 't', handle: 'h', status: 'ACTIVE', variants: { edges: [] } },
            userErrors: [],
          },
        });
      }
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect((await adapter().createProduct({ title: 't', variants: [], images: [], reconcileTag: TAG })).id).toBe('9');
    expect(warn).toHaveBeenCalled();
  });
});

describe('MockShopifyAdapter.findProductByTag', () => {
  it('vazio por padrão; seedProductByTag simula o shell marcado', async () => {
    const mock = new MockShopifyAdapter();
    expect(await mock.findProductByTag('bs-product-1')).toEqual([]);
    mock.seedProductByTag('bs-product-1', { productId: '1', handle: 'a' });
    expect(await mock.findProductByTag('bs-product-1')).toEqual([{ productId: '1', handle: 'a' }]);
  });
});

describe('remoção do marcador — resultado e nova tentativa (QA MNT-002)', () => {
  const createOk = () =>
    json({
      productCreate: {
        product: { id: 'gid://shopify/Product/9', title: 't', handle: 'h', status: 'ACTIVE', variants: { edges: [] } },
        userErrors: [],
      },
    });

  it('createProduct informa reconcileTagRemoved=true quando a tag saiu e false quando falhou (log com código)', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ok = fakeShopify({ createTimesOut: false });
    global.fetch = ok.fetchMock as unknown as typeof fetch;
    expect((await adapter().createProduct({ title: 't', variants: [], images: [], reconcileTag: TAG })).reconcileTagRemoved).toBe(true);

    let call = 0;
    global.fetch = vi.fn(async () => {
      call += 1;
      return call === 1 ? createOk() : json({ tagsRemove: { userErrors: [{ message: 'nope' }] } });
    }) as unknown as typeof fetch;
    expect((await adapter().createProduct({ title: 't', variants: [], images: [], reconcileTag: TAG })).reconcileTagRemoved).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      '[ShopifyAdapter] marcador de reconciliação não removido',
      expect.objectContaining({ code: 'loja.reconcile_tag_not_removed' }),
    );
  });

  it('sem reconcileTag o campo não aparece', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const shopify = fakeShopify({ createTimesOut: false });
    global.fetch = shopify.fetchMock as unknown as typeof fetch;
    expect(await adapter().createProduct({ title: 't', variants: [], images: [] })).not.toHaveProperty('reconcileTagRemoved');
  });

  it('removeProductTag: aceita id numérico ou gid; true no sucesso, false (sem lançar) na falha', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => json({ tagsRemove: { userErrors: [] } }));
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await adapter().removeProductTag('9', TAG)).toBe(true);
    expect(await adapter().removeProductTag('gid://shopify/Product/9', TAG)).toBe(true);
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(String((call as unknown as [string, RequestInit])[1].body)) as { variables: { id: string; tags: string[] } };
      expect(body.variables).toEqual({ id: 'gid://shopify/Product/9', tags: [TAG] });
    }
    global.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await adapter().removeProductTag('9', TAG)).toBe(false);
    expect(await new MockShopifyAdapter().removeProductTag('9', TAG)).toBe(true);
  });
});
