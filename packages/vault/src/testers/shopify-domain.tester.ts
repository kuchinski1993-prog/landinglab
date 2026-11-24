import { lookup } from 'node:dns/promises';

import type { ConnectionStatus } from './shopify-admin.tester.js';

export async function testShopifyDomain(domain: string): Promise<ConnectionStatus> {
  const cleaned = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();

  if (!cleaned || !cleaned.includes('.')) {
    return { status: 'error', message: 'Invalid domain format. Expected: my-store.myshopify.com' };
  }

  try {
    await lookup(cleaned);
    return { status: 'ok', message: `Domain ${cleaned} resolves successfully` };
  } catch {
    return { status: 'error', message: `Cannot resolve domain: ${cleaned}` };
  }
}
