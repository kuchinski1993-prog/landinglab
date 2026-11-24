import {
  UpstreamRateLimitedError,
  UpstreamUnavailableError,
  createHttpClient,
  parseRetryAfterMs,
  timeoutFromEnv,
  type HttpClient,
} from '@blackshop/shared/http';

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
  ShopifyVariantInput,
  ShopifyVariantSnapshot,
  ShopifyWebhookSubscription,
} from './adapter.interface.js';
import {
  payloadKnowsMirror,
  planVariantSync,
  type RemoteVariantState,
  type VariantSyncPlan,
} from './variant-sync-plan.js';

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: ThrottleExtension;
}

interface ThrottleExtension {
  cost?: {
    requestedQueryCost: number;
    actualQueryCost: number;
    throttleStatus: {
      currentlyAvailable: number;
      maximumAvailable: number;
      restoreRate: number;
    };
  };
}

// Shopify Admin API GraphQL — budget=1000pts, restoreRate=50/s (Basic plan).
// 429/503 + THROTTLED extension code → exponential backoff (cap MAX_RETRIES).
const DEFAULT_THROTTLE_DELAY_MS = 1000;
const MAX_RETRIES = 3;
// Story 0.8: prazo por tentativa (cabeçalhos + corpo) e teto da espera pedida pelo
// Retry-After. Sobrescrevível por SHOPIFY_ADMIN_TIMEOUT_MS.
export const SHOPIFY_ADMIN_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_MS = 60_000;
const ADMIN_LABEL = 'shopify-admin';
// Story 18.3 (QA MNT-002) · código estável no log quando o marcador de reconciliação não sai.
export const RECONCILE_TAG_NOT_REMOVED = 'loja.reconcile_tag_not_removed';

export interface RealShopifyAdapterOptions {
  apiVersion?: string;
  throttleDelayMs?: number; // override for tests
  /** Prazo por tentativa (default SHOPIFY_ADMIN_TIMEOUT_MS ou 15 s). */
  timeoutMs?: number;
  /**
   * Story 18.3b · na republicação com vínculo, remove da Shopify as variantes órfãs (apagadas no
   * BlackShop). Default REMOVE_ORPHAN_VARIANTS. `false` = só avisa no log (`warn`) com os ids.
   */
  removeOrphans?: boolean;
}

// Story 18.3b · D1 (decisão padrão, owner pode reverter): a Shopify é o espelho — variante apagada no
// BlackShop sai da Shopify na republicação. Reverter = trocar para `false` (só avisa no log).
export const REMOVE_ORPHAN_VARIANTS = true;

/** Mutations podem ter sido aplicadas mesmo sem resposta — timeout delas é "incerto". */
function isMutation(query: string): boolean {
  return /^\s*mutation\b/.test(query);
}

export class RealShopifyAdapter implements ShopifyAdapter {
  private readonly adminToken: string;
  private readonly storeDomain: string;
  private readonly apiVersion: string;
  private readonly throttleDelayMs: number;
  private readonly timeoutMs: number;
  private readonly http: HttpClient;
  private readonly removeOrphans: boolean;
  private availableBudget = 1000;

  constructor(adminToken: string, storeDomain: string, options: RealShopifyAdapterOptions = {}) {
    if (!adminToken) throw new Error('RealShopifyAdapter: adminToken is required');
    if (!storeDomain) throw new Error('RealShopifyAdapter: storeDomain is required');
    this.adminToken = adminToken;
    this.storeDomain = storeDomain;
    this.apiVersion = options.apiVersion ?? '2025-10';
    this.throttleDelayMs = options.throttleDelayMs ?? DEFAULT_THROTTLE_DELAY_MS;
    this.timeoutMs = options.timeoutMs ?? timeoutFromEnv('SHOPIFY_ADMIN_TIMEOUT_MS', SHOPIFY_ADMIN_TIMEOUT_MS);
    this.removeOrphans = options.removeOrphans ?? REMOVE_ORPHAN_VARIANTS;
    // Story 18.2: transporte via cliente compartilhado com os MESMOS limites da 0.8 — 1 + MAX_RETRIES
    // tentativas, backoff throttleDelayMs·2^n sem jitter, espera max(backoff, Retry-After) até 60 s;
    // só 429/503 são repetidos. Query é idempotente (timeout/503 repetidos); mutation não: timeout
    // ou 503 de mutation saem `uncertain` numa tentativa só (nunca reenviada às cegas). 429 sempre
    // pode ser repetido (não foi processado). O THROTTLED do corpo GraphQL continua aqui (aplicação).
    this.http = createHttpClient({
      label: ADMIN_LABEL,
      timeoutMs: this.timeoutMs,
      httpErrors: 'return',
      retry: {
        attempts: MAX_RETRIES + 1,
        baseDelayMs: this.throttleDelayMs,
        maxDelayMs: Number.MAX_SAFE_INTEGER,
        maxRetryAfterMs: MAX_RETRY_AFTER_MS,
        maxTotalMs: Number.POSITIVE_INFINITY,
        jitter: 'none',
        isRetryableStatus: (status) => status === 503,
      },
      // Resolvido a cada espera (os testes substituem `adapter.sleep`).
      sleep: (ms) => this.sleep(ms),
    });
  }

  get currentBudget(): number {
    return this.availableBudget;
  }

  private get endpoint(): string {
    return `https://${this.storeDomain}/admin/api/${this.apiVersion}/graphql.json`;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async graphql<T>(
    query: string,
    variables?: Record<string, unknown>,
    retries = 0,
  ): Promise<T> {
    const mutation = isMutation(query);
    const { response: res, attempts } = await this.http.request(
      this.endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': this.adminToken,
        },
        body: JSON.stringify({ query, variables }),
      },
      { idempotent: !mutation },
    );

    // 429 esgotado → UpstreamRateLimitedError (contrato da 0.8). 503: query esgotou as tentativas
    // (mensagem de sempre); mutation não foi repetida → resultado incerto.
    if (res.status === 429) {
      throw new UpstreamRateLimitedError(ADMIN_LABEL, parseRetryAfterMs(res.headers.get('Retry-After')), attempts);
    }
    if (res.status === 503) {
      throw new UpstreamUnavailableError({
        label: ADMIN_LABEL,
        status: 503,
        attempts,
        kind: mutation ? 'uncertain' : 'transient',
        ...(mutation ? {} : { message: `Shopify Admin API throttled: max retries exceeded (${MAX_RETRIES})` }),
      });
    }

    // Captura versão real que a Shopify processou — útil pra diagnosticar
    // "requested 2026-07 mas Shopify devolveu 2026-04" (loja em versão antiga).
    const actualApiVersion = res.headers.get('X-Shopify-API-Version') ?? 'unknown';
    if (this.apiVersion !== actualApiVersion && actualApiVersion !== 'unknown') {
      console.warn('[shopify-adapter] API version mismatch', {
        requestedApiVersion: this.apiVersion,
        actualApiVersion,
        store: this.storeDomain,
        status: res.status,
      });
    }

