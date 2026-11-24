// Schema Drizzle do VSL legacy (G1/G2) + registro de domínios.
// Espelha 0086_vsl_baseline.sql (shape real de produção): colunas, PK, UNIQUE,
// FK, CHECK e índices com os MESMOS nomes do SQL, para que drizzle-kit não
// proponha DROP/rename. O SQL é a fonte da verdade; não editar só aqui.
// O runtime usa SQL cru (packages/vsl-hosting); estas tabelas são metadata.
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type PgTableExtraConfig,
} from 'drizzle-orm/pg-core';

import {
  landingPageFamilies,
  landingPages,
  landingPageVersions,
  landingVideoAssets,
} from './schema-landinglab-core.js';

// G1 legacy — import lifecycle (VSL-03).
export const vslImports = pgTable(
  'vsl_imports',
  {
    id: uuid('id').notNull().primaryKey(),
    pageId: uuid('page_id').notNull(),
    requestKey: text('request_key').notNull(),
    requestHash: text('request_hash').notNull(),
    sourceSha256: text('source_sha256').notNull(),
    sourceKey: text('source_key').notNull(),
    sourceBytes: bigint('source_bytes', { mode: 'number' }).notNull(),
    extractedBytes: bigint('extracted_bytes', { mode: 'number' }).notNull().default(0),
    fileCount: integer('file_count').notNull().default(0),
    kind: text('kind').notNull(),
    config: jsonb('config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    entryPath: text('entry_path'),
    status: text('status').notNull().default('queued'),
    candidates: jsonb('candidates')
      .notNull()
      .default(sql`'[]'::jsonb`),
    report: jsonb('report')
      .notNull()
      .default(sql`'{}'::jsonb`),
    error: text('error'),
    fingerprint: text('fingerprint'),
    revisionId: uuid('revision_id'),
    activeAttemptId: uuid('active_attempt_id'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslImportsPageIdRequestKeyKey: unique('vsl_imports_page_id_request_key_key').on(
      t.pageId,
      t.requestKey
    ),
    vslImportsActiveAttemptIdVslImportAttemptsIdFk: foreignKey({
      name: 'vsl_imports_active_attempt_id_vsl_import_attempts_id_fk',
      columns: [t.activeAttemptId],
      foreignColumns: [vslImportAttempts.id],
    }).onDelete('set null'),
    vslImportsPageIdFkey: foreignKey({
      name: 'vsl_imports_page_id_fkey',
      columns: [t.pageId],
      foreignColumns: [landingPages.id],
    }).onDelete('cascade'),
    vslImportsRevisionIdFkey: foreignKey({
      name: 'vsl_imports_revision_id_fkey',
      columns: [t.revisionId],
      foreignColumns: [landingPageVersions.id],
    }).onDelete('restrict'),
    vslImportComplete: check(
      'vsl_import_complete',
      sql`((status = 'succeeded'::text) = (revision_id IS NOT NULL))`
    ),
    vslImportsExtractedBytesCheck: check(
      'vsl_imports_extracted_bytes_check',
      sql`(extracted_bytes >= 0)`
    ),
    vslImportsFileCountCheck: check(
      'vsl_imports_file_count_check',
      sql`((file_count >= 0) AND (file_count <= 2000))`
    ),
    vslImportsKindCheck: check(
      'vsl_imports_kind_check',
      sql`(kind = ANY (ARRAY['html'::text, 'zip'::text]))`
    ),
    vslImportsRequestKeyCheck: check(
      'vsl_imports_request_key_check',
      sql`((length(request_key) >= 1) AND (length(request_key) <= 200))`
    ),
    vslImportsSourceBytesCheck: check('vsl_imports_source_bytes_check', sql`(source_bytes > 0)`),
    vslImportsSourceSha256Check: check(
      'vsl_imports_source_sha256_check',
      sql`(source_sha256 ~ '^[0-9a-f]{64}$'::text)`
    ),
    vslImportsStatusCheck: check(
      'vsl_imports_status_check',
      sql`(status = ANY (ARRAY['queued'::text, 'validating'::text, 'extracting'::text, 'analyzing'::text, 'transforming'::text, 'awaiting_selection'::text, 'awaiting_resolution'::text, 'materializing'::text, 'verifying'::text, 'sealing'::text, 'committing'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text]))`
    ),
    vslImportsStatusLease: index('vsl_imports_status_lease').on(t.status, t.leaseUntil),
  })
);

export const vslImportAttempts = pgTable(
  'vsl_import_attempts',
  {
    id: uuid('id').notNull().primaryKey(),
    importId: uuid('import_id').notNull(),
    status: text('status').notNull(),
    error: text('error'),
    releaseId: uuid('release_id'),
    storagePrefix: text('storage_prefix'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t): PgTableExtraConfig => ({
    vslImportAttemptsImportIdFkey: foreignKey({
      name: 'vsl_import_attempts_import_id_fkey',
      columns: [t.importId],
      foreignColumns: [vslImports.id],
    }).onDelete('cascade'),
    vslImportAttemptsStatusCheck: check(
      'vsl_import_attempts_status_check',
      sql`(status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text, 'abandoned'::text]))`
    ),
    vslImportAttemptsImport: index('vsl_import_attempts_import').on(t.importId),
  })
);

export const vslReleases = pgTable(
  'vsl_releases',
  {
    id: uuid('id').notNull().primaryKey(),
    pageId: uuid('page_id').notNull(),
    importId: uuid('import_id').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    storagePrefix: text('storage_prefix').notNull(),
    manifest: jsonb('manifest').notNull(),
    sealedAt: timestamp('sealed_at', { withTimezone: true }).notNull(),
    revisionId: uuid('revision_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslReleasesPageIdFingerprintKey: unique('vsl_releases_page_id_fingerprint_key').on(
      t.pageId,
      t.fingerprint
    ),
    vslReleasesStoragePrefixKey: unique('vsl_releases_storage_prefix_key').on(t.storagePrefix),
    vslReleasesAttemptIdFkey: foreignKey({
      name: 'vsl_releases_attempt_id_fkey',
      columns: [t.attemptId],
      foreignColumns: [vslImportAttempts.id],
    }).onDelete('restrict'),
    vslReleasesImportIdFkey: foreignKey({
      name: 'vsl_releases_import_id_fkey',
      columns: [t.importId],
      foreignColumns: [vslImports.id],
    }).onDelete('restrict'),
    vslReleasesPageIdFkey: foreignKey({
      name: 'vsl_releases_page_id_fkey',
      columns: [t.pageId],
      foreignColumns: [landingPages.id],
    }).onDelete('cascade'),
    vslReleasesRevisionIdFkey: foreignKey({
      name: 'vsl_releases_revision_id_fkey',
      columns: [t.revisionId],
      foreignColumns: [landingPageVersions.id],
    }).onDelete('restrict'),
    vslReleasesFingerprintCheck: check(
      'vsl_releases_fingerprint_check',
      sql`(fingerprint ~ '^[0-9a-f]{64}$'::text)`
    ),
    vslReleasesRevision: uniqueIndex('vsl_releases_revision')
      .on(t.revisionId)
      .where(sql`revision_id IS NOT NULL`),
  })
);

export const vslPreviewSessions = pgTable(
  'vsl_preview_sessions',
  {
    id: uuid('id').notNull().primaryKey(),
    grantHash: text('grant_hash').notNull(),
    state: text('state').notNull().default('pending'),
    originId: text('origin_id').notNull(),
    origin: text('origin').notNull(),
    pageId: uuid('page_id').notNull(),
    revisionId: uuid('revision_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    hardExpiresAt: timestamp('hard_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslPreviewSessionsGrantHashKey: unique('vsl_preview_sessions_grant_hash_key').on(t.grantHash),
    vslPreviewSessionsOriginIdKey: unique('vsl_preview_sessions_origin_id_key').on(t.originId),
    vslPreviewSessionsOriginKey: unique('vsl_preview_sessions_origin_key').on(t.origin),
    vslPreviewSessionsPageIdFkey: foreignKey({
      name: 'vsl_preview_sessions_page_id_fkey',
      columns: [t.pageId],
      foreignColumns: [landingPages.id],
    }).onDelete('cascade'),
    vslPreviewSessionsRevisionIdFkey: foreignKey({
      name: 'vsl_preview_sessions_revision_id_fkey',
      columns: [t.revisionId],
      foreignColumns: [landingPageVersions.id],
    }).onDelete('cascade'),
    vslPreviewLease: check('vsl_preview_lease', sql`(expires_at <= hard_expires_at)`),
    vslPreviewSessionsGrantHashCheck: check(
      'vsl_preview_sessions_grant_hash_check',
      sql`(grant_hash ~ '^[0-9a-f]{64}$'::text)`
    ),
    vslPreviewSessionsOriginIdCheck: check(
      'vsl_preview_sessions_origin_id_check',
      sql`(origin_id ~ '^[0-9a-f]{32}$'::text)`
    ),
    vslPreviewSessionsStateCheck: check(
      'vsl_preview_sessions_state_check',
      sql`(state = ANY (ARRAY['pending'::text, 'active'::text, 'revoked'::text]))`
    ),
    vslPreviewSessionsExpiry: index('vsl_preview_sessions_expiry').on(t.expiresAt),
  })
);

// G1 legacy — Stream uploads (VSL-04); separado da projeção landing_video_assets.
export const vslVideoUploads = pgTable(
  'vsl_video_uploads',
  {
    id: uuid('id').notNull().primaryKey(),
    pageId: uuid('page_id').notNull(),
    requestKey: text('request_key').notNull(),
    requestHash: text('request_hash').notNull(),
    declaredBytes: bigint('declared_bytes', { mode: 'number' }).notNull(),
    sourceSha256: text('source_sha256').notNull(),
    mimeType: text('mime_type').notNull(),
    state: text('state').notNull().default('requested'),
    providerId: text('provider_id'),
    providerModifiedAt: timestamp('provider_modified_at', { withTimezone: true }),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    errorCode: text('error_code'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslVideoUploadsPageIdRequestKeyKey: unique('vsl_video_uploads_page_id_request_key_key').on(
      t.pageId,
      t.requestKey
    ),
    vslVideoUploadsProviderIdKey: unique('vsl_video_uploads_provider_id_key').on(t.providerId),
    vslVideoUploadsIdFkey: foreignKey({
      name: 'vsl_video_uploads_id_fkey',
      columns: [t.id],
      foreignColumns: [landingVideoAssets.id],
    }).onDelete('restrict'),
    vslVideoUploadsPageIdFkey: foreignKey({
      name: 'vsl_video_uploads_page_id_fkey',
      columns: [t.pageId],
      foreignColumns: [landingPages.id],
    }).onDelete('restrict'),
    vslVideoUploadsDeclaredBytesCheck: check(
      'vsl_video_uploads_declared_bytes_check',
      sql`((declared_bytes >= 1) AND (declared_bytes <= '5000000000'::bigint))`
    ),
    vslVideoUploadsMimeTypeCheck: check(
      'vsl_video_uploads_mime_type_check',
      sql`(mime_type = ANY (ARRAY['video/mp4'::text, 'video/quicktime'::text, 'video/webm'::text]))`
    ),
    vslVideoUploadsProviderIdCheck: check(
      'vsl_video_uploads_provider_id_check',
      sql`(provider_id ~ '^[0-9a-f]{32}$'::text)`
    ),
    vslVideoUploadsRequestKeyCheck: check(
      'vsl_video_uploads_request_key_check',
      sql`((length(request_key) >= 1) AND (length(request_key) <= 200))`
    ),
    vslVideoUploadsSourceSha256Check: check(
      'vsl_video_uploads_source_sha256_check',
      sql`(source_sha256 ~ '^[0-9a-f]{64}$'::text)`
    ),
    vslVideoUploadsStateCheck: check(
      'vsl_video_uploads_state_check',
      sql`(state = ANY (ARRAY['requested'::text, 'provisioning'::text, 'provisioning_uncertain'::text, 'uploading'::text, 'uploaded'::text, 'processing'::text, 'ready'::text, 'failed'::text, 'policy_rejected'::text, 'delete_pending'::text, 'deleted'::text]))`
    ),
    vslVideoUploadsState: index('vsl_video_uploads_state').on(t.state, t.updatedAt),
  })
);

export const vslStreamEvents = pgTable(
  'vsl_stream_events',
  {
    bodyHash: text('body_hash').notNull().primaryKey(),
    videoId: uuid('video_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslStreamEventsVideoIdFkey: foreignKey({
      name: 'vsl_stream_events_video_id_fkey',
      columns: [t.videoId],
      foreignColumns: [vslVideoUploads.id],
    }).onDelete('restrict'),
    vslStreamEventsBodyHashCheck: check(
      'vsl_stream_events_body_hash_check',
      sql`(body_hash ~ '^[0-9a-f]{64}$'::text)`
    ),
  })
);

