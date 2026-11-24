import { randomUUID } from 'node:crypto';

import type { Sql } from 'postgres';

import { assertVariantSource, normalizeVslLocale, type VslLocale } from './variants.js';

export type VariantInput = { familyId: string; pageId: string; locale: string; sourcePageId: string; sourceRevisionId: string; config?: Record<string, unknown> };
export type AssetInput = { sha256: string; storageKey: string; bytes: number; mimeType: string };

function json(value: unknown): string { return JSON.stringify(value ?? {}); }
function assertHash(value: string): void { if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid VSL asset SHA-256'); }
function assertPath(value: string): void { if (!value || value.startsWith('/') || value.includes('..') || value.includes('\\')) throw new Error('Invalid VSL asset path'); }

export class VslVariantRepository {
  constructor(private readonly sql: Sql) {}

  async list(familyId: string): Promise<unknown[]> { return Array.from(await this.sql`SELECT * FROM vsl_variants WHERE family_id=${familyId} ORDER BY locale`); }
  async get(id: string): Promise<unknown | null> { const [row] = await this.sql`SELECT * FROM vsl_variants WHERE id=${id}`; return row ?? null; }

  async create(input: VariantInput): Promise<unknown> {
    const locale: VslLocale = normalizeVslLocale(input.locale);
    assertVariantSource(input.sourcePageId, input.sourceRevisionId, input.pageId);
    const [row] = await this.sql`
      INSERT INTO vsl_variants(id,family_id,page_id,locale,source_page_id,source_revision_id,config)
      SELECT ${randomUUID()}, ${input.familyId}, ${input.pageId}, ${locale}, ${input.sourcePageId}, ${input.sourceRevisionId}, ${json(input.config)}::jsonb
      WHERE EXISTS (SELECT 1 FROM landing_pages p WHERE p.id=${input.pageId} AND p.family_id=${input.familyId} AND p.locale=${locale} AND p.content_mode='hosted')
        AND EXISTS (SELECT 1 FROM landing_page_versions v WHERE v.id=${input.sourceRevisionId} AND v.landing_page_id=${input.sourcePageId})
      ON CONFLICT (family_id,locale) DO NOTHING RETURNING *`;
    if (row) return row;
    const [existing] = await this.sql`SELECT * FROM vsl_variants WHERE family_id=${input.familyId} AND locale=${locale}`;
    if (existing) return existing;
    throw new Error('VSL variant relationships are invalid');
  }

  async update(id: string, config: Record<string, unknown>, expectedUpdatedAt?: string): Promise<unknown> {
    const [row] = await this.sql`UPDATE vsl_variants SET config=${json(config)}::jsonb,updated_at=now() WHERE id=${id} AND (${expectedUpdatedAt ?? null}::timestamptz IS NULL OR updated_at=${expectedUpdatedAt ?? null}::timestamptz) RETURNING *`;
    if (!row) throw new Error('VSL variant concurrency conflict or not found');
    return row;
  }

  async setManifestOverrides(id: string, baseRevisionId: string, overrides: Record<string, unknown>, expectedVersion?: number): Promise<unknown> {
    const [row] = await this.sql`
      INSERT INTO vsl_variant_manifest_overrides(variant_id,base_revision_id,overrides,version)
      SELECT ${id},${baseRevisionId},${json(overrides)}::jsonb,1
      WHERE EXISTS (SELECT 1 FROM vsl_variants v WHERE v.id=${id} AND EXISTS (SELECT 1 FROM landing_page_versions r WHERE r.id=${baseRevisionId} AND r.landing_page_id=v.source_page_id))
      ON CONFLICT (variant_id) DO UPDATE SET base_revision_id=EXCLUDED.base_revision_id,overrides=EXCLUDED.overrides,version=vsl_variant_manifest_overrides.version+1,updated_at=now()
      WHERE ${expectedVersion ?? null}::integer IS NULL OR vsl_variant_manifest_overrides.version=${expectedVersion ?? null}
      RETURNING *`;
    if (!row) throw new Error('Invalid base revision or manifest concurrency conflict');
    return row;
  }

  async upsertAsset(input: AssetInput): Promise<unknown> {
    assertHash(input.sha256); if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0) throw new Error('Invalid VSL asset size');
    const [row] = await this.sql`INSERT INTO vsl_shared_assets(id,sha256,storage_key,bytes,mime_type) VALUES(${randomUUID()},${input.sha256},${input.storageKey},${input.bytes},${input.mimeType}) ON CONFLICT(storage_key) DO UPDATE SET updated_at=now(),state='active' RETURNING *`;
    return row;
  }

  async referenceAsset(variantId: string, assetId: string, sourcePath: string, manifestPath: string): Promise<unknown> {
    assertPath(sourcePath); assertPath(manifestPath);
    const [row] = await this.sql`INSERT INTO vsl_variant_asset_refs(variant_id,asset_id,source_path,manifest_path) VALUES(${variantId},${assetId},${sourcePath},${manifestPath}) ON CONFLICT(variant_id,source_path) DO UPDATE SET asset_id=EXCLUDED.asset_id,manifest_path=EXCLUDED.manifest_path RETURNING *`;
    if (!row) throw new Error('VSL variant or asset not found');
    return row;
  }

  async scheduleGarbageCollection(assetId: string): Promise<void> {
    await this.sql`UPDATE vsl_shared_assets SET state='pending_delete',gc_after=now()+interval '24 hours',updated_at=now() WHERE id=${assetId} AND NOT EXISTS (SELECT 1 FROM vsl_variant_asset_refs WHERE asset_id=${assetId})`;
    await this.sql`INSERT INTO vsl_asset_gc_jobs(asset_id,not_before) SELECT ${assetId},now()+interval '24 hours' WHERE NOT EXISTS (SELECT 1 FROM vsl_variant_asset_refs WHERE asset_id=${assetId}) ON CONFLICT DO NOTHING`;
  }

  async collectGarbage(now = new Date()): Promise<string[]> {
    const rows = await this.sql`UPDATE vsl_shared_assets a SET state='deleted',updated_at=now() WHERE a.state='pending_delete' AND a.gc_after <= ${now} AND NOT EXISTS (SELECT 1 FROM vsl_variant_asset_refs r WHERE r.asset_id=a.id) RETURNING a.id`;
    return rows.map((row) => String(row.id));
  }
}
