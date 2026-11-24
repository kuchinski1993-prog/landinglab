// Story 17.4a · região da loja em `stores.settings` (jsonb, sem migration): moeda, idioma e fuso.
// Usado por GET/PUT /store/settings (por loja) e pelo cadastro POST /stores.
//
//   currency — GBP | EUR | USD | BRL | UYU (null limpa)
//   locale   — pt-BR | en-GB | es-UY (null limpa) — idioma da VITRINE/painel; independente de
//              `settings.atendimento.language` (17.6c), que esta story não lê nem grava.
//   timezone — IANA válido para o Intl (null limpa → padrão da Home, America/Sao_Paulo).
//              Inválido = 400; nunca "volta ao padrão" em silêncio.
import { DEFAULT_STORE_ID } from '../plugins/store.plugin.js';

import { resolveTimezone } from './home-blocks.js';

export const SUPPORTED_CURRENCIES = ['GBP', 'EUR', 'USD', 'BRL', 'UYU'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export const SUPPORTED_LOCALES = ['pt-BR', 'en-GB', 'es-UY'] as const;
export type StoreLocale = (typeof SUPPORTED_LOCALES)[number];

export const REGION_FIELDS = ['currency', 'locale', 'timezone'] as const;
export type RegionField = (typeof REGION_FIELDS)[number];

const MAX_TIMEZONE_LENGTH = 64;

export type RegionInvalidReason = 'unsupported_currency' | 'unsupported_locale' | 'invalid_timezone';

export type RegionPatchResult =
  | { ok: true; patch: Partial<Record<RegionField, string | null>> }
  | { ok: false; field: string; reason: RegionInvalidReason | 'invalid_type' };

/** Fuso IANA canônico (como o Intl o resolve) ou `null` quando inválido. */
export function canonicalTimezone(value: string): string | null {
  const tz = value.trim();
  if (tz === '' || tz.length > MAX_TIMEZONE_LENGTH) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function parseCurrency(raw: unknown): Currency | null {
  const upper = typeof raw === 'string' ? raw.toUpperCase() : null;
  return SUPPORTED_CURRENCIES.includes(upper as Currency) ? (upper as Currency) : null;
}

export function parseLocale(raw: unknown): StoreLocale | null {
  return SUPPORTED_LOCALES.includes(raw as StoreLocale) ? (raw as StoreLocale) : null;
}

/**
 * Valida os campos de região presentes em `body` (ausente = não mexe; `null` = limpa).
 * Devolve o patch normalizado (moeda em maiúsculas, fuso canônico) ou o primeiro campo inválido.
 */
export function buildRegionPatch(body: Record<string, unknown>): RegionPatchResult {
  const patch: Partial<Record<RegionField, string | null>> = {};
  for (const field of REGION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const value = body[field];
    if (value === null) {
      patch[field] = null;
      continue;
    }
    if (typeof value !== 'string') return { ok: false, field, reason: 'invalid_type' };
    if (field === 'currency') {
      const currency = parseCurrency(value);
      if (!currency) return { ok: false, field, reason: 'unsupported_currency' };
      patch.currency = currency;
    } else if (field === 'locale') {
      const locale = parseLocale(value);
      if (!locale) return { ok: false, field, reason: 'unsupported_locale' };
      patch.locale = locale;
    } else {
      const tz = canonicalTimezone(value);
      if (!tz) return { ok: false, field, reason: 'invalid_timezone' };
      patch.timezone = tz;
    }
  }
  return { ok: true, patch };
}

export interface PublicStoreSettings {
  currency: Currency | null;
  locale: StoreLocale | null;
  timezone: string;
  checkoutEnabled: boolean;
  capiEnrichedEnabled: boolean;
}

/**
 * Campos públicos de `stores.settings` (nunca o resto: policies, atendimento, pdp_*…).
 * `checkoutEnabled`: a `default` vende como hoje (true); as demais só com `settings.checkoutEnabled === true`
 * (fail-closed — ligado pela 17.8, nunca por esta story).
 */
export function pickPublicSettings(raw: unknown, storeId: string): PublicStoreSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    currency: parseCurrency(obj['currency']),
    locale: parseLocale(obj['locale']),
    timezone: resolveTimezone(obj['timezone']),
    checkoutEnabled: storeId === DEFAULT_STORE_ID ? true : obj['checkoutEnabled'] === true,
    capiEnrichedEnabled: obj['capiEnrichedEnabled'] === true,
  };
}