export const vslVideoReferences = pgTable(
  'vsl_video_references',
  {
    id: uuid('id').notNull().primaryKey(),
    videoId: uuid('video_id').notNull(),
    pageId: uuid('page_id').notNull(),
    revisionId: uuid('revision_id'),
    kind: text('kind').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslVideoReferencesPageIdFkey: foreignKey({
      name: 'vsl_video_references_page_id_fkey',
      columns: [t.pageId],
      foreignColumns: [landingPages.id],
    }).onDelete('restrict'),
    vslVideoReferencesRevisionIdFkey: foreignKey({
      name: 'vsl_video_references_revision_id_fkey',
      columns: [t.revisionId],
      foreignColumns: [landingPageVersions.id],
    }).onDelete('restrict'),
    vslVideoReferencesVideoIdFkey: foreignKey({
      name: 'vsl_video_references_video_id_fkey',
      columns: [t.videoId],
      foreignColumns: [vslVideoUploads.id],
    }).onDelete('restrict'),
    vslVideoReferencesCheck: check(
      'vsl_video_references_check',
      sql`((kind = 'revision'::text) = (revision_id IS NOT NULL))`
    ),
    vslVideoReferencesKindCheck: check(
      'vsl_video_references_kind_check',
      sql`(kind = ANY (ARRAY['draft'::text, 'revision'::text]))`
    ),
    vslVideoReferenceDraft: uniqueIndex('vsl_video_reference_draft')
      .on(t.pageId)
      .where(sql`kind = 'draft'::text`),
    vslVideoReferenceRevision: uniqueIndex('vsl_video_reference_revision')
      .on(t.revisionId, t.videoId)
      .where(sql`kind = 'revision'::text`),
  })
);

