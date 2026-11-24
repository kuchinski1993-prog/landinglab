export type {
  ShopifyAdapter,
  ShopifyProductPayload,
  ShopifyProductResponse,
  ConnectionStatus,
  ShopifyWebhookSubscription,
  ShopifyPriceList,
  ShopifyFixedPriceInput,
  ShopifyFixedPricesResult,
  ShopifyPublication,
  ShopifyPublishResult,
  ShopifyVariantSnapshot,
  ShopifyVariantInput,
  ShopifyImageInput,
  ShopifyProductMatch,
} from './adapter.interface.js';
export { MockShopifyAdapter } from './mock.adapter.js';
export { RealShopifyAdapter } from './real.adapter.js';
export type { RealShopifyAdapterOptions } from './real.adapter.js';
export { REMOVE_ORPHAN_VARIANTS } from './real.adapter.js';
export { ShopifyVariantPlanError, planVariantSync } from './variant-sync-plan.js';
export type { ShopifyVariantPlanErrorCode, VariantSyncPlan, RemoteVariantState } from './variant-sync-plan.js';
export { createShopifyAdapter } from './factory.js';
export type { ShopifyMode, ShopifyAdapterCredentials } from './factory.js';

export const SHOPIFY_ADAPTER_PACKAGE_VERSION = '0.2.0';
