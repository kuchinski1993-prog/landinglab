import { describe, expect, it } from 'vitest';

import { assertVariantSource, mergeVslManifest, normalizeVslLocale } from '../variants.js';
import { VslVariantRepository } from '../variants-persistence.js';

describe('VSL-09 persistence contracts', () => {
  it('accepts only supported locales and explicit immutable sources', () => {
    expect(normalizeVslLocale('PT-br')).toBe('pt-BR');
    expect(() => normalizeVslLocale('ja')).toThrow();
    expect(() => assertVariantSource('page', 'revision', 'page')).toThrow();
  });

  it('keeps override merge isolated from immutable source manifest', () => {
    const source = { assets: { hero: 'sha-source' }, html: 'source' };
    const result = mergeVslManifest(source, { assets: { hero: 'sha-variant' } });
    expect(result.assets).toEqual({ hero: 'sha-variant' });
    expect(source.assets).toEqual({ hero: 'sha-source' });
  });

  it('persists variant, manifest, shared asset reference and GC through VSL-only SQL', async () => {
    const queries: string[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      const query = strings.join('?'); queries.push(query);
      if (query.includes('INSERT INTO vsl_variants')) return [{ id: 'variant-1', locale: 'es' }];
      if (query.includes('vsl_variant_manifest_overrides')) return [{ variant_id: 'variant-1', version: 1 }];
      if (query.includes('INSERT INTO vsl_shared_assets')) return [{ id: 'asset-1' }];
      if (query.includes('INSERT INTO vsl_variant_asset_refs')) return [{ variant_id: 'variant-1', asset_id: 'asset-1' }];
      if (query.includes('RETURNING')) return [{ id: 'asset-1' }];
      return [];
    }) as never;
    const repository = new VslVariantRepository(sql);
    await expect(repository.create({ familyId: 'family-1', pageId: 'page-es', locale: 'es', sourcePageId: 'page-en', sourceRevisionId: 'revision-1' })).resolves.toMatchObject({ id: 'variant-1' });
    await expect(repository.setManifestOverrides('variant-1', 'revision-1', { assets: { hero: 'asset-1' } })).resolves.toMatchObject({ version: 1 });
    await expect(repository.upsertAsset({ sha256: 'a'.repeat(64), storageKey: 'vsl/releases/p/asset', bytes: 12, mimeType: 'image/png' })).resolves.toMatchObject({ id: 'asset-1' });
    await expect(repository.referenceAsset('variant-1', 'asset-1', 'img/hero.png', 'img/hero.png')).resolves.toMatchObject({ asset_id: 'asset-1' });
    await expect(repository.collectGarbage()).resolves.toEqual(['asset-1']);
    expect(queries.every((query) => query.includes('vsl_'))).toBe(true);
  });

  it('does not permit traversal in asset paths at the repository boundary', async () => {
    const sql = (() => [{ id: 'asset-1' }]) as never;
    const repository = new VslVariantRepository(sql);
    await expect(repository.referenceAsset('variant-1', 'asset-1', '../hero.png', 'hero.png')).rejects.toThrow('Invalid VSL asset path');
  });
});
