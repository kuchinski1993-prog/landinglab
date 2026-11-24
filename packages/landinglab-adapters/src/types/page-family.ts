// ADR-001 §2 (D2) — PageFamily como dimensão de primeira classe.
// Adapter é resolvido por (PageFamily × Theme).

export const PAGE_FAMILIES = [
  'sales_page',
  'advertorial',
  'pdp_derived',
  'unknown',
] as const;

export type PageFamily = (typeof PAGE_FAMILIES)[number];

export function isPageFamily(value: unknown): value is PageFamily {
  return typeof value === 'string' && (PAGE_FAMILIES as readonly string[]).includes(value);
}