// G1 legacy — domínio/publicação (sem runtime).
export const vslDomains = pgTable(
  'vsl_domains',
  {
    id: uuid('id').notNull().primaryKey(),
    pageId: uuid('page_id').notNull(),
    hostname: text('hostname').notNull(),
    dnsStatus: text('dns_status').notNull().default('pending_dns'),
    sslStatus: text('ssl_status').notNull().default('pending'),
    publicationStatus: text('publication_status').notNull().default('unpublished'),
    expectedUpdatedAt: timestamp('expected_updated_at', { withTimezone: true }),
    lastError: text('last_error'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslDomainsHostnameKey: unique('vsl_domains_hostname_key').on(t.hostname),
    vslDomainsPageIdFkey: foreignKey({
      name: 'vsl_domains_page_id_fkey',
      columns: [t.pageId],
      foreignColumns: [landingPages.id],
    }).onDelete('restrict'),
    vslDomainsDnsStatusCheck: check(
      'vsl_domains_dns_status_check',
      sql`(dns_status = ANY (ARRAY['pending_dns'::text, 'pending_verification'::text, 'verified'::text, 'error'::text]))`
    ),
    vslDomainsHostnameCheck: check(
      'vsl_domains_hostname_check',
      sql`((hostname = lower(hostname)) AND (hostname !~ '[/:?#]'::text))`
    ),
    vslDomainsPublicationStatusCheck: check(
      'vsl_domains_publication_status_check',
      sql`(publication_status = ANY (ARRAY['unpublished'::text, 'publishing'::text, 'published'::text, 'error'::text]))`
    ),
    vslDomainsSslStatusCheck: check(
      'vsl_domains_ssl_status_check',
      sql`(ssl_status = ANY (ARRAY['pending'::text, 'provisioning'::text, 'provisioned'::text, 'error'::text]))`
    ),
    vslDomainsPageActive: uniqueIndex('vsl_domains_page_active')
      .on(t.pageId)
      .where(sql`publication_status = 'published'::text`),
  })
);

