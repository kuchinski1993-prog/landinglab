import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createShopifyAdapter } from '../factory.js';
import { MockShopifyAdapter } from '../mock.adapter.js';
import { RealShopifyAdapter } from '../real.adapter.js';

describe('createShopifyAdapter', () => {
  it('returns MockShopifyAdapter by default', () => {
    const adapter = createShopifyAdapter('mock');
    expect(adapter).toBeInstanceOf(MockShopifyAdapter);
  });

  it('MockShopifyAdapter.createProduct returns mock id', async () => {
    const adapter = createShopifyAdapter('mock');
    const result = await adapter.createProduct({ title: 'Test Product', description_html: '<p>test</p>' });
    expect(result.id).toMatch(/^mock_/);
    expect(result.title).toBe('Test Product');
  });

  it('MockShopifyAdapter.testConnection returns ok', async () => {
    const adapter = createShopifyAdapter('mock');
    const result = await adapter.testConnection();
    expect(result.ok).toBe(true);
  });

  // Story 0.4 · AC5 — sem argumento o modo vem do resolver central.
  it('createShopifyAdapter() sem argumento: dev → mock; produção sem SHOPIFY_MODE → IntegrationModeError', () => {
    const prev = { mode: process.env['SHOPIFY_MODE'], nodeEnv: process.env['NODE_ENV'] };
    delete process.env['SHOPIFY_MODE'];
    try {
      process.env['NODE_ENV'] = 'test';
      expect(createShopifyAdapter()).toBeInstanceOf(MockShopifyAdapter);
      process.env['NODE_ENV'] = 'production';
      expect(() => createShopifyAdapter()).toThrow(expect.objectContaining({ code: 'INTEGRATION_MODE_UNSET' }));
      process.env['SHOPIFY_MODE'] = 'mock';
      expect(createShopifyAdapter()).toBeInstanceOf(MockShopifyAdapter);
    } finally {
      if (prev.mode !== undefined) process.env['SHOPIFY_MODE'] = prev.mode;
      else delete process.env['SHOPIFY_MODE'];
      process.env['NODE_ENV'] = prev.nodeEnv;
    }
  });

  it('createShopifyAdapter throws when real mode requested without credentials', () => {
    expect(() => createShopifyAdapter('real')).toThrow(/credentials are required/);
  });

  it('createShopifyAdapter("real", creds) returns a RealShopifyAdapter instance', () => {
    const adapter = createShopifyAdapter('real', {
      adminToken: 'token',
      storeDomain: 'mystore.myshopify.com',
    });
    expect(adapter).toBeInstanceOf(RealShopifyAdapter);
  });

  // Fase G · métodos novos existem no Mock e são idempotentes.
  it('MockShopifyAdapter.listPublications retorna 3 canais determinísticos', async () => {
    const adapter = new MockShopifyAdapter();
    const pubs = await adapter.listPublications();
    expect(pubs.map((p) => p.name)).toEqual(['Online Store', 'Shop', 'Point of Sale']);
  });

  it('MockShopifyAdapter.publishToPublications é idempotente (2x mesmo par não duplica)', async () => {
    const adapter = new MockShopifyAdapter();
    await adapter.publishToPublications('prod-1', ['gid://shopify/Publication/1']);
    await adapter.publishToPublications('prod-1', ['gid://shopify/Publication/1']);
    // Utilitário de debug expõe o Set — deve ter só 1 entrada.
    expect(adapter._debugPublished('prod-1')).toEqual(['gid://shopify/Publication/1']);
  });
});

// ---------------------------------------------------------------------------
// RealShopifyAdapter — HTTP-level integration tested with stubbed fetch.
// ---------------------------------------------------------------------------

function makeGraphQLResponse(data: unknown, extensions?: unknown): Response {
  // Story 0.8: Response real (o cliente lê cabeçalhos e corpo pelo fetchWithTimeout).
  return new Response(JSON.stringify({ data, extensions }), { status: 200 });
}

const ORIGINAL_FETCH = global.fetch;

