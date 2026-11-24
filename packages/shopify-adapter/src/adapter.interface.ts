export interface ShopifyVariantInput {
  title: string;
  price: string;
  // "Compare at" price (preço riscado). Usado para exibir desconto na loja.
  // Deve ser >= price. Quando omitido ou vazio, a Shopify remove o compare_at.
  compareAtPrice?: string;
  sku?: string;
  // option values in order matching the product's options array
  optionValues?: string[];
  // Fase H · política de inventário. 'CONTINUE' = continua vendendo mesmo
  // com estoque zerado (mapeia products.sell_without_stock=true no BS).
  // 'DENY' = default do Shopify (não vende sem estoque). Quando omitido,
  // o adapter não envia o campo e a Shopify mantém o default (DENY).
  inventoryPolicy?: 'CONTINUE' | 'DENY';
  // Ligação variante → imagem (jul/2026). Quando presente, o adapter tenta
  // casar esta variante à mídia da Shopify que tem o MESMO src que a imagem
  // do BlackShop com colorValue igual ao da variante. Ausente = variante
  // sem imagem específica (comportamento pré-M preservado).
  //
  // Como o worker resolve: no publish.processor, para cada variante busca a
  // primeira image_url com colorValue matching a cor da variante (option cor).
  // Passa via este campo para o adapter fazer o join com mediaId.
  imageUrl?: string;
  // Story 18.3b · vínculo com a variante da Shopify (`product_variants.mirror_variant_id`, com ou
  // sem `gid://`). Só importa na republicação (`existingProductGid`): campo AUSENTE em todas as
  // variantes = chamador que não conhece o vínculo (LandingLab, mock) → caminho antigo, posicional.
  // Presente (mesmo `null`) em pelo menos uma → o adapter casa por vínculo, depois por opções, cria as
  // novas e remove as órfãs (`null` = variante ainda sem espelho).
  mirrorVariantId?: string | null;
}

export interface ShopifyImageInput {
  src: string;
}

export interface ShopifyProductPayload {
  title: string;
  description_html?: string;
  vendor?: string;
  product_type?: string;
  tags?: string;
  variants?: ShopifyVariantInput[];
  images?: ShopifyImageInput[];
  // option names in order (e.g. ["Color", "Size"]) — required when variants have optionValues
  optionNames?: string[];
  // When set, Step 1 (productCreate) is skipped and the existing product is used for retry.
  // The adapter reads the remote state to determine which steps remain incomplete.
  existingProductGid?: string;
  // Called immediately after Step 1 (productCreate) succeeds, before Steps 2-4.
  // Use this to persist the shell product ID so retries are idempotent even if Steps 2-4 fail.
  onShellCreated?: (productId: string) => Promise<void>;
  // Story 18.3 (QA REQ-001) · marcador estável de reconciliação (ex.: `bs-product-<productId>`).
  // Primeira tentativa: vai como tag JÁ no productCreate (achável por findProductByTag se a
  // resposta se perder) e é removido logo depois que onShellCreated persiste o id — antes de
  // publicar nos canais. Retry (existingProductGid): só é removido (best effort).
  reconcileTag?: string;
}

export interface ShopifyProductResponse {
  id: string;
  title: string;
  handle: string;
  status: string;
  // IDs reais das variantes — populado pelo RealShopifyAdapter (Story 9.1).
  // Optional para não quebrar o MockShopifyAdapter.
  variantIds?: string[];
  // Story 18.3 (QA MNT-002) · resultado da remoção do marcador de reconciliação (só quando o
  // payload tinha reconcileTag). false = a tag ficou no produto; o publish tenta de novo.
  reconcileTagRemoved?: boolean;
}

export interface ConnectionStatus {
  ok: boolean;
  message: string;
}

// Bloco 3 · registro de webhooks Shopify via Admin API — o sistema
// verifica e registra sem o dono manusear credenciais.
export interface ShopifyWebhookSubscription {
  id: string;
  topic: string;
  callbackUrl: string;
  format: 'JSON' | 'XML';
}

// Fase 2 Bloco 3.1 · Multi-currency via PriceList (Shopify Payments nativo).
// Uma PriceList por moeda (EUR/USD/BRL) associada a um Catalog do Market
// correspondente. O sistema descobre os IDs via listPriceLists() no primeiro
// sync e empurra preço fixo por variante via setFixedPrices().
export interface ShopifyPriceList {
  id: string;
  name: string | null;
  currencyCode: string;
}

export interface ShopifyFixedPriceInput {
  // GID completo (`gid://shopify/ProductVariant/N`) OU id puro — a
  // implementação normaliza para GID antes de enviar.
  variantId: string;
  amount: string; // ex.: "47.00" — string para preservar precisão.
  currencyCode: string; // ex.: 'EUR'; DEVE bater com a moeda da PriceList.
}

export interface ShopifyFixedPricesResult {
  ok: boolean;
  errors: string[]; // vazio quando ok=true. Mensagens crus para log.
}

// Publications são os canais de venda da Shopify (Online Store, POS,
// Google, Shop, Facebook, etc.). Produto criado via Admin API fica ACTIVE
// no admin mas NÃO publicado em canal nenhum por default — precisa da
// mutation publishablePublish. Sintoma do bug histórico: produto some da
// loja mesmo com status=ACTIVE.
export interface ShopifyPublication {
  // GID no formato gid://shopify/Publication/N
  id: string;
  // Nome legível ("Online Store", "Shop", "Point of Sale", …). O
  // processor filtra por nome para achar o Online Store.
  name: string;
}

