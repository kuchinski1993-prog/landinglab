import { randomUUID } from 'node:crypto';

import type {
  ConnectionStatus,
  ShopifyAdapter,
  ShopifyFixedPriceInput,
  ShopifyFixedPricesResult,
  ShopifyPriceList,
  ShopifyProductMatch,
  ShopifyProductPayload,
  ShopifyProductResponse,
  ShopifyPublication,
  ShopifyPublishResult,
  ShopifyVariantSnapshot,
  ShopifyWebhookSubscription,
} from './adapter.interface.js';

const MOCK_DELAY_MS = 200;

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, MOCK_DELAY_MS));
}

export class MockShopifyAdapter implements ShopifyAdapter {
  // Bloco 3 · estado em memória para simular idempotência do registro.
  // Reset por instância — cada teste cria seu adapter.
  private webhooks: ShopifyWebhookSubscription[] = [];

  // Fase 2 Bloco 3.1 · PriceLists simuladas — uma por moeda-alvo. IDs
  // determinísticos ('mock-pl-eur', 'mock-pl-usd', 'mock-pl-brl') pra
  // que testes verifiquem discovery sem depender de UUID.
  private priceLists: ShopifyPriceList[] = [
    { id: 'mock-pl-eur', name: 'Europe (mock)', currencyCode: 'EUR' },
    { id: 'mock-pl-usd', name: 'US (mock)', currencyCode: 'USD' },
    { id: 'mock-pl-brl', name: 'Brazil (mock)', currencyCode: 'BRL' },
  ];

  // Preços fixos persistidos por PriceList — permite testes assertarem
  // que setFixedPrices foi chamado e com quais valores.
  private fixedPrices: Map<string, ShopifyFixedPriceInput[]> = new Map();

  async createProduct(payload: ShopifyProductPayload): Promise<ShopifyProductResponse> {
    await delay();
    const id = `mock_${randomUUID()}`;
    console.info('[MockShopifyAdapter] createProduct', { id, title: payload.title });
    return { id, title: payload.title, handle: payload.title.toLowerCase().replace(/\s+/g, '-'), status: 'active' };
  }

  async updateProduct(id: string, payload: Partial<ShopifyProductPayload>): Promise<ShopifyProductResponse> {
    await delay();
    console.info('[MockShopifyAdapter] updateProduct', { id, title: payload.title });
    return { id, title: payload.title ?? 'updated', handle: 'updated', status: 'active' };
  }

  async deleteProduct(id: string): Promise<void> {
    await delay();
    console.info('[MockShopifyAdapter] deleteProduct', { id });
  }

  async getProduct(id: string): Promise<ShopifyProductResponse | null> {
    await delay();
    console.info('[MockShopifyAdapter] getProduct', { id });
    return { id, title: 'Mock Product', handle: 'mock-product', status: 'active' };
  }

  async testConnection(): Promise<ConnectionStatus> {
    await delay();
    return { ok: true, message: 'Mock connection OK' };
  }

  // Bloco 3 · lista webhooks registrados neste mock (in-memory).
  async listWebhooks(): Promise<ShopifyWebhookSubscription[]> {
    await delay();
    return [...this.webhooks];
  }

  // Bloco 3 · registra idempotentemente. Chamada duas vezes com o mesmo
  // (topic, callbackUrl) devolve o mesmo id.
  async registerWebhook(topic: string, callbackUrl: string): Promise<ShopifyWebhookSubscription> {
    await delay();
    const existing = this.webhooks.find((w) => w.topic === topic && w.callbackUrl === callbackUrl);
    if (existing) {
      console.info('[MockShopifyAdapter] registerWebhook (dedup)', { topic, id: existing.id });
      return existing;
    }
    const created: ShopifyWebhookSubscription = {
      id: `mock_${randomUUID()}`,
      topic,
      callbackUrl,
      format: 'JSON',
    };
    this.webhooks.push(created);
    console.info('[MockShopifyAdapter] registerWebhook (new)', { topic, id: created.id });
    return created;
  }

  // Fase 2 Bloco 3.1 · devolve as PriceLists simuladas (uma por moeda).
  async listPriceLists(): Promise<ShopifyPriceList[]> {
    await delay();
    return [...this.priceLists];
  }

