// Story 18.3 · AC13 — findProductByVariantSku (Real + Mock): consulta exata por SKU, produtos
// distintos, retentável (query) e sem vazar token.
import { UpstreamTimeoutError } from '@blackshop/shared/http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MockShopifyAdapter } from '../mock.adapter.js';
import { RealShopifyAdapter } from '../real.adapter.js';

const ORIGINAL_FETCH = global.fetch;
const TOKEN = 'shpat_SEGREDO_ADMIN_TOKEN';

function adapter() {
  const a = new RealShopifyAdapter(TOKEN, 'loja.myshopify.com', { throttleDelayMs: 1, timeoutMs: 1_000 });
  (a as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => undefined;
  return a;
}

function gqlResponse(edges: unknown[]): Response {
  return new Response(JSON.stringify({ data: { productVariants: { edges } } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const node = (sku: string | null, id: number | null, handle = `h-${id}`) => ({
  node: { sku, product: id === null ? null : { id: `gid://shopify/Product/${id}`, handle } },
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.useRealTimers();
});

describe('RealShopifyAdapter.findProductByVariantSku', () => {
  it('consulta productVariants com sku:"..." e devolve o produto (id sem gid)', async () => {
    const fetchMock = vi.fn(async () => gqlResponse([node('BS-a3f9c1-001', 111, 'camisa')]));
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await adapter().findProductByVariantSku('BS-a3f9c1-001')).toEqual([{ productId: '111', handle: 'camisa' }]);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as {
      query: string;
      variables: { query: string };
    };
    expect(body.query).toContain('productVariants(first: 20, query: $query)');
    expect(body.query.trim().startsWith('query')).toBe(true);
    expect(body.variables.query).toBe('sku:"BS-a3f9c1-001"');
  });

  it('filtra SKU exato, ignora variante sem produto e deduplica por produto', async () => {
    global.fetch = vi.fn(async () =>
      gqlResponse([
        node('BS-a3f9c1-001', 111),
        node('BS-a3f9c1-001', 111), // outra variante do mesmo produto
        node('BS-a3f9c1-0010', 222), // termo parecido, SKU diferente
        node(null, 333),
        node('BS-a3f9c1-001', null),
        node('BS-a3f9c1-001', 444),
      ]),
    ) as unknown as typeof fetch;
    expect((await adapter().findProductByVariantSku('BS-a3f9c1-001')).map((m) => m.productId)).toEqual(['111', '444']);
  });

  it('nenhum resultado → []', async () => {
    global.fetch = vi.fn(async () => gqlResponse([])) as unknown as typeof fetch;
    expect(await adapter().findProductByVariantSku('BS-000000-001')).toEqual([]);
  });

  it('aspas/barras no SKU não quebram a busca', async () => {
    const fetchMock = vi.fn(async () => gqlResponse([]));
    global.fetch = fetchMock as unknown as typeof fetch;
    await adapter().findProductByVariantSku('BS-"x\\-001');
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { variables: { query: string } };
    expect(body.variables.query).toBe('sku:"BS-x-001"');
  });

  it('é consulta: 503 é repetido (transitório), nunca incerto', async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls += 1;
      return calls < 3 ? new Response('fora', { status: 503 }) : gqlResponse([node('BS-1-001', 9)]);
    }) as unknown as typeof fetch;
    expect(await adapter().findProductByVariantSku('BS-1-001')).toEqual([{ productId: '9', handle: 'h-9' }]);
    expect(calls).toBe(3);
  });

  it('timeout da consulta sai como UpstreamTimeoutError não incerto, sem token na mensagem', async () => {
    global.fetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    ) as unknown as typeof fetch;
    const a = new RealShopifyAdapter(TOKEN, 'loja.myshopify.com', { throttleDelayMs: 1, timeoutMs: 20 });
    (a as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => undefined;
    const err = await a.findProductByVariantSku('BS-1-001').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamTimeoutError);
    expect((err as UpstreamTimeoutError).uncertain).toBe(false);
    expect((err as Error).message).not.toContain(TOKEN);
  });
});

describe('reconciliação ponta a ponta no adapter (AC13)', () => {
  it('produto achado pelo SKU → createProduct com existingProductGid: nenhuma mutation productCreate', async () => {
    const bodies: string[] = [];
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body);
      bodies.push(body);
      const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (body.includes('findProductByVariantSku')) return gqlResponse([node('BS-a3f9c1-001', 111, 'camisa')]);
      if (body.includes('getProductState'))
        return json({ product: { id: 'gid://shopify/Product/111', title: 'Camisa', handle: 'camisa', status: 'ACTIVE', options: [], variants: { edges: [] }, media: { edges: [] } } });
      if (body.includes('productUpdate')) return json({ productUpdate: { product: { id: 'gid://shopify/Product/111', title: 'Camisa', handle: 'camisa' }, userErrors: [] } });
      return json({});
    }) as unknown as typeof fetch;
    const a = adapter();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const [found] = await a.findProductByVariantSku('BS-a3f9c1-001');
    const result = await a.createProduct({ title: 'Camisa', variants: [], images: [], existingProductGid: found!.productId });
    expect(result.id).toBe('111');
    expect(bodies.some((b) => b.includes('productCreate('))).toBe(false);
    vi.restoreAllMocks();
  });
});

describe('MockShopifyAdapter.findProductByVariantSku', () => {
  it('vazio por padrão; seedProductBySku simula produtos existentes', async () => {
    const mock = new MockShopifyAdapter();
    expect(await mock.findProductByVariantSku('BS-1-001')).toEqual([]);
    mock.seedProductBySku('BS-1-001', { productId: '1', handle: 'a' });
    mock.seedProductBySku('BS-1-001', { productId: '2', handle: 'b' });
    expect(await mock.findProductByVariantSku('BS-1-001')).toHaveLength(2);
  });
});
