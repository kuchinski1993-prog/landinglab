// Active store helper — single source of truth for the current storeId in
// client components. Persists via cookie so SSR can read it (we still read from
// the cookie on the server side when needed).

export const ACTIVE_STORE_COOKIE = 'bs:activeStoreId';
const DEFAULT_STORE_ID = 'default';
const ONE_YEAR_SECONDS = 31_536_000;

export function getActiveStoreId(): string {
  if (typeof document === 'undefined') return DEFAULT_STORE_ID;
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${ACTIVE_STORE_COOKIE}=([^;]+)`),
  );
  if (!match || !match[1]) return DEFAULT_STORE_ID;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return DEFAULT_STORE_ID;
  }
}

export function setActiveStoreId(storeId: string): void {
  if (typeof document === 'undefined') return;
  const value = storeId.trim().length > 0 ? storeId.trim() : DEFAULT_STORE_ID;
  document.cookie = `${ACTIVE_STORE_COOKIE}=${encodeURIComponent(value)}; path=/; max-age=${ONE_YEAR_SECONDS}; SameSite=Strict`;
}