export const vslPublications = pgTable(
  'vsl_publications',
  {
    id: uuid('id').notNull().primaryKey(),
    pageId: uuid('page_id').notNull(),
    domainId: uuid('domain_id').notNull(),
    revisionId: uuid('revision_id').notNull(),
    cacheVersion: bigint('cache_version', { mode: 'number' }).notNull().default(1),
    status: text('status').notNull().default('published'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslPublicationsPageIdRevisionIdKey: unique('vsl_publications_page_id_revision_id_key').on(
      t.pageId,
      t.revisionId
    ),
    vslPublicationsDomainIdFkey: foreignKey({
      name: 'vsl_publications_domain_id_fkey',
      columns: [t.domainId],
      foreignColumns: [vslDomains.id],
    }).onDelete('restrict'),
    vslPublicationsPageIdFkey: foreignKey({
      name: 'vsl_publications_page_id_fkey',
      columns: [t.pageId],
      foreignColumns: [landingPages.id],
    }).onDelete('restrict'),
    vslPublicationsRevisionIdFkey: foreignKey({
      name: 'vsl_publications_revision_id_fkey',
      columns: [t.revisionId],
      foreignColumns: [landingPageVersions.id],
    }).onDelete('restrict'),
    vslPublicationsStatusCheck: check(
      'vsl_publications_status_check',
      sql`(status = ANY (ARRAY['published'::text, 'unpublished'::text]))`
    ),
  })
);