    // Detecta deprecações em runtime — Shopify envia este header quando o request
    // usa campos/mutations marcados como deprecated (ex: ProductInput, callbackUrl).
    const deprecatedReason = res.headers.get('X-Shopify-API-Deprecated-Reason');
    if (deprecatedReason) {
      console.warn('[shopify-adapter] DEPRECATION WARNING', {
        reason: deprecatedReason,
        requestedApiVersion: this.apiVersion,
        actualApiVersion,
        store: this.storeDomain,
      });
    }

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401) {
        console.error('[shopify-adapter] 401 UNAUTHORIZED', {
          store: this.storeDomain,
          requestedApiVersion: this.apiVersion,
          actualApiVersion,
          // Nunca loga o token completo — só prefix de 10 chars pra rastrear rotação
          tokenPrefix: this.adminToken?.slice(0, 10) ?? 'missing',
          responseSnippet: text.slice(0, 200),
          fix: 'usar vault.getAdminToken() ao invés de vault.getRaw(shopify.admin_api_token)',
        });
        throw new Error(
          `Shopify Admin API 401 UNAUTHORIZED. ` +
            `store=${this.storeDomain} apiVersion=${this.apiVersion}→${actualApiVersion}. ` +
            `Response: ${text.slice(0, 200)}`,
        );
      }
      throw new Error(`Shopify Admin API error ${res.status} (${actualApiVersion}): ${text}`);
    }

    const json = (await res.json()) as GraphQLResponse<T>;

    if (json.extensions?.cost?.throttleStatus) {
      this.availableBudget = json.extensions.cost.throttleStatus.currentlyAvailable;
    }

    // GraphQL-level throttle.
    if (json.errors?.some((e) => e.extensions?.code === 'THROTTLED')) {
      if (retries >= MAX_RETRIES) {
        throw new Error('Shopify Admin API query throttled: max retries exceeded');
      }
      const delay = this.throttleDelayMs * Math.pow(2, retries);
      await this.sleep(delay);
      return this.graphql<T>(query, variables, retries + 1);
    }

    if (json.errors?.length) {
      throw new Error(`Shopify GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
    }

    if (json.data === undefined) {
      throw new Error('Shopify GraphQL response missing data');
    }

    return json.data;
  }

  // ── Remote state read for idempotent retry ─────────────────────────────────
  // Reads the current state of an existing Shopify product so createProduct can
  // skip steps that already completed in a previous (failed) attempt.
  private async getRemoteProductState(productGid: string): Promise<{
    title: string;
    handle: string;
    status: string;
    defaultVariantGid: string | null;
    existingOptionCount: number;
    existingVariantCount: number;
    existingVariantIds: string[];
    /** Story 18.3b · id + valores das opções de cada variante (para o plano por vínculo/opções). */
    existingVariants: RemoteVariantState[];
    /** Story 18.3b · `variants(first: 100)` não trouxe tudo. Campo ausente = 1 página. */
    hasMoreVariants: boolean;
    existingMediaCount: number;
  }> {
    interface StateResult {
      product: {
        id: string;
        title: string;
        handle: string;
        status: string;
        options: Array<{ id: string; name: string }>;
        variants: {
          edges: Array<{ node: { id: string; sku?: string | null; selectedOptions?: Array<{ name: string; value: string }> } }>;
          pageInfo?: { hasNextPage?: boolean };
        };
        media: { edges: Array<{ node: { id?: string } }> };
      } | null;
    }

    const data = await this.graphql<StateResult>(
      `query getProductState($id: ID!) {
        product(id: $id) {
          id title handle status
          options { id name }
          variants(first: 100) { edges { node { id sku selectedOptions { name value } } } pageInfo { hasNextPage } }
          media(first: 1) { edges { node { id } } }
        }
      }`,
      { id: productGid },
    );

    if (!data.product) throw new Error(`Shopify product not found for retry: ${productGid}`);

    const variantEdges = data.product.variants.edges;
    return {
      title: data.product.title,
      handle: data.product.handle,
      status: data.product.status,
      defaultVariantGid: variantEdges[0]?.node.id ?? null,
      existingOptionCount: data.product.options.length,
      existingVariantCount: variantEdges.length,
      existingVariantIds: variantEdges.map((e) => stripGid(e.node.id, 'ProductVariant')),
      existingVariants: variantEdges.map((e) => ({
        id: stripGid(e.node.id, 'ProductVariant'),
        options: (e.node.selectedOptions ?? []).map((o) => o.value),
        sku: e.node.sku ?? null,
      })),
      hasMoreVariants: data.product.variants.pageInfo?.hasNextPage === true,
      existingMediaCount: data.product.media.edges.length,
    };
  }

  // Derive distinct option values per dimension from the variant list.
  // optionValues[0] = distinct values of option dimension 0 (matching optionNames[0]), etc.
  // Order preserves first-seen insertion order so Shopify shows values in a predictable sequence.
  private static extractOptionValues(variants: ShopifyVariantInput[], optionCount: number): string[][] {
    const result: string[][] = Array.from({ length: optionCount }, () => []);
    for (const v of variants) {
      const vals = v.optionValues ?? [];
      for (let i = 0; i < optionCount; i++) {
        const val = vals[i];
        if (val && !result[i]!.includes(val)) result[i]!.push(val);
      }
    }
    return result;
  }

  async createProduct(payload: ShopifyProductPayload): Promise<ShopifyProductResponse> {
    const variants = payload.variants ?? [];
    const optionNames = payload.optionNames ?? [];
    const hasMultipleVariants = variants.length > 1 && optionNames.length > 0;
    const isRetry = Boolean(payload.existingProductGid);

    let productGid: string;
    let productId: string;
    let productTitle: string;
    let productHandle: string;
    let productStatus: string;
    let defaultVariantGid: string | null;
    let variantIds: string[];
    let reconcileTagRemoved: boolean | undefined;

    // ── Step 1: productCreate OR restore existing product on retry ────────────
    if (isRetry && payload.existingProductGid) {
      // On retry: read remote state to determine which steps are already complete.
      productGid = payload.existingProductGid.startsWith('gid://')
        ? payload.existingProductGid
        : `gid://shopify/Product/${payload.existingProductGid}`;

      console.info('[ShopifyAdapter] step 1/4 — retry mode, reading remote state', { productGid });

      const remoteState = await this.getRemoteProductState(productGid);
      productId = stripGid(productGid, 'Product');

      // Story 18.3b · chamador que conhece o vínculo (worker): o PLANO de variantes é calculado aqui,
      // logo depois da leitura e ANTES de qualquer escrita (tag, productUpdate, opções, variantes).
      // Plano recusado → lança ShopifyVariantPlanError sem nenhuma mutação. Sem o campo em nenhuma
      // variante (LandingLab, mock) → plano nulo e o passo 3 segue o caminho antigo, posicional.
      let variantPlan: VariantSyncPlan | null = null;
      if (variants.length > 0 && payloadKnowsMirror(variants)) {
        // Shell sem opções: o productOptionsCreate do passo 2 dá à variante padrão os PRIMEIROS valores
        // de cada opção — o plano olha o estado como ficará depois dele.
        const willCreateOptions = hasMultipleVariants && remoteState.existingOptionCount < optionNames.length;
        const remoteForPlan =
          willCreateOptions && remoteState.existingVariants.length === 1
            ? [{
                id: remoteState.existingVariants[0]!.id,
                sku: remoteState.existingVariants[0]!.sku ?? null,
                options: RealShopifyAdapter.extractOptionValues(variants, optionNames.length).map((vals) => vals[0] ?? ''),
              }]
            : remoteState.existingVariants;
        variantPlan = planVariantSync(remoteForPlan, variants, {
          remoteHasNextPage: remoteState.hasMoreVariants,
          // QA 18.3b · só apaga órfã do BlackShop (SKU da família do payload); criada à mão → recusa.
          refuseForeignOrphans: this.removeOrphans,
        });
        console.info('[ShopifyAdapter] step 3/4 — variant plan', {
          productId,
          update: variantPlan.update.length,
          create: variantPlan.create.length,
          remove: variantPlan.remove.length,
        });
      }

      // Shell achado pela reconciliação: tira o marcador antes de publicar (best effort).
      if (payload.reconcileTag) reconcileTagRemoved = await this.removeReconcileTag(productGid, payload.reconcileTag);
      productTitle = remoteState.title;
      productHandle = remoteState.handle;
      productStatus = remoteState.status;
      defaultVariantGid = remoteState.defaultVariantGid;
      variantIds = remoteState.existingVariantIds;

      console.info('[ShopifyAdapter] step 1/4 — remote state read', {
        productId,
        existingOptions: remoteState.existingOptionCount,
        existingVariants: remoteState.existingVariantCount,
        existingMedia: remoteState.existingMediaCount,
        expectedVariants: variants.length,
        expectedOptions: optionNames.length,
      });

      // Step 1b (retry) · sincroniza metadata do produto: title, descriptionHtml,
      // vendor, productType. Antes o retry pulava esta etapa, deixando Shopify
      // com título/descrição antigos quando o dono editava no BlackShop
      // (reportado após tradução completa PT→EN — nomes ficaram desatualizados
      // no admin da Shopify e no checkout).
      try {
        interface UpdateResult {
          productUpdate: {
            product: { id: string; title: string; handle: string } | null;
            userErrors: Array<{ field: string[]; message: string }>;
          };
        }
        const updateInput: Record<string, unknown> = {
          id: productGid,
          title: payload.title,
          descriptionHtml: payload.description_html ?? '',
          vendor: payload.vendor ?? '',
          productType: payload.product_type ?? '',
        };
        const updateData = await this.graphql<UpdateResult>(
          `mutation productUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
              product { id title handle }
              userErrors { field message }
            }
          }`,
          { input: updateInput },
        );
        if (updateData.productUpdate.userErrors.length > 0) {
          const msg = updateData.productUpdate.userErrors.map((e) => e.message).join('; ');
          console.warn('[ShopifyAdapter] step 1b/4 — productUpdate userErrors (continuando)', { productId, errors: msg });
        } else if (updateData.productUpdate.product) {
          productTitle = updateData.productUpdate.product.title;
          productHandle = updateData.productUpdate.product.handle;
          console.info('[ShopifyAdapter] step 1b/4 — productUpdate done', { productId, title: productTitle });
        }
      } catch (err) {
        // Não quebra o job — preços/variantes ainda podem sincronizar.
        console.warn('[ShopifyAdapter] step 1b/4 — productUpdate falhou (continuando com sync de variantes)', { productId, err: String(err) });
      }

      // ── Step 2 (retry): skip if options already present ──────────────────────
      if (hasMultipleVariants) {
        if (remoteState.existingOptionCount >= optionNames.length) {
          console.info('[ShopifyAdapter] step 2/4 — skipped (options already exist on retry)', {
            productId,
            existingOptionCount: remoteState.existingOptionCount,
          });
        } else {
          console.info('[ShopifyAdapter] step 2/4 — productOptionsCreate (retry, options missing)', {
            productId, optionNames,
          });
          const optionValues = RealShopifyAdapter.extractOptionValues(variants, optionNames.length);
          await this.execProductOptionsCreate(productGid, productId, optionNames, optionValues);
        }
      } else {
        console.info('[ShopifyAdapter] step 2/4 — skipped (single variant)');
      }

      // ── Step 3 (retry): variantes já existem → sincroniza PREÇOS ─────────────
      // Antes: pulava totalmente quando existingVariantCount >= variants.length,
      // deixando Shopify defasado quando o dono mudava preços em massa (bug
      // reportado após +20% de reajuste — os 90 produtos não recebiam o preço
      // novo mesmo após republish-all).
      // Agora: para produtos completos, chama productVariantsBulkUpdate com
      // apenas price + inventoryPolicy (sem tocar em optionValues, sku, media —
      // que já estão no lugar). Idempotente: preço igual = no-op na Shopify.
      if (variantPlan) {
        variantIds = await this.execVariantPlan(productGid, productId, variantPlan, variants, optionNames);
      } else if (variants.length > 0) {
        if (remoteState.existingVariantCount >= variants.length) {
          console.info('[ShopifyAdapter] step 3/4 — variants complete, syncing prices (retry)', {
            productId,
            existingVariantCount: remoteState.existingVariantCount,
            expectedVariantCount: variants.length,
          });
          await this.execBulkUpdateVariantPrices(
            productGid, productId, remoteState.existingVariantIds, variants,
          );
        } else if (hasMultipleVariants && defaultVariantGid) {
          // Partial: some variants exist, others don't — complete from where it stopped.
          const alreadyCreated = remoteState.existingVariantCount; // includes default
          const toCreate = variants.slice(alreadyCreated);
          const toUpdate = variants.slice(0, alreadyCreated);
          console.info('[ShopifyAdapter] step 3/4 — partial retry: creating missing variants + syncing prices', {
            productId,
            alreadyCreated,
            remaining: toCreate.length,
            priceSyncCount: toUpdate.length,
          });
          // Sincroniza preços dos JÁ existentes antes de criar os novos.
          if (toUpdate.length > 0) {
            await this.execBulkUpdateVariantPrices(
              productGid, productId, remoteState.existingVariantIds, toUpdate,
            );
          }
          const newIds = await this.execBulkCreateVariants(productGid, productId, toCreate, optionNames);
          variantIds = [...remoteState.existingVariantIds, ...newIds];
        } else if (!hasMultipleVariants && defaultVariantGid) {
          // Single-variant product whose variant update failed: retry the update.
          console.info('[ShopifyAdapter] step 3/4 — retry single variant update', { productId });
          const ids = await this.execSingleVariantUpdate(productGid, productId, defaultVariantGid, variants[0]!);
          variantIds = ids;
        }
      }

      // ── Step 4 (retry): skip if media already attached ───────────────────────
      // Step 5 (link variant→media) NÃO é executado no retry — presume que
      // a ligação já foi feita na primeira execução. Se dono precisar
      // ligar novamente, use o backfill dedicado (POST /admin/publish/relink-colors-all).
      if (payload.images && payload.images.length > 0) {
        if (remoteState.existingMediaCount > 0) {
          console.info('[ShopifyAdapter] step 4/5 — skipped (media already exists on retry)', {
            productId,
            existingMediaCount: remoteState.existingMediaCount,
          });
        } else {
          console.info('[ShopifyAdapter] step 4/5 — productCreateMedia (retry, media missing)', { productId });
          await this.execCreateMedia(productGid, productId, payload.images);
        }
      }

      return {
        id: productId,
        title: productTitle,
        handle: productHandle,
        status: productStatus.toLowerCase(),
        variantIds,
        ...(reconcileTagRemoved !== undefined && { reconcileTagRemoved }),
      };
    }

    // ── First attempt: normal flow ────────────────────────────────────────────
    console.info('[ShopifyAdapter] step 1/4 — productCreate start', {
      title: payload.title,
      variantCount: variants.length,
      hasOptions: hasMultipleVariants,
    });

    interface CreateResult {
      productCreate: {
        product: {
          id: string;
          title: string;
          handle: string;
          status: string;
          variants: { edges: Array<{ node: { id: string } }> };
        } | null;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }

    const shellInput: Record<string, unknown> = {
      title: payload.title,
      descriptionHtml: payload.description_html,
      vendor: payload.vendor ?? '',
      productType: payload.product_type ?? '',
      status: 'ACTIVE',
      // Story 18.3 (QA REQ-001): marcador de reconciliação já no shell — se a resposta do
      // productCreate se perder (timeout incerto), a republicação acha o produto pela tag.
      ...(payload.reconcileTag ? { tags: [payload.reconcileTag] } : {}),
    };

    const createData = await this.graphql<CreateResult>(
      `mutation productCreate($input: ProductInput!) {
        productCreate(input: $input) {
          product {
            id title handle status
            variants(first: 1) { edges { node { id } } }
          }
          userErrors { field message }
        }
      }`,
      { input: shellInput },
    );

    if (createData.productCreate.userErrors.length > 0) {
      const msg = createData.productCreate.userErrors.map((e) => e.message).join('; ');
      console.error('[ShopifyAdapter] step 1/4 — productCreate userErrors', { errors: msg });
      throw new Error(`Shopify productCreate userErrors: ${msg}`);
    }

    const p = createData.productCreate.product;
    if (!p) throw new Error('Shopify productCreate returned no product');

    productGid = p.id;
    productId = stripGid(productGid, 'Product');
    productTitle = p.title;
    productHandle = p.handle;
    productStatus = p.status;
    // Shopify auto-creates a "Default Title" variant — capture its GID for step 3 update.
    defaultVariantGid = p.variants.edges[0]?.node.id ?? null;
    variantIds = defaultVariantGid ? [stripGid(defaultVariantGid, 'ProductVariant')] : [];

    console.info('[ShopifyAdapter] step 1/4 — productCreate done', { productId, defaultVariantGid });

    // Notify caller that the shell product exists — before Steps 2-4 can fail.
    // This lets the publish processor persist mirrorProductId immediately so that
    // any retry detects the existing shell and completes rather than creating a duplicate.
    if (payload.onShellCreated) {
      await payload.onShellCreated(productId);
    }
    // O id já está persistido: o marcador não é mais necessário e sai antes de publicar.
    if (payload.reconcileTag) reconcileTagRemoved = await this.removeReconcileTag(productGid, payload.reconcileTag);

    // ── Step 2: productOptionsCreate — only for multi-variant products ────────
    if (hasMultipleVariants) {
      const optionValues = RealShopifyAdapter.extractOptionValues(variants, optionNames.length);
      await this.execProductOptionsCreate(productGid, productId, optionNames, optionValues);
    } else {
      console.info('[ShopifyAdapter] step 2/4 — skipped (single variant, no options needed)');
    }

    // ── Step 3: variants ──────────────────────────────────────────────────────
    if (variants.length > 0 && defaultVariantGid) {
      if (hasMultipleVariants) {
        // 3a: Update the auto-created "Default Title" variant → first real variant.
        const firstIds = await this.execDefaultVariantUpdate(
          productGid, productId, defaultVariantGid, variants[0]!, optionNames,
        );
        variantIds = firstIds;

        // 3b: Create remaining variants (index 1..N).
        const extraVariants = variants.slice(1);
        if (extraVariants.length > 0) {
          const extraIds = await this.execBulkCreateVariants(productGid, productId, extraVariants, optionNames);
          variantIds = [...variantIds, ...extraIds];
        }
      } else {
        variantIds = await this.execSingleVariantUpdate(productGid, productId, defaultVariantGid, variants[0]!);
      }
    } else {
      console.info('[ShopifyAdapter] step 3/4 — skipped (no variants in payload)');
    }

    // ── Step 4: productCreateMedia ────────────────────────────────────────────
    let srcToMediaId = new Map<string, string>();
    if (payload.images && payload.images.length > 0) {
      srcToMediaId = await this.execCreateMedia(productGid, productId, payload.images);
    } else {
      console.info('[ShopifyAdapter] step 4/5 — skipped (no images in payload)');
    }

    // ── Step 5: link variant → media (jul/2026 · matching por optionValues) ──
    // Bug histórico: assumia variantIds[i] === payload.variants[i]. Shopify
    // NÃO garante ordem no retorno de productVariantsBulkCreate → cada
    // variante recebia mediaId de OUTRA cor no checkout.
    //
    // Fix: buscamos snapshot atual das variantes (id + selectedOptions),
    // casamos por option values normalizados, e ligamos variantIds reais
    // com as imageUrls do payload (que já vêm no PAYLOAD com a option value
    // correta da cor).
    if (srcToMediaId.size > 0) {
      const snapshot = await this.listProductVariants(productGid);
      const normalize = (v: string | null | undefined): string =>
        v ? v.toLowerCase().replace(/[\s_-]+/g, '') : '';
      const shopifyByOptions = new Map<string, string>();
      for (const sv of snapshot) {
        const key = [0, 1, 2]
          .map((i) => normalize(sv.selectedOptions[i]?.value))
          .join('|');
        shopifyByOptions.set(key, sv.id);
      }

      const variantMediaPairs = (payload.variants ?? [])
        .map((v) => {
          if (!v.imageUrl) return null;
          const opts = (v.optionValues ?? []).map((val) => normalize(val));
          // Pad até 3 opções (a Shopify sempre preenche as 3, com "Default Title"
          // se não usadas — normalizado vira "defaulttitle").
          while (opts.length < 3) opts.push('');
          const key = opts.join('|');
          const variantId = shopifyByOptions.get(key);
          if (!variantId) return null;
          return { variantId, imageUrl: v.imageUrl };
        })
        .filter((p): p is { variantId: string; imageUrl: string } => p !== null);

      if (variantMediaPairs.length > 0) {
        await this.execLinkVariantsToMedia(productGid, productId, variantMediaPairs, srcToMediaId);
      } else {
        console.info('[ShopifyAdapter] step 5/5 — skipped (no variant→image pairs matched)', {
          productId,
          shopifyVariantCount: snapshot.length,
          mediaCreated: srcToMediaId.size,
        });
      }
    } else {
      console.info('[ShopifyAdapter] step 5/5 — skipped (no media created)', {
        productId,
        mediaCreated: srcToMediaId.size,
      });
    }

    return {
      id: productId,
      title: productTitle,
      handle: productHandle,
      status: productStatus.toLowerCase(),
      variantIds,
      ...(reconcileTagRemoved !== undefined && { reconcileTagRemoved }),
    };
  }

  // ── Private step helpers (extracted for reuse between first-run and retry) ──

  private async execProductOptionsCreate(
    productGid: string,
    productId: string,
    optionNames: string[],
    // Distinct values per option dimension, in the same order as optionNames.
    // Shopify 2024-01 requires at least one value per option — empty values[] is rejected.
    optionValues: string[][],
  ): Promise<void> {
    const options = optionNames.map((name, i) => ({
      name,
      values: (optionValues[i] ?? []).map((v) => ({ name: v })),
    }));

    console.info('[ShopifyAdapter] step 2/4 — productOptionsCreate start', {
      productId,
      options: options.map((o) => ({ name: o.name, valueCount: o.values.length })),
    });

    interface OptionsResult {
      productOptionsCreate: {
        product: { options: Array<{ id: string; name: string; position: number }> } | null;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }

    const optionsData = await this.graphql<OptionsResult>(
      `mutation productOptionsCreate($productId: ID!, $options: [OptionCreateInput!]!) {
        productOptionsCreate(productId: $productId, options: $options) {
          product { options { id name position } }
          userErrors { field message }
        }
      }`,
      { productId: productGid, options },
    );

    if (optionsData.productOptionsCreate.userErrors.length > 0) {
      const msg = optionsData.productOptionsCreate.userErrors.map((e) => e.message).join('; ');
      console.error('[ShopifyAdapter] step 2/4 — productOptionsCreate userErrors', { productId, errors: msg });
      throw new Error(`Product (id=${productId}) optionsCreate failed: ${msg}`);
    }
    console.info('[ShopifyAdapter] step 2/4 — productOptionsCreate done', { productId });
  }

  private async execDefaultVariantUpdate(
    productGid: string,
    productId: string,
    defaultVariantGid: string,
    variant: ShopifyVariantInput,
    optionNames: string[],
  ): Promise<string[]> {
    console.info('[ShopifyAdapter] step 3a/4 — update default variant', {
      productId, price: variant.price, optionValues: variant.optionValues,
    });

    interface BulkUpdateResult {
      productVariantsBulkUpdate: {
        productVariants: Array<{ id: string }>;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }

    const data = await this.graphql<BulkUpdateResult>(
      `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id }
          userErrors { field message }
        }
      }`,
      {
        productId: productGid,
        variants: [{
          id: defaultVariantGid,
          price: variant.price,
          ...(variant.compareAtPrice !== undefined && { compareAtPrice: variant.compareAtPrice || null }),
          inventoryItem: { sku: variant.sku ?? '' },
          // Fase H · sell_without_stock=true no BlackShop → CONTINUE aqui.
          // Omite quando não passado (mantém default da Shopify: DENY).
          ...(variant.inventoryPolicy ? { inventoryPolicy: variant.inventoryPolicy } : {}),
          optionValues: (variant.optionValues ?? []).map((value, idx) => ({
            optionName: optionNames[idx] ?? `Option${idx + 1}`,
            name: value,
          })),
        }],
      },
    );

    if (data.productVariantsBulkUpdate.userErrors.length > 0) {
      const msg = data.productVariantsBulkUpdate.userErrors.map((e) => e.message).join('; ');
      console.error('[ShopifyAdapter] step 3a/4 — update default variant userErrors', { productId, errors: msg });
      throw new Error(`Product (id=${productId}) default variant update failed: ${msg}`);
    }

    const ids = data.productVariantsBulkUpdate.productVariants.map((v) => stripGid(v.id, 'ProductVariant'));
    console.info('[ShopifyAdapter] step 3a/4 — update default variant done', { productId, ids });
    return ids;
  }

  private async execBulkCreateVariants(
    productGid: string,
    productId: string,
    extraVariants: ShopifyVariantInput[],
    optionNames: string[],
  ): Promise<string[]> {
    console.info('[ShopifyAdapter] step 3b/4 — productVariantsBulkCreate start', {
      productId, count: extraVariants.length,
    });

    interface BulkCreateResult {
      productVariantsBulkCreate: {
        productVariants: Array<{ id: string }>;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }

    const data = await this.graphql<BulkCreateResult>(
      `mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(productId: $productId, variants: $variants) {
          productVariants { id }
          userErrors { field message }
        }
      }`,
      {
        productId: productGid,
        variants: extraVariants.map((v) => ({
          price: v.price,
          ...(v.compareAtPrice !== undefined && { compareAtPrice: v.compareAtPrice || null }),
          inventoryItem: { sku: v.sku ?? '' },
          // Fase H · idem execDefaultVariantUpdate — respeita o flag por variante.
          ...(v.inventoryPolicy ? { inventoryPolicy: v.inventoryPolicy } : {}),
          optionValues: (v.optionValues ?? []).map((value, idx) => ({
            optionName: optionNames[idx] ?? `Option${idx + 1}`,
            name: value,
          })),
        })),
      },
    );

    if (data.productVariantsBulkCreate.userErrors.length > 0) {
      const msg = data.productVariantsBulkCreate.userErrors.map((e) => e.message).join('; ');
      console.error('[ShopifyAdapter] step 3b/4 — productVariantsBulkCreate userErrors', { productId, errors: msg });
      throw new Error(`Product (id=${productId}) extra variants creation failed: ${msg}`);
    }

    const ids = data.productVariantsBulkCreate.productVariants.map((v) => stripGid(v.id, 'ProductVariant'));
    console.info('[ShopifyAdapter] step 3b/4 — productVariantsBulkCreate done', { productId, totalNewVariants: ids.length });
    return ids;
  }

  private async execSingleVariantUpdate(
    productGid: string,
    productId: string,
    defaultVariantGid: string,
    variant: ShopifyVariantInput,
  ): Promise<string[]> {
    console.info('[ShopifyAdapter] step 3/4 — productVariantsBulkUpdate (single)', {
      productId, price: variant.price,
    });

    interface SingleUpdateResult {
      productVariantsBulkUpdate: {
        productVariants: Array<{ id: string }>;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }

    const data = await this.graphql<SingleUpdateResult>(
      `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id }
          userErrors { field message }
        }
      }`,
      {
        productId: productGid,
        variants: [{
          id: defaultVariantGid,
          price: variant.price,
          ...(variant.compareAtPrice !== undefined && { compareAtPrice: variant.compareAtPrice || null }),
          inventoryItem: { sku: variant.sku ?? '' },
          // Fase H · single-variant também precisa respeitar sell_without_stock.
          ...(variant.inventoryPolicy ? { inventoryPolicy: variant.inventoryPolicy } : {}),
        }],
      },
    );

    if (data.productVariantsBulkUpdate.userErrors.length > 0) {
      const msg = data.productVariantsBulkUpdate.userErrors.map((e) => e.message).join('; ');
      console.error('[ShopifyAdapter] step 3/4 — single variant update userErrors', { productId, errors: msg });
      throw new Error(`Product (id=${productId}) variant update failed: ${msg}`);
    }

    const ids = data.productVariantsBulkUpdate.productVariants.map((v) => stripGid(v.id, 'ProductVariant'));
    console.info('[ShopifyAdapter] step 3/4 — single variant update done', { productId, variantIds: ids });
    return ids;
  }

  // Story 18.3b · executa o plano na ordem segura: (1) preço/compareAt/inventoryPolicy das casadas POR
  // ID; (2) cria as novas; (3) remove as órfãs. Criar antes de remover: o produto nunca fica sem
  // variante e falha na criação não apaga nada. Cada passo repetido converge (idempotente).
  // Devolve os ids na ORDEM DO PAYLOAD (casadas + novas), com o mesmo comprimento do payload.
  private async execVariantPlan(
    productGid: string,
    productId: string,
    plan: VariantSyncPlan,
    variants: ShopifyVariantInput[],
    optionNames: string[],
  ): Promise<string[]> {
    if (plan.update.length > 0) {
      await this.execBulkUpdateVariantPrices(
        productGid,
        productId,
        plan.update.map((u) => u.remoteId),
        plan.update.map((u) => variants[u.index]!),
      );
    }
    const newIds =
      plan.create.length > 0
        ? await this.execBulkCreateVariants(productGid, productId, plan.create.map((i) => variants[i]!), optionNames)
        : [];
    if (plan.remove.length > 0) {
      if (this.removeOrphans) {
        console.warn('[ShopifyAdapter] step 3d/4 — removendo variantes órfãs (apagadas no BlackShop)', {
          productId,
          removedVariantIds: plan.remove,
        });
        await this.execBulkDeleteVariants(productGid, productId, plan.remove);
      } else {
        console.warn('[ShopifyAdapter] step 3d/4 — variantes órfãs mantidas na Shopify (removeOrphans=false)', {
          productId,
          orphanVariantIds: plan.remove,
        });
      }
    }
    const createdByIndex = new Map(plan.create.map((index, k) => [index, newIds[k]]));
    return plan.ordered
      .map((o) => o.remoteId ?? createdByIndex.get(o.index))
      .filter((id): id is string => typeof id === 'string');
  }

  private async execBulkDeleteVariants(productGid: string, productId: string, variantIds: string[]): Promise<void> {
    interface BulkDeleteResult {
      productVariantsBulkDelete: {
        product: { id: string } | null;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }
    const data = await this.graphql<BulkDeleteResult>(
      `mutation productVariantsBulkDelete($productId: ID!, $variantsIds: [ID!]!) {
        productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
          product { id }
          userErrors { field message }
        }
      }`,
      { productId: productGid, variantsIds: variantIds.map((id) => (id.startsWith('gid://') ? id : `gid://shopify/ProductVariant/${id}`)) },
    );
    if (data.productVariantsBulkDelete.userErrors.length > 0) {
      const msg = data.productVariantsBulkDelete.userErrors.map((e) => e.message).join('; ');
      console.error('[ShopifyAdapter] step 3d/4 — productVariantsBulkDelete userErrors', { productId, errors: msg });
      throw new Error(`Product (id=${productId}) variant removal failed: ${msg}`);
    }
    console.info('[ShopifyAdapter] step 3d/4 — productVariantsBulkDelete done', { productId, removed: variantIds.length });
  }

  // Atualiza preço + inventoryPolicy de variantes JÁ EXISTENTES no Shopify.
  // Usado no retry path quando existingVariantCount >= expected.length —
  // antes desse método, o adapter pulava completamente a sincronização de
  // preços em republish, deixando Shopify defasado quando o dono mudava
  // preços em massa no BlackShop.
  //
  // Mapping: existingVariantIds[i] ↔ variants[i]. No caminho com vínculo (Story 18.3b) os dois
  // arrays vêm do plano, já casados por id. No caminho antigo (chamador sem vínculo — LandingLab)
  // continua posicional: assume a mesma ordem do payload e de getRemoteProductState.
  private async execBulkUpdateVariantPrices(
    productGid: string,
    productId: string,
    existingVariantIds: string[],
    variants: ShopifyVariantInput[],
  ): Promise<void> {
    // Alinha comprimentos por segurança — se algum lado ficou fora de sincronia,
    // atualiza só o mínimo (não crasha nem cria variantes fantasma).
    const count = Math.min(existingVariantIds.length, variants.length);
    if (count === 0) return;

    console.info('[ShopifyAdapter] step 3c/4 — bulk update variant prices (retry sync)', {
      productId, count,
    });

    interface BulkUpdateResult {
      productVariantsBulkUpdate: {
        productVariants: Array<{ id: string }>;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }

    const inputs = [];
    for (let i = 0; i < count; i++) {
      const existingId = existingVariantIds[i]!;
      const v = variants[i]!;
      inputs.push({
        id: existingId.startsWith('gid://') ? existingId : `gid://shopify/ProductVariant/${existingId}`,
        price: v.price,
        // compareAtPrice presente = atualiza. Ausente = mantém o que está lá.
        // Para REMOVER o compare_at, o worker deve enviar string vazia.
        ...(v.compareAtPrice !== undefined && { compareAtPrice: v.compareAtPrice || null }),
        ...(v.inventoryPolicy ? { inventoryPolicy: v.inventoryPolicy } : {}),
      });
    }

    const data = await this.graphql<BulkUpdateResult>(
      `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id }
          userErrors { field message }
        }
      }`,
      { productId: productGid, variants: inputs },
    );

    if (data.productVariantsBulkUpdate.userErrors.length > 0) {
      const msg = data.productVariantsBulkUpdate.userErrors.map((e) => e.message).join('; ');
      console.error('[ShopifyAdapter] step 3c/4 — bulk update variant prices userErrors', { productId, errors: msg });
      throw new Error(`Product (id=${productId}) bulk variant price update failed: ${msg}`);
    }

    console.info('[ShopifyAdapter] step 3c/4 — bulk update variant prices done', {
      productId, updated: data.productVariantsBulkUpdate.productVariants.length,
    });
  }

  // Retorna Map<src → mediaId GID> — usado pelo Step 5 para associar variantes
  // à mídia correta. Antes o método era void e os IDs eram descartados;
  // sem eles, não havia como ligar imagem↔variante na Shopify (bug reportado).
  //
  // Ordem: mutation productCreateMedia devolve `media[]` NA MESMA ORDEM de
  // input.media[], então casamos por índice. Não há campo `src` no retorno
  // (só `id`), por isso a chave do map é o src que enviamos.
  private async execCreateMedia(
    productGid: string,
    productId: string,
    images: Array<{ src: string }>,
  ): Promise<Map<string, string>> {
    console.info('[ShopifyAdapter] step 4/5 — productCreateMedia start', {
      productId, count: images.length,
    });

    interface MediaResult {
      productCreateMedia: {
        media: Array<{ id?: string }>;
        mediaUserErrors: Array<{ field: string[]; message: string }>;
      };
    }

    const data = await this.graphql<MediaResult>(
      `mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media { ... on MediaImage { id } }
          mediaUserErrors { field message }
        }
      }`,
      {
        productId: productGid,
        media: images.map((img) => ({ originalSource: img.src, mediaContentType: 'IMAGE' })),
      },
    );

    if (data.productCreateMedia.mediaUserErrors.length > 0) {
      const msg = data.productCreateMedia.mediaUserErrors.map((e) => e.message).join('; ');
      console.error('[ShopifyAdapter] step 4/5 — productCreateMedia userErrors', { productId, errors: msg });
      throw new Error(`Product (id=${productId}) media creation failed: ${msg}`);
    }

    // Casa src → mediaId por ÍNDICE (mutation preserva ordem do input).
    // Se algum media do retorno vier sem id (rejeição parcial), pula.
    const srcToMediaId = new Map<string, string>();
    for (let i = 0; i < images.length; i++) {
      const mediaId = data.productCreateMedia.media[i]?.id;
      const src = images[i]?.src;
      if (mediaId && src) srcToMediaId.set(src, mediaId);
    }

    console.info('[ShopifyAdapter] step 4/5 — productCreateMedia done', {
      productId,
      mediaCreated: srcToMediaId.size,
    });
    return srcToMediaId;
  }

  // Step 5 · liga cada variante à sua mídia via productVariantsBulkUpdate
  // com o campo `mediaId`. Suportado desde 2023-10; adapter usa 2024-01, ok.
  //
  // Recebe [variantId, imageUrl][] onde imageUrl é o src que foi enviado ao
  // productCreateMedia (o worker calcula: para cada variante, pega a URL da
  // primeira imagem do BlackShop com colorValue igual ao da variante).
  // Se srcToMediaId não tem a URL (imagem falhou), pula silenciosamente —
  // não faz sentido derrubar o publish inteiro por 1 mídia.
  private async execLinkVariantsToMedia(
    productGid: string,
    productId: string,
    variantMediaPairs: Array<{ variantId: string; imageUrl: string }>,
    srcToMediaId: Map<string, string>,
  ): Promise<void> {
    const inputs = variantMediaPairs
      .map(({ variantId, imageUrl }) => {
        const mediaId = srcToMediaId.get(imageUrl);
        if (!mediaId) return null;
        return {
          id: variantId.startsWith('gid://')
            ? variantId
            : `gid://shopify/ProductVariant/${variantId}`,
          mediaId,
        };
      })
      .filter((v): v is { id: string; mediaId: string } => v !== null);

    if (inputs.length === 0) {
      console.info('[ShopifyAdapter] step 5/5 — link variant→media skipped (no pairs)', { productId });
      return;
    }

    console.info('[ShopifyAdapter] step 5/5 — linking variants to media', {
      productId,
      linkCount: inputs.length,
    });

    interface BulkUpdateResult {
      productVariantsBulkUpdate: {
        productVariants: Array<{ id: string }>;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }

    const data = await this.graphql<BulkUpdateResult>(
      `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id }
          userErrors { field message }
        }
      }`,
      { productId: productGid, variants: inputs },
    );

    if (data.productVariantsBulkUpdate.userErrors.length > 0) {
      // Não derruba o publish — erro aqui é degradação (variante fica sem
      // imagem no admin), não perda de dado. Log claro para o dono ver.
      const msg = data.productVariantsBulkUpdate.userErrors.map((e) => e.message).join('; ');
      console.warn('[ShopifyAdapter] step 5/5 — link variant→media userErrors', { productId, errors: msg });
      return;
    }

    console.info('[ShopifyAdapter] step 5/5 — link variant→media done', {
      productId,
      linkedCount: data.productVariantsBulkUpdate.productVariants.length,
    });
  }

  async updateProduct(
    id: string,
    payload: Partial<ShopifyProductPayload>,
  ): Promise<ShopifyProductResponse> {
    const mutation = `
      mutation productUpdate($input: ProductInput!) {
        productUpdate(input: $input) {
          product { id title handle status }
          userErrors { field message }
        }
      }
    `;

    interface UpdateResult {
      productUpdate: {
        product: { id: string; title: string; handle: string; status: string } | null;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }

    const input: Record<string, unknown> = {
      id: `gid://shopify/Product/${id}`,
      title: payload.title,
      descriptionHtml: payload.description_html,
      vendor: payload.vendor,
      productType: payload.product_type,
      tags: payload.tags ? payload.tags.split(',').map((t) => t.trim()) : undefined,
    };
    for (const key of Object.keys(input)) {
      if (input[key] === undefined) delete input[key];
    }

    const data = await this.graphql<UpdateResult>(mutation, { input });

    if (data.productUpdate.userErrors.length > 0) {
      throw new Error(
        `Shopify productUpdate userErrors: ${data.productUpdate.userErrors
          .map((e) => e.message)
          .join('; ')}`,
      );
    }

    const p = data.productUpdate.product;
    if (!p) throw new Error('Shopify productUpdate returned no product');

    return {
      id: stripGid(p.id, 'Product'),
      title: p.title,
      handle: p.handle,
      status: p.status.toLowerCase(),
    };
  }

  async deleteProduct(id: string): Promise<void> {
    const mutation = `
      mutation productDelete($input: ProductDeleteInput!) {
        productDelete(input: $input) {
          deletedProductId
          userErrors { field message }
        }
      }
    `;

    interface DeleteResult {
      productDelete: {
        deletedProductId: string | null;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }

    const data = await this.graphql<DeleteResult>(mutation, {
      input: { id: `gid://shopify/Product/${id}` },
    });

    if (data.productDelete.userErrors.length > 0) {
      throw new Error(
        `Shopify productDelete userErrors: ${data.productDelete.userErrors
          .map((e) => e.message)
          .join('; ')}`,
      );
    }
  }

  async getProduct(id: string): Promise<ShopifyProductResponse | null> {
    const query = `
      query getProduct($id: ID!) {
        product(id: $id) {
          id title handle status
          variants(first: 100) { edges { node { id } } }
        }
      }
    `;

    interface GetResult {
      product: {
        id: string;
        title: string;
        handle: string;
        status: string;
        variants: { edges: Array<{ node: { id: string } }> };
      } | null;
    }

    const data = await this.graphql<GetResult>(query, {
      id: `gid://shopify/Product/${id}`,
    });

    if (!data.product) return null;
    const p = data.product;
    return {
      id: stripGid(p.id, 'Product'),
      title: p.title,
      handle: p.handle,
      status: p.status.toLowerCase(),
      variantIds: p.variants.edges.map((e) => stripGid(e.node.id, 'ProductVariant')),
    };
  }

  async testConnection(): Promise<ConnectionStatus> {
    const query = `query { shop { name } }`;
    interface ShopResult {
      shop: { name: string };
    }
    try {
      const data = await this.graphql<ShopResult>(query);
      return { ok: true, message: `Connected to ${data.shop.name}` };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Connection failed',
      };
    }
  }

  // Bloco 3 · lista todos os webhookSubscriptions ativos.
  async listWebhooks(): Promise<ShopifyWebhookSubscription[]> {
    interface ListResult {
      webhookSubscriptions: {
        edges: Array<{
          node: {
            id: string;
            topic: string;
            format: 'JSON' | 'XML';
            endpoint: { __typename: string; callbackUrl?: string | null };
          };
        }>;
      };
    }
    const data = await this.graphql<ListResult>(
      `query listWebhooks {
        webhookSubscriptions(first: 100) {
          edges {
            node {
              id
              topic
              format
              endpoint {
                __typename
                ... on WebhookHttpEndpoint { callbackUrl }
              }
            }
          }
        }
      }`,
    );
    return data.webhookSubscriptions.edges
      .map((e) => e.node)
      .filter((n) => n.endpoint.__typename === 'WebhookHttpEndpoint' && n.endpoint.callbackUrl)
      .map((n) => ({
        id: stripGid(n.id, 'WebhookSubscription'),
        topic: n.topic,
        callbackUrl: n.endpoint.callbackUrl!,
        format: n.format,
      }));
  }

  // Bloco 3 · registra um webhook idempotentemente. Se já existe uma
  // subscription para (topic, callbackUrl), retorna a existente sem
  // duplicar. Faz UMA chamada de listagem, então UMA de create se necessário.
  async registerWebhook(topic: string, callbackUrl: string): Promise<ShopifyWebhookSubscription> {
    const existing = await this.listWebhooks();
    const match = existing.find((w) => w.topic === topic && w.callbackUrl === callbackUrl);
    if (match) return match;

    interface CreateResult {
      webhookSubscriptionCreate: {
        webhookSubscription: {
          id: string;
          topic: string;
          format: 'JSON' | 'XML';
          endpoint: { __typename: string; callbackUrl?: string | null };
        } | null;
        userErrors: Array<{ field: string[] | null; message: string; code?: string }>;
      };
    }
    const data = await this.graphql<CreateResult>(
      `mutation createWebhook($topic: WebhookSubscriptionTopic!, $subscription: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $subscription) {
          webhookSubscription {
            id
            topic
            format
            endpoint {
              __typename
              ... on WebhookHttpEndpoint { callbackUrl }
            }
          }
          userErrors { field message code }
        }
      }`,
      {
        topic,
        subscription: { callbackUrl, format: 'JSON' },
      },
    );

    const { webhookSubscription, userErrors } = data.webhookSubscriptionCreate;
    if (userErrors.length > 0) {
      // Alguns erros comuns: TAKEN (já existe) — nesse caso relistar
      // e devolver o existente ao invés de propagar.
      const taken = userErrors.find((e) => (e.code ?? '').toUpperCase() === 'TAKEN');
      if (taken) {
        const after = await this.listWebhooks();
        const found = after.find((w) => w.topic === topic && w.callbackUrl === callbackUrl);
        if (found) return found;
      }
      throw new Error(
        `webhookSubscriptionCreate failed: ${userErrors.map((e) => e.message).join('; ')}`,
      );
    }
    if (!webhookSubscription) {
      throw new Error('webhookSubscriptionCreate returned no subscription');
    }
    return {
      id: stripGid(webhookSubscription.id, 'WebhookSubscription'),
      topic: webhookSubscription.topic,
      callbackUrl: webhookSubscription.endpoint.callbackUrl ?? callbackUrl,
      format: webhookSubscription.format,
    };
  }

  // Fase 2 Bloco 3.1 · lista PriceLists da loja para descoberta automática
  // de IDs por moeda. Retorna id em GID (`gid://shopify/PriceList/N`) — o
  // caller usa direto em setFixedPrices. Uma chamada de listagem cobre até
  // 100 PriceLists (mais que suficiente para nossos 4 markets).
  async listPriceLists(): Promise<ShopifyPriceList[]> {
    interface ListResult {
      priceLists: {
        edges: Array<{
          node: {
            id: string;
            name: string | null;
            currency: string;
          };
        }>;
      };
    }
    const data = await this.graphql<ListResult>(
      `query listPriceLists {
        priceLists(first: 100) {
          edges { node { id name currency } }
        }
      }`,
    );
    return data.priceLists.edges.map((e) => ({
      id: e.node.id,
      name: e.node.name,
      currencyCode: e.node.currency,
    }));
  }

  // Fase 2 Bloco 3.1 · cadastra preço fixo por variante numa PriceList via
  // `priceListFixedPricesAdd`. Mesma variante enviada de novo sobrescreve
  // (é o comportamento nativo da mutation, o que é ideal pro nosso sync).
  //
  // Retorna { ok, errors }: consolida userErrors em strings de log — os
  // callers (price-sync processor) usam esse array pra montar mensagem
  // de `price_sync_error`.
  async setFixedPrices(
    priceListId: string,
    prices: ShopifyFixedPriceInput[],
  ): Promise<ShopifyFixedPricesResult> {
    if (!priceListId) {
      return { ok: false, errors: ['priceListId is required'] };
    }
    if (prices.length === 0) {
      return { ok: true, errors: [] };
    }

    interface AddResult {
      priceListFixedPricesAdd: {
        prices: Array<{ variant: { id: string }; price: { amount: string; currencyCode: string } }>;
        userErrors: Array<{ field: string[] | null; code?: string; message: string }>;
      };
    }

    const gidPriceListId = priceListId.startsWith('gid://shopify/PriceList/')
      ? priceListId
      : `gid://shopify/PriceList/${priceListId}`;

    const data = await this.graphql<AddResult>(
      `mutation priceListFixedPricesAdd($priceListId: ID!, $prices: [PriceListPriceInput!]!) {
        priceListFixedPricesAdd(priceListId: $priceListId, prices: $prices) {
          prices { variant { id } price { amount currencyCode } }
          userErrors { field code message }
        }
      }`,
      {
        priceListId: gidPriceListId,
        prices: prices.map((p) => ({
          variantId: p.variantId.startsWith('gid://shopify/ProductVariant/')
            ? p.variantId
            : `gid://shopify/ProductVariant/${p.variantId}`,
          price: {
            amount: p.amount,
            currencyCode: p.currencyCode,
          },
        })),
      },
    );

    const errors = data.priceListFixedPricesAdd.userErrors.map(
      (e) => `${e.code ?? 'ERR'}: ${e.message}`,
    );
    return { ok: errors.length === 0, errors };
  }

  // Fase G · lista publications (canais de venda) da store. O processor
  // usa isso UMA vez por processo (cacheia por 1h) para descobrir o GID
  // do "Online Store" e publicar cada produto lá após createProduct.
  //
  // Por que precisamos: productCreate deixa o produto ACTIVE no admin
  // mas NÃO publicado em canal — ele fica invisível na loja até chamar
  // publishablePublish com o publication id do Online Store.
  async listPublications(): Promise<ShopifyPublication[]> {
    interface Result {
      publications: {
        edges: Array<{ node: { id: string; name: string } }>;
      };
    }
    const data = await this.graphql<Result>(
      `query publications { publications(first: 25) { edges { node { id name } } } }`,
    );
    return data.publications.edges.map((e) => ({
      id: e.node.id,
      name: e.node.name,
    }));
  }

  // Fase G · publishablePublish é idempotente pela Shopify: chamar duas
  // vezes com o mesmo par (product, publication) não gera erro nem
  // duplica — apenas reafirma a publicação. Isso deixa o processor
  // seguro para retry.
  async publishToPublications(
    productId: string,
    publicationIds: string[],
  ): Promise<ShopifyPublishResult> {
    if (publicationIds.length === 0) {
      return { ok: true, publishedTo: [], errors: [] };
    }
    const gid = productId.startsWith('gid://shopify/Product/')
      ? productId
      : `gid://shopify/Product/${productId}`;

    interface Result {
      publishablePublish: {
        publishable: { publicationCount: number } | null;
        shop: { publicationCount: number } | null;
        // publishablePublish devolve `UserError` (schema base) — este tipo
        // NÃO tem campo `code`. Pedir `code` causa GraphQL error
        // "Field 'code' doesn't exist on type 'UserError'" (2025-10).
        userErrors: Array<{ field: string[] | null; message: string }>;
      };
    }

    const data = await this.graphql<Result>(
      `mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
          publishable { publicationCount }
          shop { publicationCount }
          userErrors { field message }
        }
      }`,
      {
        id: gid,
        input: publicationIds.map((pubId) => ({
          publicationId: pubId.startsWith('gid://shopify/Publication/')
            ? pubId
            : `gid://shopify/Publication/${pubId}`,
        })),
      },
    );

    const errors = data.publishablePublish.userErrors.map(
      (e) => `${(e.field ?? []).join('.') || 'ERR'}: ${e.message}`,
    );
    return {
      ok: errors.length === 0,
      publishedTo: errors.length === 0 ? publicationIds : [],
      errors,
    };
  }

  // Story 18.3 (QA REQ-001) · remove o marcador de reconciliação. Best effort: falha só loga —
  // o produto continua correto (a tag é inofensiva), apenas fica visível até alguém removê-la.
  private async removeReconcileTag(productGid: string, tag: string): Promise<boolean> {
    try {
      const data = await this.graphql<{ tagsRemove: { userErrors: Array<{ message: string }> } }>(
        `mutation tagsRemove($id: ID!, $tags: [String!]!) {
          tagsRemove(id: $id, tags: $tags) { userErrors { message } }
        }`,
        { id: productGid, tags: [tag] },
      );
      if (data.tagsRemove.userErrors.length > 0) {
        console.warn('[ShopifyAdapter] marcador de reconciliação não removido', {
          code: RECONCILE_TAG_NOT_REMOVED,
          productGid,
          errors: data.tagsRemove.userErrors.map((e) => e.message).join('; '),
        });
        return false;
      }
      return true;
    } catch (err) {
      console.warn('[ShopifyAdapter] marcador de reconciliação não removido', {
        code: RECONCILE_TAG_NOT_REMOVED,
        productGid,
        err: String(err),
      });
      return false;
    }
  }

  // Story 18.3 (QA MNT-002) · nova tentativa de remover o marcador (o publish chama antes de
  // publicar nos canais quando a remoção do createProduct falhou).
  async removeProductTag(productId: string, tag: string): Promise<boolean> {
    const productGid = productId.startsWith('gid://') ? productId : `gid://shopify/Product/${productId}`;
    return this.removeReconcileTag(productGid, tag);
  }

  // Story 18.3 (QA REQ-001) · produtos com a tag exata (marcador do productCreate). A busca da
  // Shopify é por termo e eventualmente consistente; o filtro exato é feito aqui.
  async findProductByTag(tag: string): Promise<ShopifyProductMatch[]> {
    interface QueryResult {
      products: { edges: Array<{ node: { id: string; handle: string; tags: string[] } }> };
    }
    const term = tag.replace(/['"\\]/g, '');
    const data = await this.graphql<QueryResult>(
      `query findProductByTag($query: String!) {
        products(first: 20, query: $query) {
          edges { node { id handle tags } }
        }
      }`,
      { query: `tag:'${term}'` },
    );
    const matches = new Map<string, ShopifyProductMatch>();
    for (const { node } of data.products.edges) {
      if (!node.tags.includes(tag)) continue;
      const productId = stripGid(node.id, 'Product');
      if (!matches.has(productId)) matches.set(productId, { productId, handle: node.handle });
    }
    return [...matches.values()];
  }

  // Story 18.3 · reconciliação antes de recriar (F1 da 0.4/0.8): procura variantes com o SKU
  // exato e devolve os produtos distintos. Consulta → o cliente HTTP repete 429/5xx/timeout como
  // transitório. A busca da Shopify é por termo; o filtro exato (sku === pedido) é feito aqui.
  async findProductByVariantSku(sku: string): Promise<ShopifyProductMatch[]> {
    interface QueryResult {
      productVariants: {
        edges: Array<{ node: { sku: string | null; product: { id: string; handle: string } | null } }>;
      };
    }
    const term = sku.replace(/["\\]/g, '');
    const data = await this.graphql<QueryResult>(
      `query findProductByVariantSku($query: String!) {
        productVariants(first: 20, query: $query) {
          edges { node { sku product { id handle } } }
        }
      }`,
      { query: `sku:"${term}"` },
    );
    const matches = new Map<string, ShopifyProductMatch>();
    for (const { node } of data.productVariants.edges) {
      if (node.sku !== sku || !node.product) continue;
      const productId = stripGid(node.product.id, 'Product');
      if (!matches.has(productId)) matches.set(productId, { productId, handle: node.product.handle });
    }
    return [...matches.values()];
  }

  // Jul/2026 · lista variantes atuais de um produto por opções.
  // Paginação: 100 por vez (limite Admin API), até 250 variantes/produto —
  // se sua loja tem produtos com >250 variantes, a Shopify recomenda usar
  // Bulk API. Nossos produtos não passam de ~100 variantes hoje.
  async listProductVariants(productId: string): Promise<ShopifyVariantSnapshot[]> {
    const productGid = productId.startsWith('gid://')
      ? productId
      : `gid://shopify/Product/${productId}`;

    interface QueryResult {
      product: {
        id: string;
        variants: {
          edges: Array<{
            node: {
              id: string;
              selectedOptions: Array<{ name: string; value: string }>;
            };
          }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    }

    const collected: ShopifyVariantSnapshot[] = [];
    let cursor: string | null = null;

    // Paginação até esgotar (guard <= 5 páginas = 500 variantes máx).
    for (let page = 0; page < 5; page++) {
      const data: QueryResult = await this.graphql<QueryResult>(
        `query getProductVariants($productId: ID!, $cursor: String) {
          product(id: $productId) {
            id
            variants(first: 100, after: $cursor) {
              edges {
                node {
                  id
                  selectedOptions { name value }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { productId: productGid, cursor },
      );

      if (!data.product) return [];

      for (const edge of data.product.variants.edges) {
        collected.push({
          id: stripGid(edge.node.id, 'ProductVariant'),
          selectedOptions: edge.node.selectedOptions,
        });
      }

      if (!data.product.variants.pageInfo.hasNextPage) break;
      cursor = data.product.variants.pageInfo.endCursor;
      if (!cursor) break;
    }

    return collected;
  }

  // Jul/2026 · listProductMediaMap — retorna Map<sourceUrl → mediaId>
  // pra cada mídia do produto. Usado pelo rewire-variant-media.
  //
  // Trickery: Shopify não devolve "originalSource" (a URL que enviamos ao
  // productCreateMedia). Ela normaliza tudo pra CDN dela (cdn.shopify.com).
  // Nem `MediaImage.image.url` nem `preview.image.url` são iguais ao src
  // original. Solução: usamos a `filename` do MediaImage, que herda o
  // basename da URL original — ex: `Polo_A2_9a144fa5-....jpg`. Casamos
  // pelo BASENAME da URL do BlackShop com o filename do Shopify. Colisão
  // (2 imagens com mesmo basename) é improvável (nossos slugs incluem UUID).
  async listProductMediaMap(productId: string): Promise<Map<string, string>> {
    const productGid = productId.startsWith('gid://')
      ? productId
      : `gid://shopify/Product/${productId}`;

    interface QueryResult {
      product: {
        media: {
          edges: Array<{
            node: {
              id: string;
              mediaContentType?: string;
              // MediaImage tem "image { url, altText }" — os outros tipos podem não ter.
              image?: { url: string; altText: string | null } | null;
              // filename é o basename original (ex: Polo_A2_...jpg)
              alt?: string | null;
            };
          }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    }

    const collected = new Map<string, string>();
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const data: QueryResult = await this.graphql<QueryResult>(
        `query getProductMedia($productId: ID!, $cursor: String) {
          product(id: $productId) {
            media(first: 100, after: $cursor) {
              edges {
                node {
                  id
                  mediaContentType
                  ... on MediaImage { image { url altText } }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { productId: productGid, cursor },
      );
      if (!data.product) return new Map();
      for (const edge of data.product.media.edges) {
        const url = edge.node.image?.url;
        if (!url) continue;
        // Chave é o BASENAME (sem query string). Ex: cdn.shopify.com/.../Polo_A2_...jpg?v=1
        // vira "Polo_A2_....jpg". Caller usa o mesmo cálculo com a URL do BlackShop.
        const basename = basenameFromUrl(url);
        if (basename) collected.set(basename, edge.node.id);
        // Também indexa pela URL completa CDN, caso caller queira casar direto.
        collected.set(url, edge.node.id);
      }
      if (!data.product.media.pageInfo.hasNextPage) break;
      cursor = data.product.media.pageInfo.endCursor;
      if (!cursor) break;
    }
    return collected;
  }

  async linkVariantsToMedia(
    productId: string,
    pairs: Array<{ variantId: string; mediaId: string }>,
  ): Promise<{ ok: boolean; linked: number; errors: string[] }> {
    if (pairs.length === 0) return { ok: true, linked: 0, errors: [] };

    const productGid = productId.startsWith('gid://')
      ? productId
      : `gid://shopify/Product/${productId}`;

    const inputs = pairs.map(({ variantId, mediaId }) => ({
      id: variantId.startsWith('gid://')
        ? variantId
        : `gid://shopify/ProductVariant/${variantId}`,
      mediaId,
    }));

    interface BulkUpdateResult {
      productVariantsBulkUpdate: {
        productVariants: Array<{ id: string }>;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }

    const data = await this.graphql<BulkUpdateResult>(
      `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id }
          userErrors { field message }
        }
      }`,
      { productId: productGid, variants: inputs },
    );

    const errors = data.productVariantsBulkUpdate.userErrors.map(
      (e) => `${(e.field ?? []).join('.')}: ${e.message}`,
    );
    return {
      ok: errors.length === 0,
      linked: data.productVariantsBulkUpdate.productVariants.length,
      errors,
    };
  }
}

// Extrai basename (parte final da path) de uma URL, sem query string.
// Ex: https://cdn.shopify.com/s/files/.../Polo_A2_9a144fa5.jpg?v=1  → "Polo_A2_9a144fa5.jpg"
function basenameFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').pop();
    if (!last) return null;
    return decodeURIComponent(last).trim();
  } catch {
    return null;
  }
}

function stripGid(value: string, resource: string): string {
  const prefix = `gid://shopify/${resource}/`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}