  // Fase 2 Bloco 3.1 · simula sucesso — sobrescreve o array pra aquela
  // PriceList (mesma semântica da mutation real, que sobrescreve por
  // variantId). Retorna erro só se priceListId desconhecido.
  async setFixedPrices(
    priceListId: string,
    prices: ShopifyFixedPriceInput[],
  ): Promise<ShopifyFixedPricesResult> {
    await delay();
    if (!priceListId) {
      return { ok: false, errors: ['priceListId is required'] };
    }
    const known = this.priceLists.some((pl) => pl.id === priceListId);
    if (!known) {
      return { ok: false, errors: [`unknown priceListId: ${priceListId}`] };
    }
    const current = this.fixedPrices.get(priceListId) ?? [];
    // Sobrescreve por variantId (mesma variante = mesmo comportamento
    // da mutation real).
    const nextById = new Map(current.map((p) => [p.variantId, p]));
    for (const p of prices) nextById.set(p.variantId, p);
    this.fixedPrices.set(priceListId, [...nextById.values()]);
    console.info('[MockShopifyAdapter] setFixedPrices', {
      priceListId,
      count: prices.length,
    });
    return { ok: true, errors: [] };
  }

  // Utilitário só para testes — inspeciona o que foi cadastrado numa
  // PriceList específica. Não é parte da interface ShopifyAdapter.
  _debugFixedPrices(priceListId: string): ShopifyFixedPriceInput[] {
    return [...(this.fixedPrices.get(priceListId) ?? [])];
  }

  // Fase G · publications simuladas — 3 canais (Online Store, Shop, POS)
  // com IDs determinísticos para testes assertarem discovery + publish.
  private publications: ShopifyPublication[] = [
    { id: 'gid://shopify/Publication/1', name: 'Online Store' },
    { id: 'gid://shopify/Publication/2', name: 'Shop' },
    { id: 'gid://shopify/Publication/3', name: 'Point of Sale' },
  ];

  // Registro de (productId, publicationId) publicados — permite testes
  // inspeccionarem via _debugPublished(productId).
  private published: Map<string, Set<string>> = new Map();

  async listPublications(): Promise<ShopifyPublication[]> {
    await delay();
    return [...this.publications];
  }

  async publishToPublications(
    productId: string,
    publicationIds: string[],
  ): Promise<ShopifyPublishResult> {
    await delay();
    if (publicationIds.length === 0) {
      return { ok: true, publishedTo: [], errors: [] };
    }
    const key = productId.startsWith('gid://shopify/Product/')
      ? productId
      : `gid://shopify/Product/${productId}`;
    const set = this.published.get(key) ?? new Set<string>();
    // Idempotência: publicar duas vezes o mesmo par não erra (comportamento
    // nativo da mutation real do Shopify).
    for (const p of publicationIds) set.add(p);
    this.published.set(key, set);
    console.info('[MockShopifyAdapter] publishToPublications', {
      productId: key,
      publicationIds,
    });
    return { ok: true, publishedTo: [...publicationIds], errors: [] };
  }

  _debugPublished(productId: string): string[] {
    const key = productId.startsWith('gid://shopify/Product/')
      ? productId
      : `gid://shopify/Product/${productId}`;
    return [...(this.published.get(key) ?? [])];
  }

  // Jul/2026 · Mock retorna [] — testes que precisam de dados específicos
  // usam adapter fake dedicado (nunca este mock).
  async listProductVariants(_productId: string): Promise<ShopifyVariantSnapshot[]> {
    return [];
  }

  // Story 18.3 · produtos "existentes" na loja simulada, por SKU (testes de reconciliação).
  private productsBySku: Map<string, ShopifyProductMatch[]> = new Map();

  seedProductBySku(sku: string, match: ShopifyProductMatch): void {
    this.productsBySku.set(sku, [...(this.productsBySku.get(sku) ?? []), match]);
  }

  async findProductByVariantSku(sku: string): Promise<ShopifyProductMatch[]> {
    return [...(this.productsBySku.get(sku) ?? [])];
  }

  // Story 18.3 (QA REQ-001) · produtos "existentes" por tag de reconciliação.
  private productsByTag: Map<string, ShopifyProductMatch[]> = new Map();

  seedProductByTag(tag: string, match: ShopifyProductMatch): void {
    this.productsByTag.set(tag, [...(this.productsByTag.get(tag) ?? []), match]);
  }

  async findProductByTag(tag: string): Promise<ShopifyProductMatch[]> {
    return [...(this.productsByTag.get(tag) ?? [])];
  }

  async removeProductTag(_productId: string, _tag: string): Promise<boolean> {
    return true;
  }

  async listProductMediaMap(_productId: string): Promise<Map<string, string>> {
    return new Map();
  }

  async linkVariantsToMedia(
    _productId: string,
    pairs: Array<{ variantId: string; mediaId: string }>,
  ): Promise<{ ok: boolean; linked: number; errors: string[] }> {
    return { ok: true, linked: pairs.length, errors: [] };
  }
}