export const vslCacheInvalidations = pgTable(
  'vsl_cache_invalidations',
  {
    id: uuid('id').notNull().primaryKey(),
    pageId: uuid('page_id').notNull(),
    domainId: uuid('domain_id'),
    cacheKey: text('cache_key').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslCacheInvalidationsDomainIdFkey: foreignKey({
      name: 'vsl_cache_invalidations_domain_id_fkey',
      columns: [t.domainId],
      foreignColumns: [vslDomains.id],
    }).onDelete('restrict'),
    vslCacheInvalidationsPageIdFkey: foreignKey({
      name: 'vsl_cache_invalidations_page_id_fkey',
      columns: [t.pageId],
      foreignColumns: [landingPages.id],
    }).onDelete('restrict'),
  })
);

// G2 legacy — variantes por locale e assets compartilhados (VSL-09).
export const vslVariants = pgTable(
  'vsl_variants',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    familyId: uuid('family_id').notNull(),
    pageId: uuid('page_id').notNull(),
    locale: text('locale').notNull(),
    sourcePageId: uuid('source_page_id').notNull(),
    sourceRevisionId: uuid('source_revision_id').notNull(),
    config: jsonb('config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    expectedUpdatedAt: timestamp('expected_updated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslVariantsFamilyIdLocaleKey: unique('vsl_variants_family_id_locale_key').on(
      t.familyId,
      t.locale
    ),
    vslVariantsPageIdKey: unique('vsl_variants_page_id_key').on(t.pageId),
    vslVariantsFamilyIdFkey: foreignKey({
      name: 'vsl_variants_family_id_fkey',
      columns: [t.familyId],
      foreignColumns: [landingPageFamilies.id],
    }).onDelete('restrict'),
    vslVariantsPageIdFkey: foreignKey({
      name: 'vsl_variants_page_id_fkey',
      columns: [t.pageId],
      foreignColumns: [landingPages.id],
    }).onDelete('restrict'),
    vslVariantsSourcePageIdFkey: foreignKey({
      name: 'vsl_variants_source_page_id_fkey',
      columns: [t.sourcePageId],
      foreignColumns: [landingPages.id],
    }).onDelete('restrict'),
    vslVariantsSourceRevisionIdFkey: foreignKey({
      name: 'vsl_variants_source_revision_id_fkey',
      columns: [t.sourceRevisionId],
      foreignColumns: [landingPageVersions.id],
    }).onDelete('restrict'),
    vslVariantsLocaleCheck: check(
      'vsl_variants_locale_check',
      sql`(locale = ANY (ARRAY['pt-BR'::text, 'es'::text, 'en'::text, 'it'::text, 'de'::text, 'fr'::text]))`
    ),
    vslVariantsSourceRevisionIdx: index('vsl_variants_source_revision_idx').on(t.sourceRevisionId),
  })
);