describe('RealShopifyAdapter', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    vi.useRealTimers();
  });

  const adapter = new RealShopifyAdapter('test-token', 'mystore.myshopify.com', {
    throttleDelayMs: 1,
  });

  it('createProduct sends the productCreate mutation and unwraps gid', async () => {
    // Step 1: productCreate
    mockFetch.mockResolvedValueOnce(
      makeGraphQLResponse({
        productCreate: {
          product: {
            id: 'gid://shopify/Product/123',
            title: 'Test',
            handle: 'test',
            status: 'ACTIVE',
            variants: {
              edges: [{ node: { id: 'gid://shopify/ProductVariant/456' } }],
            },
          },
          userErrors: [],
        },
      }),
    );
    // Step 3: productVariantsBulkUpdate (single-variant path, no optionNames)
    mockFetch.mockResolvedValueOnce(
      makeGraphQLResponse({
        productVariantsBulkUpdate: {
          productVariants: [{ id: 'gid://shopify/ProductVariant/456' }],
          userErrors: [],
        },
      }),
    );

    const result = await adapter.createProduct({
      title: 'Test',
      variants: [{ title: 'Default', price: '10.00' }],
    });

    expect(result.id).toBe('123');
    expect(result.handle).toBe('test');
    expect(result.status).toBe('active');
    expect(result.variantIds).toEqual(['456']);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://mystore.myshopify.com/admin/api/2025-10/graphql.json');
    expect((opts.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('test-token');
    const body = JSON.parse(opts.body as string) as { query: string; variables: unknown };
    expect(body.query).toContain('productCreate');
  });

  // Fase H · inventoryPolicy fluindo até o payload de bulk update.
  it('createProduct envia inventoryPolicy=CONTINUE nas variantes quando setado', async () => {
    // Step 1: productCreate
    mockFetch.mockResolvedValueOnce(
      makeGraphQLResponse({
        productCreate: {
          product: {
            id: 'gid://shopify/Product/999',
            title: 'Test',
            handle: 'test',
            status: 'ACTIVE',
            variants: {
              edges: [{ node: { id: 'gid://shopify/ProductVariant/500' } }],
            },
          },
          userErrors: [],
        },
      }),
    );
    // Step 3: single-variant update (bulkUpdate)
    mockFetch.mockResolvedValueOnce(
      makeGraphQLResponse({
        productVariantsBulkUpdate: {
          productVariants: [{ id: 'gid://shopify/ProductVariant/500' }],
          userErrors: [],
        },
      }),
    );

    await adapter.createProduct({
      title: 'Test',
      variants: [{ title: 'Default', price: '10.00', inventoryPolicy: 'CONTINUE' }],
    });

    // Segunda chamada é o bulkUpdate; body.variables.variants[0].inventoryPolicy = CONTINUE
    const bulkCall = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(bulkCall[1].body as string) as {
      variables: { variants: Array<{ inventoryPolicy?: string }> };
    };
    expect(body.variables.variants[0]?.inventoryPolicy).toBe('CONTINUE');
  });

  it('createProduct NÃO envia inventoryPolicy quando não setado (mantém default DENY do Shopify)', async () => {
    mockFetch.mockResolvedValueOnce(
      makeGraphQLResponse({
        productCreate: {
          product: {
            id: 'gid://shopify/Product/998',
            title: 'Test',
            handle: 'test',
            status: 'ACTIVE',
            variants: {
              edges: [{ node: { id: 'gid://shopify/ProductVariant/501' } }],
            },
          },
          userErrors: [],
        },
      }),
    );
    mockFetch.mockResolvedValueOnce(
      makeGraphQLResponse({
        productVariantsBulkUpdate: {
          productVariants: [{ id: 'gid://shopify/ProductVariant/501' }],
          userErrors: [],
        },
      }),
    );

    await adapter.createProduct({
      title: 'Test',
      // Sem inventoryPolicy — respeita default Shopify.
      variants: [{ title: 'Default', price: '10.00' }],
    });

    const bulkCall = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(bulkCall[1].body as string) as {
      variables: { variants: Array<Record<string, unknown>> };
    };
    expect(body.variables.variants[0]?.['inventoryPolicy']).toBeUndefined();
  });

  it('createProduct throws when userErrors present', async () => {
    mockFetch.mockResolvedValueOnce(
      makeGraphQLResponse({
        productCreate: {
          product: null,
          userErrors: [{ field: ['title'], message: 'Title is required' }],
        },
      }),
    );
    await expect(adapter.createProduct({ title: '' })).rejects.toThrow('Title is required');
  });

  it('updateProduct sends correct mutation with gid-wrapped id', async () => {
    mockFetch.mockResolvedValueOnce(
      makeGraphQLResponse({
        productUpdate: {
          product: {
            id: 'gid://shopify/Product/789',
            title: 'Updated',
            handle: 'updated',
            status: 'ACTIVE',
          },
          userErrors: [],
        },
      }),
    );

    const result = await adapter.updateProduct('789', { title: 'Updated' });
    expect(result.id).toBe('789');
    expect(result.title).toBe('Updated');

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { variables: { input: { id: string } } };
    expect(body.variables.input.id).toBe('gid://shopify/Product/789');
  });

  it('deleteProduct calls productDelete mutation', async () => {
    mockFetch.mockResolvedValueOnce(
      makeGraphQLResponse({
        productDelete: {
          deletedProductId: 'gid://shopify/Product/111',
          userErrors: [],
        },
      }),
    );
    await expect(adapter.deleteProduct('111')).resolves.toBeUndefined();
  });

  it('testConnection returns ok=true on success', async () => {
    mockFetch.mockResolvedValueOnce(
      makeGraphQLResponse({ shop: { name: 'My Store' } }),
    );
    const result = await adapter.testConnection();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('My Store');
  });

  it('retries on 429 with exponential backoff and eventually succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('throttled', { status: 429 }))
      .mockResolvedValueOnce(new Response('throttled', { status: 429 }))
      .mockResolvedValueOnce(makeGraphQLResponse({ shop: { name: 'Store' } }));

    const result = await adapter.testConnection();
    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('getProduct returns null when product not found', async () => {
    mockFetch.mockResolvedValueOnce(makeGraphQLResponse({ product: null }));
    const result = await adapter.getProduct('999');
    expect(result).toBeNull();
  });

  it('updates available budget from extensions.cost.throttleStatus', async () => {
    mockFetch.mockResolvedValueOnce(
      makeGraphQLResponse(
        { shop: { name: 'Store' } },
        {
          cost: {
            requestedQueryCost: 1,
            actualQueryCost: 1,
            throttleStatus: {
              currentlyAvailable: 950,
              maximumAvailable: 1000,
              restoreRate: 50,
            },
          },
        },
      ),
    );
    await adapter.testConnection();
    expect(adapter.currentBudget).toBe(950);
  });

  // ─── Fase G · publications + publishablePublish ─────────────────────────
  //
  // Prova que as duas mutations novas enviam as queries/inputs certos.
  // Sem esses, produtos criados via Admin API ficam ACTIVE no admin mas
  // invisíveis na loja virtual (canal Online Store não recebe publish).

  it('listPublications envia a query publications e retorna id+name', async () => {
    mockFetch.mockResolvedValueOnce(
      makeGraphQLResponse({
        publications: {
          edges: [
            { node: { id: 'gid://shopify/Publication/1', name: 'Online Store' } },
            { node: { id: 'gid://shopify/Publication/2', name: 'Point of Sale' } },
            { node: { id: 'gid://shopify/Publication/3', name: 'Shop' } },
          ],
        },
      }),
    );

    const pubs = await adapter.listPublications();
    expect(pubs).toEqual([
      { id: 'gid://shopify/Publication/1', name: 'Online Store' },
      { id: 'gid://shopify/Publication/2', name: 'Point of Sale' },
      { id: 'gid://shopify/Publication/3', name: 'Shop' },
    ]);

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { query: string };
    expect(body.query).toContain('publications');
  });

  it('publishToPublications envia publishablePublish com GIDs normalizados', async () => {
    mockFetch.mockResolvedValueOnce(
      makeGraphQLResponse({
        publishablePublish: {
          publishable: { publicationCount: 1 },
          shop: { publicationCount: 1 },
          userErrors: [],
        },
      }),
    );

    // Passamos id puro (sem gid://) — o adapter normaliza para GID.
    const result = await adapter.publishToPublications('123', ['gid://shopify/Publication/1']);
    expect(result.ok).toBe(true);
    expect(result.publishedTo).toEqual(['gid://shopify/Publication/1']);
    expect(result.errors).toEqual([]);

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { query: string; variables: { id: string; input: Array<{ publicationId: string }> } };
    expect(body.query).toContain('publishablePublish');
    // productId puro veio normalizado para GID
    expect(body.variables.id).toBe('gid://shopify/Product/123');
    // publicationId já veio como GID e permanece igual
    expect(body.variables.input).toEqual([{ publicationId: 'gid://shopify/Publication/1' }]);
  });

  it('publishToPublications retorna ok=false com errors quando userErrors presentes', async () => {
    mockFetch.mockResolvedValueOnce(
      makeGraphQLResponse({
        publishablePublish: {
          publishable: null,
          shop: null,
          userErrors: [{ field: null, code: 'ACCESS_DENIED', message: 'Publication not accessible' }],
        },
      }),
    );

    const result = await adapter.publishToPublications('123', ['gid://shopify/Publication/9']);
    expect(result.ok).toBe(false);
    expect(result.publishedTo).toEqual([]);
    // UserError não tem `code` (2025-10): o prefixo é o `field` ou 'ERR'.
    expect(result.errors).toEqual(['ERR: Publication not accessible']);
  });

  it('publishToPublications early-return ok quando input vazio (sem chamada de rede)', async () => {
    const result = await adapter.publishToPublications('123', []);
    expect(result).toEqual({ ok: true, publishedTo: [], errors: [] });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