export interface ShopifyPublishResult {
  ok: boolean;
  // publicationIds efetivamente publicados (subset do input quando algum
  // já estava publicado — Shopify aceita re-publish silenciosamente).
  publishedTo: string[];
  errors: string[]; // vazio quando ok=true.
}

export interface ShopifyAdapter {
  createProduct(payload: ShopifyProductPayload): Promise<ShopifyProductResponse>;
  updateProduct(id: string, payload: Partial<ShopifyProductPayload>): Promise<ShopifyProductResponse>;
  deleteProduct(id: string): Promise<void>;
  getProduct(id: string): Promise<ShopifyProductResponse | null>;
  testConnection(): Promise<ConnectionStatus>;
  // Bloco 3 · lista webhooks já registrados na Shopify (todos os topics).
  listWebhooks(): Promise<ShopifyWebhookSubscription[]>;
  // Bloco 3 · registra um webhook idempotentemente. Se já existe uma
  // subscription para (topic, callbackUrl), retorna a existente sem
  // duplicar. Topic no formato Shopify — ex.: 'ORDERS_PAID'.
  registerWebhook(topic: string, callbackUrl: string): Promise<ShopifyWebhookSubscription>;
  // Fase 2 Bloco 3.1 · lista PriceLists ativas na Shopify (descoberta
  // automática de IDs por moeda no primeiro sync).
  listPriceLists(): Promise<ShopifyPriceList[]>;
  // Fase 2 Bloco 3.1 · cadastra preço fixo por variante numa PriceList.
  // Idempotente pela Shopify (mesma variantId sobrescreve).
  setFixedPrices(
    priceListId: string,
    prices: ShopifyFixedPriceInput[],
  ): Promise<ShopifyFixedPricesResult>;

  // Fase G · lista publications (canais de venda) da store. Usado uma vez
  // pelo publish processor para descobrir o ID do Online Store e cachear.
  listPublications(): Promise<ShopifyPublication[]>;

  // Fase G · publica um produto nos canais informados via publishablePublish.
  // Idempotente (Shopify aceita re-publish sem erro). Aceita GID completo
  // ou id puro do produto; retorna quais publications aceitaram.
  publishToPublications(
    productId: string,
    publicationIds: string[],
  ): Promise<ShopifyPublishResult>;

  // Jul/2026 · Lista variantes ATUAIS de um produto na Shopify (id + opções).
  // Usado pelo rewire-mirror-variants pra corrigir mismatch de mirror_variant_id
  // causado por productVariantsBulkCreate não garantir ordem de retorno.
  // Retorna [] se produto não existe.
  listProductVariants(productId: string): Promise<ShopifyVariantSnapshot[]>;

  // Jul/2026 · Lista mídias (imagens) de um produto e devolve map
  // sourceUrl → mediaId. Usado pelo rewire-variant-media pra saber qual
  // mediaId corresponde a cada URL de imagem gravada no BlackShop.
  // Retorna Map vazio se produto não existe ou não tem mídias.
  listProductMediaMap(productId: string): Promise<Map<string, string>>;

  // Jul/2026 · Liga variantes a mídias em batch. Cada par informa qual
  // mediaId (GID) fica associado a qual variantId (numérico ou GID).
  // Idempotente na Shopify — mesma variante+mediaId sobrescreve.
  linkVariantsToMedia(
    productId: string,
    pairs: Array<{ variantId: string; mediaId: string }>,
  ): Promise<{ ok: boolean; linked: number; errors: string[] }>;

  // Story 18.3 · reconciliação do resultado incerto (F1 da 0.4/0.8): produtos da loja com uma
  // variante de SKU EXATAMENTE igual ao informado (ex.: BS-a3f9c1-001). Consulta (idempotente e
  // retentável pelo cliente HTTP da 18.2). Devolve 0, 1 ou N produtos distintos — quem chama
  // decide (0 → criar; 1 → reaproveitar; N → humano).
  findProductByVariantSku(sku: string): Promise<ShopifyProductMatch[]>;

  // Story 18.3 (QA REQ-001) · produtos com a tag EXATA informada (o marcador gravado no
  // productCreate). Consulta (idempotente). 0, 1 ou N produtos distintos.
  findProductByTag(tag: string): Promise<ShopifyProductMatch[]>;

  // Story 18.3 (QA MNT-002) · remove uma tag do produto (best effort; nunca lança).
  // true = removida (ou já não estava); false = falhou (logado com loja.reconcile_tag_not_removed).
  removeProductTag(productId: string, tag: string): Promise<boolean>;
}

// Story 18.3 · produto achado pela busca por SKU. `productId` sem `gid://` (mesmo formato do
// products.mirror_product_id).
export interface ShopifyProductMatch {
  productId: string;
  handle: string;
}

// Jul/2026 · snapshot mínimo de uma variante Shopify pra fazer matching
// por opções (não por ordem). SelectedOptions vem como pares {name, value},
// ex.: [{name:"Color", value:"Beige"}, {name:"Size", value:"M"}].
export interface ShopifyVariantSnapshot {
  id: string;                          // ID numérico stripado (sem gid://)
  selectedOptions: Array<{ name: string; value: string }>;
}
