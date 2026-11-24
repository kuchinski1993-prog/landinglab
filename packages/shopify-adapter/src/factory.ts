import { resolveIntegrationMode } from '@blackshop/shared/runtime-mode';

import type { ShopifyAdapter } from './adapter.interface.js';
import { MockShopifyAdapter } from './mock.adapter.js';
import { RealShopifyAdapter, type RealShopifyAdapterOptions } from './real.adapter.js';

export type ShopifyMode = 'mock' | 'real';

export interface ShopifyAdapterCredentials {
  adminToken: string;
  storeDomain: string;
}

export function createShopifyAdapter(
  mode?: ShopifyMode,
  credentials?: ShopifyAdapterCredentials,
  options?: RealShopifyAdapterOptions,
): ShopifyAdapter {
  // Story 0.4: sem argumento, o modo vem do resolver central — em produção, SHOPIFY_MODE
  // ausente/inválido lança IntegrationModeError (nunca mock implícito). Com argumento
  // explícito, o comportamento é o de sempre.
  const resolved: ShopifyMode = mode ?? resolveIntegrationMode('shopify').mode;
  if (resolved === 'real') {
    if (!credentials) {
      throw new Error('createShopifyAdapter: credentials are required for real mode');
    }
    return new RealShopifyAdapter(credentials.adminToken, credentials.storeDomain, options);
  }
  return new MockShopifyAdapter();
}
