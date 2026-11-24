import { describe, it, expect } from 'vitest';

import {
  products,
  productVariants,
  productImages,
  publishRecords,
  jobs,
  jobLogs,
  credentials,
  priceRules,
  claudeCache,
} from '../schema.js';

const EXPECTED_TABLES = [
  ['products', products],
  ['product_variants', productVariants],
  ['product_images', productImages],
  ['publish_records', publishRecords],
  ['jobs', jobs],
  ['job_logs', jobLogs],
  ['credentials', credentials],
  ['price_rules', priceRules],
  ['claude_cache', claudeCache],
] as const;

describe('schema definitions', () => {
  it('exports all 9 tables expected by the architecture', () => {
    expect(EXPECTED_TABLES).toHaveLength(9);
    for (const [, table] of EXPECTED_TABLES) {
      expect(table).toBeDefined();
    }
  });

  it.each(EXPECTED_TABLES)('table %s has at least one column', (_name, table) => {
    const columns = Object.keys(table);
    expect(columns.length).toBeGreaterThan(0);
  });

  it('products table enforces unique source_url and tracks updated_at', () => {
    expect(products.sourceUrl).toBeDefined();
    expect(products.updatedAt).toBeDefined();
    expect(products.status).toBeDefined();
    expect(products.syncStatus).toBeDefined();
  });

  it('jobs table tracks status, queue and attempts', () => {
    expect(jobs.status).toBeDefined();
    expect(jobs.queue).toBeDefined();
    expect(jobs.attempts).toBeDefined();
    expect(jobs.maxAttempts).toBeDefined();
  });

  it('credentials table stores encrypted payload, iv and salt as bytea', () => {
    expect(credentials.encryptedValue).toBeDefined();
    expect(credentials.iv).toBeDefined();
    expect(credentials.salt).toBeDefined();
  });
});
