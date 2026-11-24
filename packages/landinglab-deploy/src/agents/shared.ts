// Shared helpers for Squad 5 (Deploy) agents.
//
// Story 13.8 Wave 2 — AC5 (subdomain slug generation policy).
//
// Design (from [AUTO-DECISION] Wave 1):
//   - Root domain 'landinglab.app' is wildcard-routed to Vercel (one-time ops).
//   - Slugs come from `landing_pages.slug` (already suffixed with '-{lang}' by
//     Squad 4 variant flow for non-EN); we only need to sanitize + fit DNS label.
//   - RFC 1035 label limit: 63 chars per DNS label. If exceeds after sanitization,
//     truncate + append 6-char hash to preserve uniqueness across truncations.
//   - Reserved subdomains fall back to '{slug}-lp.landinglab.app'.

import { createHash } from 'node:crypto';

export const ROOT_DOMAIN = 'landinglab.app';

/** Subdomains reserved by ops. Never issued to landings — falls back to '-lp' suffix. */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  'www',
  'app',
  'api',
  'admin',
  'preview',
  'test',
  'staging',
]);

/** RFC-1035 hard cap for a single DNS label. */
const MAX_LABEL_LENGTH = 63;
/** Room reserved for hash suffix when truncation is needed ('-abcdef' = 7 chars). */
const HASH_SUFFIX_LENGTH = 7;

/**
 * Sanitize a slug for use as a DNS label:
 *   - Lowercase
 *   - Non-alphanumeric → '-'
 *   - Collapse consecutive dashes
 *   - Trim leading/trailing dashes
 *
 * Empty result maps to '' — caller MUST reject before hitting DNS.
 */
export function sanitizeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .normalize('NFKD') // strip accents (é → e)
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Deterministic 6-char hash of the input (hex, lowercase).
 * Used to disambiguate truncated slugs.
 */
function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 6);
}

/**
 * Compute the FQDN a subdomain deployment should use.
 *
 * Contract (AC5):
 *   - Returns '{sanitized-slug}.landinglab.app'.
 *   - If sanitized slug > 63 chars, truncates to 56 chars + '-{hash6}'.
 *   - If sanitized slug matches a reserved subdomain, appends '-lp' suffix.
 *   - `contentLanguage` is accepted for API symmetry but does NOT alter the
 *     hostname — Squad 4 already suffixes the slug with '-{lang}' for variants.
 *
 * @throws Error when the sanitized slug is empty (input had no valid chars).
 */
export function computeSubdomainHostname(
  landingPageSlug: string,
  contentLanguage: string,
): string {
  void contentLanguage; // API symmetry per spec (variants encoded in slug already)

  const sanitized = sanitizeSlug(landingPageSlug);
  if (sanitized.length === 0) {
    throw new Error(
      `computeSubdomainHostname: slug "${landingPageSlug}" produced empty label after sanitization`,
    );
  }

  let label = sanitized;

  if (RESERVED_SUBDOMAINS.has(label)) {
    label = `${label}-lp`;
  }

  if (label.length > MAX_LABEL_LENGTH) {
    const hash = shortHash(sanitized);
    const keep = MAX_LABEL_LENGTH - HASH_SUFFIX_LENGTH; // 56
    label = `${label.slice(0, keep).replace(/-+$/, '')}-${hash}`;
  }

  return `${label}.${ROOT_DOMAIN}`;
}

/** Compose https URL from hostname for storefront verification. */
export function verificationUrlFor(hostname: string): string {
  return `https://${hostname}`;
}
