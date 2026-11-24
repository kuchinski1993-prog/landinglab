import { describe, expect, it } from 'vitest';

import { dedupeVslPixelEvents, snapshotVslPixels, validateVslPixels } from '../pixels.js';
describe('VSL owned pixels', () => {
  it('validates structured IDs and disables absent config', () => { expect(snapshotVslPixels()).toEqual({ enabled: false }); expect(validateVslPixels({ meta:'px-1',enabled:false }).enabled).toBe(false); expect(() => validateVslPixels({ meta:'<script>' })).toThrow(); });
  it('creates immutable snapshots and deduplicates lifecycle events', () => { const s=snapshotVslPixels({ga4:'G-123'}); expect(Object.isFrozen(s)).toBe(true); expect(dedupeVslPixelEvents([{provider:'ga4',event:'pageview',key:'load'},{provider:'ga4',event:'pageview',key:'load'}])).toHaveLength(1); });
});
