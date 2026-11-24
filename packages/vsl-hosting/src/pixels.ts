export type VslPixelInput = { meta?: string; tiktok?: string; googleAdsId?: string; googleAdsLabel?: string; ga4?: string; enabled?: boolean };
const id = /^[A-Za-z0-9._-]{2,120}$/;
export function validateVslPixels(input: VslPixelInput) {
  const value = { ...input, enabled: input.enabled ?? true };
  for (const [key, raw] of Object.entries(value)) if (key !== 'enabled' && raw !== undefined && (typeof raw !== 'string' || !raw || !id.test(raw))) throw new Error(`Invalid VSL pixel ${key}`);
  return value;
}
export function snapshotVslPixels(input?: VslPixelInput | null) { return input ? Object.freeze(validateVslPixels(input)) : Object.freeze({ enabled: false }); }
export type VslPixelEvent = { provider: 'meta'|'tiktok'|'google'|'ga4'; event: 'pageview'|'checkout_click'; key: string };
export function dedupeVslPixelEvents(events: VslPixelEvent[]) { const seen = new Set<string>(); return events.filter(e => !seen.has(e.key) && (seen.add(e.key), true)); }