export const vslVariantManifestOverrides = pgTable(
  'vsl_variant_manifest_overrides',
  {
    variantId: uuid('variant_id').notNull().primaryKey(),
    baseRevisionId: uuid('base_revision_id').notNull(),
    overrides: jsonb('overrides')
      .notNull()
      .default(sql`'{}'::jsonb`),
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslVariantManifestOverridesBaseRevisionIdFkey: foreignKey({
      name: 'vsl_variant_manifest_overrides_base_revision_id_fkey',
      columns: [t.baseRevisionId],
      foreignColumns: [landingPageVersions.id],
    }).onDelete('restrict'),
    vslVariantManifestOverridesVariantIdFkey: foreignKey({
      name: 'vsl_variant_manifest_overrides_variant_id_fkey',
      columns: [t.variantId],
      foreignColumns: [vslVariants.id],
    }).onDelete('cascade'),
    vslVariantManifestOverridesVersionCheck: check(
      'vsl_variant_manifest_overrides_version_check',
      sql`(version > 0)`
    ),
  })
);

export const vslSharedAssets = pgTable(
  'vsl_shared_assets',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    mimeType: text('mime_type').notNull(),
    state: text('state').notNull().default('active'),
    gcAfter: timestamp('gc_after', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslSharedAssetsSha256StorageKeyKey: unique('vsl_shared_assets_sha256_storage_key_key').on(
      t.sha256,
      t.storageKey
    ),
    vslSharedAssetsStorageKeyKey: unique('vsl_shared_assets_storage_key_key').on(t.storageKey),
    vslSharedAssetsBytesCheck: check('vsl_shared_assets_bytes_check', sql`(bytes > 0)`),
    vslSharedAssetsSha256Check: check(
      'vsl_shared_assets_sha256_check',
      sql`(sha256 ~ '^[0-9a-f]{64}$'::text)`
    ),
    vslSharedAssetsStateCheck: check(
      'vsl_shared_assets_state_check',
      sql`(state = ANY (ARRAY['active'::text, 'pending_delete'::text, 'deleted'::text]))`
    ),
  })
);

export const vslVariantAssetRefs = pgTable(
  'vsl_variant_asset_refs',
  {
    variantId: uuid('variant_id').notNull(),
    assetId: uuid('asset_id').notNull(),
    sourcePath: text('source_path').notNull(),
    manifestPath: text('manifest_path').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    pk: primaryKey({ name: 'vsl_variant_asset_refs_pkey', columns: [t.variantId, t.sourcePath] }),
    vslVariantAssetRefsVariantIdManifestPathKey: unique(
      'vsl_variant_asset_refs_variant_id_manifest_path_key'
    ).on(t.variantId, t.manifestPath),
    vslVariantAssetRefsAssetIdFkey: foreignKey({
      name: 'vsl_variant_asset_refs_asset_id_fkey',
      columns: [t.assetId],
      foreignColumns: [vslSharedAssets.id],
    }).onDelete('restrict'),
    vslVariantAssetRefsVariantIdFkey: foreignKey({
      name: 'vsl_variant_asset_refs_variant_id_fkey',
      columns: [t.variantId],
      foreignColumns: [vslVariants.id],
    }).onDelete('cascade'),
    vslVariantAssetRefsAssetIdx: index('vsl_variant_asset_refs_asset_idx').on(t.assetId),
  })
);

export const vslAssetGcJobs = pgTable(
  'vsl_asset_gc_jobs',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    assetId: uuid('asset_id').notNull(),
    status: text('status').notNull().default('pending'),
    notBefore: timestamp('not_before', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslAssetGcJobsAssetIdStatusKey: unique('vsl_asset_gc_jobs_asset_id_status_key').on(
      t.assetId,
      t.status
    ),
    vslAssetGcJobsAssetIdFkey: foreignKey({
      name: 'vsl_asset_gc_jobs_asset_id_fkey',
      columns: [t.assetId],
      foreignColumns: [vslSharedAssets.id],
    }).onDelete('restrict'),
    vslAssetGcJobsStatusCheck: check(
      'vsl_asset_gc_jobs_status_check',
      sql`(status = ANY (ARRAY['pending'::text, 'deleted'::text, 'cancelled'::text]))`
    ),
  })
);

