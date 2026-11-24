import type { ImportConfig } from './analysis.js';
import { validateExternalHttps } from './funnel-config.js';
import { parsePublicHttpUrl } from './safe-fetch.js';
class InvalidVslConfig extends Error {
  readonly statusCode = 400;
}
export function validateImportConfig(value: unknown): ImportConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InvalidVslConfig('Invalid VSL configuration');
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).some(
      (k) =>
        !['entryPath', 'videoSelector', 'ctaSelectors', 'offerSelectors', 'resolutions', 'requiredTargets', 'allowForms', 'assetBasePath', 'externalOrigins', 'sourceUrl'].includes(k)
    )
  )
    throw new InvalidVslConfig('Unknown VSL configuration field');
  for (const key of ['entryPath', 'videoSelector'])
    if (
      object[key] !== undefined &&
      (typeof object[key] !== 'string' ||
        !(object[key] as string).trim() ||
        (object[key] as string).length > 1024)
    )
      throw new InvalidVslConfig('Invalid VSL selector/entry');
  for (const key of ['ctaSelectors', 'offerSelectors'])
    if (
      object[key] !== undefined &&
      (!Array.isArray(object[key]) ||
        (object[key] as unknown[]).length > 50 ||
        (object[key] as unknown[]).some(
          (v) => typeof v !== 'string' || !v.trim() || v.length > 200
        ))
    )
      throw new InvalidVslConfig('Invalid VSL selectors');
  if (object.requiredTargets !== undefined &&
    (!Array.isArray(object.requiredTargets) ||
      new Set(object.requiredTargets).size !== object.requiredTargets.length ||
      object.requiredTargets.some((target: unknown) => !['video', 'offer', 'checkout'].includes(String(target)))))
    throw new InvalidVslConfig('Invalid required targets');
  if (object.allowForms !== undefined && typeof object.allowForms !== 'boolean')
    throw new InvalidVslConfig('Invalid form policy');
  if (object.assetBasePath !== undefined &&
    (typeof object.assetBasePath !== 'string' || !/^\/__vsl\/assets\/[0-9a-f-]{36}\/$/.test(object.assetBasePath)))
    throw new InvalidVslConfig('Invalid asset base path');
  if (object.externalOrigins !== undefined && (!Array.isArray(object.externalOrigins) || object.externalOrigins.length > 20 ||
    new Set(object.externalOrigins).size !== object.externalOrigins.length || object.externalOrigins.some((origin: unknown) => {
      if (typeof origin !== 'string') return true;
      try { const url = validateExternalHttps(origin); return url.origin !== origin || url.port !== ''; }
      catch { return true; }
    }))) throw new InvalidVslConfig('Invalid external origin allowlist');
  if (object.sourceUrl !== undefined) {
    if (typeof object.sourceUrl !== 'string' || object.sourceUrl.length > 2048) throw new InvalidVslConfig('Invalid source URL');
    try { object.sourceUrl = parsePublicHttpUrl(object.sourceUrl).href; }
    catch { throw new InvalidVslConfig('Invalid source URL'); }
  }
  if (object.resolutions !== undefined) {
    if (
      !object.resolutions ||
      typeof object.resolutions !== 'object' ||
      Array.isArray(object.resolutions) ||
      Object.keys(object.resolutions).length > 200 ||
      Object.entries(object.resolutions).some(
        ([k, v]) =>
          !/^\w{24}$/.test(k) || typeof v !== 'string' || v.trim().length < 8 || v.length > 2000
      )
    )
      throw new InvalidVslConfig('Invalid VSL resolution');
  }
  const config = JSON.parse(JSON.stringify(object)) as ImportConfig;
  if (config.entryPath) config.entryPath = config.entryPath.trim();
  if (config.videoSelector) config.videoSelector = config.videoSelector.trim();
  for (const key of ['ctaSelectors', 'offerSelectors'] as const)
    if (config[key]) config[key] = config[key]!.map((s) => s.trim());
  if (config.resolutions)
    config.resolutions = Object.fromEntries(
      Object.entries(config.resolutions).map(([key, value]) => [key, value.trim()])
    );
  return config;
}