// G2 legacy — tradução (VSL-10/11).
export const vslTranslationBatches = pgTable(
  'vsl_translation_batches',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    variantId: uuid('variant_id').notNull(),
    sourceRevisionId: uuid('source_revision_id').notNull(),
    sourceHash: text('source_hash').notNull(),
    targetLocale: text('target_locale').notNull(),
    status: text('status').notNull().default('extracted'),
    report: jsonb('report')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslTranslationBatchesSourceRevisionIdFkey: foreignKey({
      name: 'vsl_translation_batches_source_revision_id_fkey',
      columns: [t.sourceRevisionId],
      foreignColumns: [landingPageVersions.id],
    }).onDelete('restrict'),
    vslTranslationBatchesVariantIdFkey: foreignKey({
      name: 'vsl_translation_batches_variant_id_fkey',
      columns: [t.variantId],
      foreignColumns: [vslVariants.id],
    }).onDelete('restrict'),
    vslTranslationBatchesSourceHashCheck: check(
      'vsl_translation_batches_source_hash_check',
      sql`(source_hash ~ '^[0-9a-f]{64}$'::text)`
    ),
    vslTranslationBatchesStatusCheck: check(
      'vsl_translation_batches_status_check',
      sql`(status = ANY (ARRAY['extracted'::text, 'translating'::text, 'review'::text, 'stale'::text, 'failed'::text]))`
    ),
    vslTranslationBatchesVariantIdx: index('vsl_translation_batches_variant_idx').on(
      t.variantId,
      t.createdAt.desc().nullsFirst()
    ),
  })
);

export const vslTranslationUnits = pgTable(
  'vsl_translation_units',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    batchId: uuid('batch_id').notNull(),
    unitKey: text('unit_key').notNull(),
    sourceHash: text('source_hash').notNull(),
    locator: jsonb('locator').notNull(),
    extractionType: text('extraction_type').notNull(),
    attribute: text('attribute'),
    original: text('original').notNull(),
    context: text('context').notNull().default(''),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslTranslationUnitsBatchIdUnitKeyKey: unique('vsl_translation_units_batch_id_unit_key_key').on(
      t.batchId,
      t.unitKey
    ),
    vslTranslationUnitsBatchIdFkey: foreignKey({
      name: 'vsl_translation_units_batch_id_fkey',
      columns: [t.batchId],
      foreignColumns: [vslTranslationBatches.id],
    }).onDelete('cascade'),
    vslTranslationUnitsStatusCheck: check(
      'vsl_translation_units_status_check',
      sql`(status = ANY (ARRAY['pending'::text, 'translated'::text, 'reviewed'::text, 'approved'::text, 'rejected'::text, 'stale'::text]))`
    ),
  })
);

export const vslTranslationReviews = pgTable(
  'vsl_translation_reviews',
  {
    unitId: uuid('unit_id').notNull().primaryKey(),
    sourceHash: text('source_hash').notNull(),
    proposed: text('proposed'),
    edited: text('edited'),
    status: text('status').notNull().default('pending'),
    lockedBy: text('locked_by'),
    version: integer('version').notNull().default(1),
    audit: jsonb('audit')
      .notNull()
      .default(sql`'[]'::jsonb`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslTranslationReviewsUnitIdFkey: foreignKey({
      name: 'vsl_translation_reviews_unit_id_fkey',
      columns: [t.unitId],
      foreignColumns: [vslTranslationUnits.id],
    }).onDelete('cascade'),
    vslTranslationReviewsStatusCheck: check(
      'vsl_translation_reviews_status_check',
      sql`(status = ANY (ARRAY['pending'::text, 'translated'::text, 'reviewed'::text, 'approved'::text, 'rejected'::text]))`
    ),
  })
);

// Registro neutro de domínios BlackShop (fonte do VSL G3). Bindings G2 abaixo.
export const blackshopDomains = pgTable(
  'blackshop_domains',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    hostname: text('hostname').notNull(),
    registrar: text('registrar'),
    registrarMetadata: jsonb('registrar_metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    dnsStatus: text('dns_status').notNull().default('unknown'),
    sslStatus: text('ssl_status').notNull().default('unknown'),
    lifecycleStatus: text('lifecycle_status').notNull().default('registered'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // 0088: resultado do "Verificar agora" (DNS/health/Vercel).
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastCheck: jsonb('last_check')
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t): PgTableExtraConfig => ({
    blackshopDomainsHostnameUnique: unique('blackshop_domains_hostname_unique').on(t.hostname),
    blackshopDomainsDnsStatusCheck: check(
      'blackshop_domains_dns_status_check',
      sql`(dns_status = ANY (ARRAY['unknown'::text, 'pending'::text, 'verified'::text, 'failed'::text]))`
    ),
    blackshopDomainsLifecycleCheck: check(
      'blackshop_domains_lifecycle_check',
      sql`(lifecycle_status = ANY (ARRAY['registered'::text, 'active'::text, 'suspended'::text, 'expired'::text, 'archived'::text]))`
    ),
    blackshopDomainsSslStatusCheck: check(
      'blackshop_domains_ssl_status_check',
      sql`(ssl_status = ANY (ARRAY['unknown'::text, 'pending'::text, 'provisioned'::text, 'failed'::text]))`
    ),
    blackshopDomainsLifecycleIdx: index('blackshop_domains_lifecycle_idx').on(
      t.lifecycleStatus,
      t.hostname
    ),
  })
);

export const vslDomainBindings = pgTable(
  'vsl_domain_bindings',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    domainId: uuid('domain_id').notNull(),
    pageId: uuid('page_id').notNull(),
    revisionId: uuid('revision_id'),
    pathname: text('pathname').notNull(),
    normalizedPathname: text('normalized_pathname').notNull(),
    publicationStatus: text('publication_status').notNull().default('draft'),
    cacheVersion: integer('cache_version').notNull().default(1),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslDomainBindingsDomainPathUnique: unique('vsl_domain_bindings_domain_path_unique').on(
      t.domainId,
      t.normalizedPathname
    ),
    vslDomainBindingsDomainIdFkey: foreignKey({
      name: 'vsl_domain_bindings_domain_id_fkey',
      columns: [t.domainId],
      foreignColumns: [blackshopDomains.id],
    }).onDelete('restrict'),
    vslDomainBindingsPageIdFkey: foreignKey({
      name: 'vsl_domain_bindings_page_id_fkey',
      columns: [t.pageId],
      foreignColumns: [landingPages.id],
    }).onDelete('restrict'),
    vslDomainBindingsRevisionIdFkey: foreignKey({
      name: 'vsl_domain_bindings_revision_id_fkey',
      columns: [t.revisionId],
      foreignColumns: [landingPageVersions.id],
    }).onDelete('restrict'),
    vslDomainBindingsStatusCheck: check(
      'vsl_domain_bindings_status_check',
      sql`(publication_status = ANY (ARRAY['draft'::text, 'pending'::text, 'published'::text, 'rolled_back'::text, 'disabled'::text]))`
    ),
    vslDomainBindingsHostPathIdx: index('vsl_domain_bindings_host_path_idx').on(
      t.domainId,
      t.normalizedPathname,
      t.publicationStatus
    ),
    vslDomainBindingsPageIdx: index('vsl_domain_bindings_page_idx').on(
      t.pageId,
      t.updatedAt.desc().nullsFirst()
    ),
  })
);

export const vslDomainPublicationEvents = pgTable(
  'vsl_domain_publication_events',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    bindingId: uuid('binding_id').notNull(),
    fromRevisionId: uuid('from_revision_id'),
    toRevisionId: uuid('to_revision_id'),
    eventType: text('event_type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslDomainPublicationEventsBindingIdFkey: foreignKey({
      name: 'vsl_domain_publication_events_binding_id_fkey',
      columns: [t.bindingId],
      foreignColumns: [vslDomainBindings.id],
    }).onDelete('cascade'),
    vslDomainPublicationEventsFromRevisionIdFkey: foreignKey({
      name: 'vsl_domain_publication_events_from_revision_id_fkey',
      columns: [t.fromRevisionId],
      foreignColumns: [landingPageVersions.id],
    }).onDelete('restrict'),
    vslDomainPublicationEventsToRevisionIdFkey: foreignKey({
      name: 'vsl_domain_publication_events_to_revision_id_fkey',
      columns: [t.toRevisionId],
      foreignColumns: [landingPageVersions.id],
    }).onDelete('restrict'),
    vslDomainPublicationEventsBindingIdx: index('vsl_domain_publication_events_binding_idx').on(
      t.bindingId,
      t.createdAt.desc().nullsFirst()
    ),
  })
);
