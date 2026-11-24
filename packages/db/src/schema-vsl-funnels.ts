// Schema Drizzle dos funis VSL (G3): projetos, etapas, páginas, vídeos,
// releases, rotas públicas, analytics e ponte legacy.
// Espelha 0086_vsl_baseline.sql com os MESMOS nomes de constraints/índices.
// O SQL é a fonte da verdade; não editar só aqui. FKs marcadas DEFERRABLE no SQL
// (vsl_pages_current_revision_owner, vsl_projects_active_release_fk,
// vsl_steps_next_same_project) não têm esse atributo no Drizzle 0.36.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type PgTableExtraConfig,
} from 'drizzle-orm/pg-core';

import { landingPages, landingPageVersions, landingVideoAssets } from './schema-landinglab-core.js';
import { blackshopDomains, vslDomainBindings } from './schema-vsl.js';

export const vslProjects = pgTable(
  'vsl_projects',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    storeId: text('store_id').notNull().default('l0i'),
    name: text('name').notNull(),
    status: text('status').notNull().default('draft'),
    defaultCheckoutConfig: jsonb('default_checkout_config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    defaultTrackingConfig: jsonb('default_tracking_config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    activeReleaseId: uuid('active_release_id'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    domainId: uuid('domain_id'),
  },
  (t): PgTableExtraConfig => ({
    vslProjectsActiveReleaseFk: foreignKey({
      name: 'vsl_projects_active_release_fk',
      columns: [t.id, t.activeReleaseId],
      foreignColumns: [vslProjectReleases.projectId, vslProjectReleases.id],
    }).onDelete('no action'),
    vslProjectsDomainIdFkey: foreignKey({
      name: 'vsl_projects_domain_id_fkey',
      columns: [t.domainId],
      foreignColumns: [blackshopDomains.id],
    }).onDelete('restrict'),
    vslProjectsNameCheck: check(
      'vsl_projects_name_check',
      sql`((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 200))`
    ),
    vslProjectsStatusCheck: check(
      'vsl_projects_status_check',
      sql`(status = ANY (ARRAY['draft'::text, 'published'::text, 'archived'::text]))`
    ),
    vslProjectsVersionCheck: check('vsl_projects_version_check', sql`(version > 0)`),
    vslProjectsStoreUpdatedIdx: index('vsl_projects_store_updated_idx').on(
      t.storeId,
      t.updatedAt.desc().nullsFirst()
    ),
  })
);

export const vslSteps = pgTable(
  'vsl_steps',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    projectId: uuid('project_id').notNull(),
    position: integer('position').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull().default('PAGE'),
    pathname: text('pathname').notNull(),
    status: text('status').notNull().default('draft'),
    renderMode: text('render_mode').notNull().default('IMPORTED_PAGE'),
    pageRevisionId: uuid('page_revision_id'),
    videoAssetId: uuid('video_asset_id'),
    checkoutConfig: jsonb('checkout_config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    ctaConfig: jsonb('cta_config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    trackingConfig: jsonb('tracking_config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    nextStepId: uuid('next_step_id'),
    publicationState: text('publication_state').notNull().default('draft'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    videoPlacement: jsonb('video_placement')
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t): PgTableExtraConfig => ({
    vslStepsProjectIdUnique: unique('vsl_steps_project_id_unique').on(t.projectId, t.id),
    vslStepsProjectPathUnique: unique('vsl_steps_project_path_unique').on(t.projectId, t.pathname),
    vslStepsProjectPositionUnique: unique('vsl_steps_project_position_unique').on(
      t.projectId,
      t.position
    ),
    vslStepsNextSameProject: foreignKey({
      name: 'vsl_steps_next_same_project',
      columns: [t.projectId, t.nextStepId],
      foreignColumns: [t.projectId, t.id],
    }).onDelete('no action'),
    vslStepsPageRevisionFk: foreignKey({
      name: 'vsl_steps_page_revision_fk',
      columns: [t.pageRevisionId],
      foreignColumns: [vslPageRevisions.id],
    }).onDelete('restrict'),
    vslStepsProjectIdFkey: foreignKey({
      name: 'vsl_steps_project_id_fkey',
      columns: [t.projectId],
      foreignColumns: [vslProjects.id],
    }).onDelete('restrict'),
    vslStepsVideoAssetFk: foreignKey({
      name: 'vsl_steps_video_asset_fk',
      columns: [t.videoAssetId],
      foreignColumns: [vslVideoAssets.id],
    }).onDelete('restrict'),
    vslStepsNameCheck: check(
      'vsl_steps_name_check',
      sql`((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 200))`
    ),
    vslStepsNextNotSelf: check(
      'vsl_steps_next_not_self',
      sql`((next_step_id IS NULL) OR (next_step_id <> id))`
    ),
    vslStepsPathCheck: check(
      'vsl_steps_path_check',
      sql`((pathname ~~ '/%'::text) AND ((pathname = '/'::text) OR (pathname !~~ '%/'::text)))`
    ),
    vslStepsPositionCheck: check('vsl_steps_position_check', sql`("position" >= 0)`),
    vslStepsPublicationStateCheck: check(
      'vsl_steps_publication_state_check',
      sql`(publication_state = ANY (ARRAY['draft'::text, 'published'::text, 'unpublished'::text]))`
    ),
    vslStepsRenderModeCheck: check(
      'vsl_steps_render_mode_check',
      sql`(render_mode = ANY (ARRAY['IMPORTED_PAGE'::text, 'NATIVE_VIDEO'::text, 'REDIRECT'::text]))`
    ),
    vslStepsStatusCheck: check(
      'vsl_steps_status_check',
      sql`(status = ANY (ARRAY['draft'::text, 'ready'::text, 'archived'::text]))`
    ),
    vslStepsTypeCheck: check(
      'vsl_steps_type_check',
      sql`(type = ANY (ARRAY['PAGE'::text, 'QUIZ'::text, 'PRESELL'::text, 'VSL'::text, 'CHECKOUT'::text, 'CUSTOM'::text]))`
    ),
    vslStepsVersionCheck: check('vsl_steps_version_check', sql`(version > 0)`),
    vslStepsProjectStatusIdx: index('vsl_steps_project_status_idx').on(
      t.projectId,
      t.status,
      t.position
    ),
  })
);

export const vslPages = pgTable(
  'vsl_pages',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    storeId: text('store_id').notNull().default('l0i'),
    name: text('name').notNull(),
    currentRevisionId: uuid('current_revision_id'),
    legacyPageId: uuid('legacy_page_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // 0089: idioma da página (páginas geradas por tradução).
    locale: text('locale'),
  },
  (t): PgTableExtraConfig => ({
    vslPagesLocaleCheck: check('vsl_pages_locale_check', sql`((locale IS NULL) OR (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'::text))`),
    vslPagesLegacyPageIdKey: unique('vsl_pages_legacy_page_id_key').on(t.legacyPageId),
    vslPagesCurrentRevisionOwner: foreignKey({
      name: 'vsl_pages_current_revision_owner',
      columns: [t.id, t.currentRevisionId],
      foreignColumns: [vslPageRevisions.pageId, vslPageRevisions.id],
    }).onDelete('no action'),
    vslPagesLegacyPageIdFkey: foreignKey({
      name: 'vsl_pages_legacy_page_id_fkey',
      columns: [t.legacyPageId],
      foreignColumns: [landingPages.id],
    }).onDelete('restrict'),
    vslPagesNameCheck: check(
      'vsl_pages_name_check',
      sql`((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 200))`
    ),
    vslPagesStoreIdx: index('vsl_pages_store_idx').on(t.storeId, t.updatedAt.desc().nullsFirst()),
  })
);

export const vslPageRevisions = pgTable(
  'vsl_page_revisions',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    pageId: uuid('page_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    entryPath: text('entry_path').notNull(),
    storagePrefix: text('storage_prefix').notNull(),
    manifest: jsonb('manifest').notNull(),
    validationReport: jsonb('validation_report')
      .notNull()
      .default(sql`'{}'::jsonb`),
    sourceSha256: text('source_sha256').notNull(),
    fingerprint: text('fingerprint').notNull(),
    status: text('status').notNull().default('ready'),
    legacyRevisionId: uuid('legacy_revision_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // 0089: GC removeu o prefixo do storage.
    storageDeletedAt: timestamp('storage_deleted_at', { withTimezone: true }),
  },
  (t): PgTableExtraConfig => ({
    vslPageRevisionsLegacyRevisionIdKey: unique('vsl_page_revisions_legacy_revision_id_key').on(
      t.legacyRevisionId
    ),
    vslPageRevisionsPageFingerprintUnique: unique('vsl_page_revisions_page_fingerprint_unique').on(
      t.pageId,
      t.fingerprint
    ),
    vslPageRevisionsPageIdUnique: unique('vsl_page_revisions_page_id_unique').on(t.pageId, t.id),
    vslPageRevisionsPageNumberUnique: unique('vsl_page_revisions_page_number_unique').on(
      t.pageId,
      t.versionNumber
    ),
    vslPageRevisionsStoragePrefixKey: unique('vsl_page_revisions_storage_prefix_key').on(
      t.storagePrefix
    ),
    vslPageRevisionsLegacyRevisionIdFkey: foreignKey({
      name: 'vsl_page_revisions_legacy_revision_id_fkey',
      columns: [t.legacyRevisionId],
      foreignColumns: [landingPageVersions.id],
    }).onDelete('restrict'),
    vslPageRevisionsPageIdFkey: foreignKey({
      name: 'vsl_page_revisions_page_id_fkey',
      columns: [t.pageId],
      foreignColumns: [vslPages.id],
    }).onDelete('restrict'),
    vslPageRevisionsFingerprintCheck: check(
      'vsl_page_revisions_fingerprint_check',
      sql`(fingerprint ~ '^[0-9a-f]{64}$'::text)`
    ),
    vslPageRevisionsNumberCheck: check(
      'vsl_page_revisions_number_check',
      sql`(version_number > 0)`
    ),
    vslPageRevisionsSourceCheck: check(
      'vsl_page_revisions_source_check',
      sql`(source_sha256 ~ '^[0-9a-f]{64}$'::text)`
    ),
    vslPageRevisionsStatusCheck: check(
      'vsl_page_revisions_status_check',
      sql`(status = ANY (ARRAY['ready'::text, 'failed'::text, 'archived'::text]))`
    ),
    vslPageRevisionsPageIdx: index('vsl_page_revisions_page_idx').on(
      t.pageId,
      t.versionNumber.desc().nullsFirst()
    ),
  })
);

export const vslVideoAssets = pgTable(
  'vsl_video_assets',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    storeId: text('store_id').notNull().default('l0i'),
    name: text('name').notNull(),
    provider: text('provider').notNull().default('cloudflare_stream'),
    providerAssetId: text('provider_asset_id'),
    status: text('status').notNull().default('uploading'),
    durationSeconds: numeric('duration_seconds', { precision: 12, scale: 3 }),
    bytes: bigint('bytes', { mode: 'number' }),
    mimeType: text('mime_type'),
    playbackUrl: text('playback_url'),
    posterUrl: text('poster_url'),
    errorMessage: text('error_message'),
    legacyVideoId: uuid('legacy_video_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // 0088: agenda do scan de reconciliação Stream.
    reconcileAttempts: integer('reconcile_attempts').notNull().default(0),
    nextReconcileAt: timestamp('next_reconcile_at', { withTimezone: true }),
    lastWebhookAt: timestamp('last_webhook_at', { withTimezone: true }),
  },
  (t): PgTableExtraConfig => ({
    vslVideoAssetsReconcileIdx: index('vsl_video_assets_reconcile_idx')
      .on(t.nextReconcileAt.asc().nullsFirst(), t.updatedAt)
      .where(sql`status IN ('uploading','processing')`),
    vslVideoAssetsLegacyVideoIdKey: unique('vsl_video_assets_legacy_video_id_key').on(
      t.legacyVideoId
    ),
    vslVideoAssetsLegacyVideoIdFkey: foreignKey({
      name: 'vsl_video_assets_legacy_video_id_fkey',
      columns: [t.legacyVideoId],
      foreignColumns: [landingVideoAssets.id],
    }).onDelete('restrict'),
    vslVideoAssetsNameCheck: check(
      'vsl_video_assets_name_check',
      sql`((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 200))`
    ),
    vslVideoAssetsProviderCheck: check(
      'vsl_video_assets_provider_check',
      sql`(provider = 'cloudflare_stream'::text)`
    ),
    vslVideoAssetsStatusCheck: check(
      'vsl_video_assets_status_check',
      sql`(status = ANY (ARRAY['uploading'::text, 'processing'::text, 'ready'::text, 'failed'::text, 'deleted'::text]))`
    ),
    vslVideoAssetsProviderUidIdx: uniqueIndex('vsl_video_assets_provider_uid_idx')
      .on(t.provider, t.providerAssetId)
      .where(sql`provider_asset_id IS NOT NULL`),
    vslVideoAssetsStoreStatusIdx: index('vsl_video_assets_store_status_idx').on(
      t.storeId,
      t.status,
      t.updatedAt.desc().nullsFirst()
    ),
  })
);

export const vslVideoUploadIntents = pgTable(
  'vsl_video_upload_intents',
  {
    id: uuid('id').notNull().primaryKey(),
    requestKey: text('request_key').notNull(),
    requestHash: text('request_hash').notNull(),
    declaredBytes: bigint('declared_bytes', { mode: 'number' }).notNull(),
    // 0088: opcional (o browser não precisa ler o arquivo inteiro).
    sourceSha256: text('source_sha256'),
    mimeType: text('mime_type').notNull(),
    state: text('state').notNull().default('requested'),
    providerModifiedAt: timestamp('provider_modified_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    sampleSha256: text('sample_sha256'),
  },
  (t): PgTableExtraConfig => ({
    vslVideoUploadIntentsSampleCheck: check(
      'vsl_video_upload_intents_sample_check',
      sql`((sample_sha256 IS NULL) OR (sample_sha256 ~ '^[0-9a-f]{64}$'::text))`
    ),
    vslVideoUploadIntentsSampleIdx: index('vsl_video_upload_intents_sample_idx')
      .on(t.declaredBytes, t.sampleSha256)
      .where(sql`sample_sha256 IS NOT NULL`),
    vslVideoUploadIntentsRequestKeyKey: unique('vsl_video_upload_intents_request_key_key').on(
      t.requestKey
    ),
    vslVideoUploadIntentsIdFkey: foreignKey({
      name: 'vsl_video_upload_intents_id_fkey',
      columns: [t.id],
      foreignColumns: [vslVideoAssets.id],
    }).onDelete('restrict'),
    vslVideoUploadIntentsBytesCheck: check(
      'vsl_video_upload_intents_bytes_check',
      sql`((declared_bytes >= 1) AND (declared_bytes <= '5000000000'::bigint))`
    ),
    vslVideoUploadIntentsShaCheck: check(
      'vsl_video_upload_intents_sha_check',
      sql`(source_sha256 ~ '^[0-9a-f]{64}$'::text)`
    ),
    vslVideoUploadIntentsStateCheck: check(
      'vsl_video_upload_intents_state_check',
      sql`(state = ANY (ARRAY['requested'::text, 'uploading'::text, 'processing'::text, 'ready'::text, 'failed'::text, 'deleted'::text]))`
    ),
  })
);

// Sem escrita no código atual; mantida por compatibilidade. O índice único é
// NULLS NOT DISTINCT no SQL (Drizzle 0.36 não representa em índice).
export const vslAssetReferences = pgTable(
  'vsl_asset_references',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    videoAssetId: uuid('video_asset_id'),
    pageRevisionId: uuid('page_revision_id'),
    projectId: uuid('project_id').notNull(),
    stepId: uuid('step_id').notNull(),
    releaseId: uuid('release_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslAssetReferencesPageRevisionIdFkey: foreignKey({
      name: 'vsl_asset_references_page_revision_id_fkey',
      columns: [t.pageRevisionId],
      foreignColumns: [vslPageRevisions.id],
    }).onDelete('restrict'),
    vslAssetReferencesProjectIdFkey: foreignKey({
      name: 'vsl_asset_references_project_id_fkey',
      columns: [t.projectId],
      foreignColumns: [vslProjects.id],
    }).onDelete('restrict'),
    vslAssetReferencesStepIdFkey: foreignKey({
      name: 'vsl_asset_references_step_id_fkey',
      columns: [t.stepId],
      foreignColumns: [vslSteps.id],
    }).onDelete('restrict'),
    vslAssetReferencesVideoAssetIdFkey: foreignKey({
      name: 'vsl_asset_references_video_asset_id_fkey',
      columns: [t.videoAssetId],
      foreignColumns: [vslVideoAssets.id],
    }).onDelete('restrict'),
    vslAssetReferencesOneAssetCheck: check(
      'vsl_asset_references_one_asset_check',
      sql`((video_asset_id IS NULL) <> (page_revision_id IS NULL))`
    ),
    vslAssetReferencesUniqueIdx: uniqueIndex('vsl_asset_references_unique_idx').on(
      t.stepId,
      t.videoAssetId,
      t.pageRevisionId,
      t.releaseId
    ),
  })
);

export const vslProjectReleases = pgTable(
  'vsl_project_releases',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    projectId: uuid('project_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    domainId: uuid('domain_id').notNull(),
    previousReleaseId: uuid('previous_release_id'),
    configSnapshot: jsonb('config_snapshot')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslProjectReleasesProjectIdUnique: unique('vsl_project_releases_project_id_unique').on(
      t.projectId,
      t.id
    ),
    vslProjectReleasesProjectVersionUnique: unique(
      'vsl_project_releases_project_version_unique'
    ).on(t.projectId, t.versionNumber),
    vslProjectReleasesDomainIdFkey: foreignKey({
      name: 'vsl_project_releases_domain_id_fkey',
      columns: [t.domainId],
      foreignColumns: [blackshopDomains.id],
    }).onDelete('restrict'),
    vslProjectReleasesPreviousFk: foreignKey({
      name: 'vsl_project_releases_previous_fk',
      columns: [t.previousReleaseId],
      foreignColumns: [t.id],
    }).onDelete('restrict'),
    vslProjectReleasesProjectIdFkey: foreignKey({
      name: 'vsl_project_releases_project_id_fkey',
      columns: [t.projectId],
      foreignColumns: [vslProjects.id],
    }).onDelete('restrict'),
    vslProjectReleasesVersionCheck: check(
      'vsl_project_releases_version_check',
      sql`(version_number > 0)`
    ),
  })
);

export const vslStepReleases = pgTable(
  'vsl_step_releases',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    projectReleaseId: uuid('project_release_id').notNull(),
    stepId: uuid('step_id').notNull(),
    position: integer('position').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    pathname: text('pathname').notNull(),
    renderMode: text('render_mode').notNull(),
    pageRevisionId: uuid('page_revision_id'),
    videoAssetId: uuid('video_asset_id'),
    videoPlacement: jsonb('video_placement')
      .notNull()
      .default(sql`'{}'::jsonb`),
    checkoutConfig: jsonb('checkout_config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    ctaConfig: jsonb('cta_config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    trackingConfig: jsonb('tracking_config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    nextStepId: uuid('next_step_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslStepReleasesPathUnique: unique('vsl_step_releases_path_unique').on(
      t.projectReleaseId,
      t.pathname
    ),
    vslStepReleasesPositionUnique: unique('vsl_step_releases_position_unique').on(
      t.projectReleaseId,
      t.position
    ),
    vslStepReleasesStepUnique: unique('vsl_step_releases_step_unique').on(
      t.projectReleaseId,
      t.stepId
    ),
    vslStepReleasesPageRevisionIdFkey: foreignKey({
      name: 'vsl_step_releases_page_revision_id_fkey',
      columns: [t.pageRevisionId],
      foreignColumns: [vslPageRevisions.id],
    }).onDelete('restrict'),
    vslStepReleasesProjectReleaseIdFkey: foreignKey({
      name: 'vsl_step_releases_project_release_id_fkey',
      columns: [t.projectReleaseId],
      foreignColumns: [vslProjectReleases.id],
    }).onDelete('restrict'),
    vslStepReleasesStepIdFkey: foreignKey({
      name: 'vsl_step_releases_step_id_fkey',
      columns: [t.stepId],
      foreignColumns: [vslSteps.id],
    }).onDelete('restrict'),
    vslStepReleasesVideoAssetIdFkey: foreignKey({
      name: 'vsl_step_releases_video_asset_id_fkey',
      columns: [t.videoAssetId],
      foreignColumns: [vslVideoAssets.id],
    }).onDelete('restrict'),
    vslStepReleasesStepIdx: index('vsl_step_releases_step_idx').on(
      t.stepId,
      t.createdAt.desc().nullsFirst()
    ),
  })
);

export const vslPublicRoutes = pgTable(
  'vsl_public_routes',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    domainId: uuid('domain_id').notNull(),
    pathname: text('pathname').notNull(),
    projectId: uuid('project_id').notNull(),
    stepId: uuid('step_id').notNull(),
    activeProjectReleaseId: uuid('active_project_release_id'),
    activeStepReleaseId: uuid('active_step_release_id'),
    publicationStatus: text('publication_status').notNull().default('published'),
    cacheVersion: integer('cache_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslPublicRoutesDomainPathUnique: unique('vsl_public_routes_domain_path_unique').on(
      t.domainId,
      t.pathname
    ),
    vslPublicRoutesActiveProjectReleaseIdFkey: foreignKey({
      name: 'vsl_public_routes_active_project_release_id_fkey',
      columns: [t.activeProjectReleaseId],
      foreignColumns: [vslProjectReleases.id],
    }).onDelete('restrict'),
    vslPublicRoutesActiveStepReleaseIdFkey: foreignKey({
      name: 'vsl_public_routes_active_step_release_id_fkey',
      columns: [t.activeStepReleaseId],
      foreignColumns: [vslStepReleases.id],
    }).onDelete('restrict'),
    vslPublicRoutesDomainIdFkey: foreignKey({
      name: 'vsl_public_routes_domain_id_fkey',
      columns: [t.domainId],
      foreignColumns: [blackshopDomains.id],
    }).onDelete('restrict'),
    vslPublicRoutesProjectIdFkey: foreignKey({
      name: 'vsl_public_routes_project_id_fkey',
      columns: [t.projectId],
      foreignColumns: [vslProjects.id],
    }).onDelete('restrict'),
    vslPublicRoutesStepIdFkey: foreignKey({
      name: 'vsl_public_routes_step_id_fkey',
      columns: [t.stepId],
      foreignColumns: [vslSteps.id],
    }).onDelete('restrict'),
    vslPublicRoutesActivePairCheck: check(
      'vsl_public_routes_active_pair_check',
      sql`((active_project_release_id IS NULL) = (active_step_release_id IS NULL))`
    ),
    vslPublicRoutesStatusCheck: check(
      'vsl_public_routes_status_check',
      sql`(publication_status = ANY (ARRAY['published'::text, 'unpublished'::text]))`
    ),
    vslPublicRoutesProjectIdx: index('vsl_public_routes_project_idx').on(
      t.projectId,
      t.publicationStatus
    ),
  })
);

export const vslPublicationEvents = pgTable(
  'vsl_publication_events',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    projectId: uuid('project_id').notNull(),
    fromReleaseId: uuid('from_release_id'),
    toReleaseId: uuid('to_release_id'),
    eventType: text('event_type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslPublicationEventsFromReleaseIdFkey: foreignKey({
      name: 'vsl_publication_events_from_release_id_fkey',
      columns: [t.fromReleaseId],
      foreignColumns: [vslProjectReleases.id],
    }).onDelete('restrict'),
    vslPublicationEventsProjectIdFkey: foreignKey({
      name: 'vsl_publication_events_project_id_fkey',
      columns: [t.projectId],
      foreignColumns: [vslProjects.id],
    }).onDelete('restrict'),
    vslPublicationEventsToReleaseIdFkey: foreignKey({
      name: 'vsl_publication_events_to_release_id_fkey',
      columns: [t.toReleaseId],
      foreignColumns: [vslProjectReleases.id],
    }).onDelete('restrict'),
    vslPublicationEventsTypeCheck: check(
      'vsl_publication_events_type_check',
      sql`(event_type = ANY (ARRAY['publish'::text, 'rollback'::text, 'unpublish'::text]))`
    ),
    vslPublicationEventsProjectIdx: index('vsl_publication_events_project_idx').on(
      t.projectId,
      t.createdAt.desc().nullsFirst()
    ),
  })
);

// Analytics G3 — sem PII de visitante.
export const vslEvents = pgTable(
  'vsl_events',
  {
    eventId: uuid('event_id').notNull().primaryKey(),
    projectId: uuid('project_id').notNull(),
    stepId: uuid('step_id').notNull(),
    releaseId: uuid('release_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    eventName: text('event_name').notNull(),
    ctaId: text('cta_id').notNull().default(''),
    watchedSeconds: numeric('watched_seconds', { precision: 12, scale: 3 }),
    watchedPercentage: numeric('watched_percentage', { precision: 6, scale: 5 }),
    eventAt: timestamp('event_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslEventsProjectIdFkey: foreignKey({
      name: 'vsl_events_project_id_fkey',
      columns: [t.projectId],
      foreignColumns: [vslProjects.id],
    }).onDelete('restrict'),
    vslEventsReleaseIdFkey: foreignKey({
      name: 'vsl_events_release_id_fkey',
      columns: [t.releaseId],
      foreignColumns: [vslProjectReleases.id],
    }).onDelete('restrict'),
    vslEventsStepIdFkey: foreignKey({
      name: 'vsl_events_step_id_fkey',
      columns: [t.stepId],
      foreignColumns: [vslSteps.id],
    }).onDelete('restrict'),
    vslEventsNameCheck: check(
      'vsl_events_name_check',
      sql`(event_name = ANY (ARRAY['PageView'::text, 'VSLStart'::text, 'VSL25'::text, 'VSL50'::text, 'VSL75'::text, 'VSLComplete'::text, 'CTAVisible'::text, 'CTAClick'::text, 'CheckoutClick'::text, 'WatchProgress'::text]))`
    ),
    vslEventsPercentageCheck: check(
      'vsl_events_percentage_check',
      sql`((watched_percentage IS NULL) OR ((watched_percentage >= (0)::numeric) AND (watched_percentage <= (1)::numeric)))`
    ),
    vslEventsWatchedCheck: check(
      'vsl_events_watched_check',
      sql`((watched_seconds IS NULL) OR ((watched_seconds >= (0)::numeric) AND (watched_seconds <= (7200)::numeric)))`
    ),
    // 0088 (INCLUDE step_id,event_name,session_id no SQL; Drizzle 0.36 não representa INCLUDE).
    vslEventsProjectReceivedIdx: index('vsl_events_project_received_idx').on(t.projectId, t.receivedAt),
    vslEventsProjectStepTimeIdx: index('vsl_events_project_step_time_idx').on(
      t.projectId,
      t.stepId,
      t.receivedAt.desc().nullsFirst()
    ),
    vslEventsSessionActionUnique: uniqueIndex('vsl_events_session_action_unique')
      .on(t.releaseId, t.stepId, t.sessionId, t.eventName, t.ctaId)
      .where(sql`event_name <> 'WatchProgress'::text`),
  })
);

export const vslWatchSessions = pgTable(
  'vsl_watch_sessions',
  {
    releaseId: uuid('release_id').notNull(),
    projectId: uuid('project_id').notNull(),
    stepId: uuid('step_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    watchedSeconds: numeric('watched_seconds', { precision: 12, scale: 3 }).notNull().default('0'),
    watchedPercentage: numeric('watched_percentage', { precision: 6, scale: 5 })
      .notNull()
      .default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    pk: primaryKey({
      name: 'vsl_watch_sessions_pkey',
      columns: [t.releaseId, t.stepId, t.sessionId],
    }),
    vslWatchSessionsProjectIdFkey: foreignKey({
      name: 'vsl_watch_sessions_project_id_fkey',
      columns: [t.projectId],
      foreignColumns: [vslProjects.id],
    }).onDelete('restrict'),
    vslWatchSessionsReleaseIdFkey: foreignKey({
      name: 'vsl_watch_sessions_release_id_fkey',
      columns: [t.releaseId],
      foreignColumns: [vslProjectReleases.id],
    }).onDelete('restrict'),
    vslWatchSessionsStepIdFkey: foreignKey({
      name: 'vsl_watch_sessions_step_id_fkey',
      columns: [t.stepId],
      foreignColumns: [vslSteps.id],
    }).onDelete('restrict'),
    vslWatchSessionsPercentageCheck: check(
      'vsl_watch_sessions_percentage_check',
      sql`((watched_percentage >= (0)::numeric) AND (watched_percentage <= (1)::numeric))`
    ),
    vslWatchSessionsSecondsCheck: check(
      'vsl_watch_sessions_seconds_check',
      sql`((watched_seconds >= (0)::numeric) AND (watched_seconds <= (7200)::numeric))`
    ),
    // 0088 (INCLUDE no SQL).
    vslWatchSessionsProjectUpdatedIdx: index('vsl_watch_sessions_project_updated_idx').on(t.projectId, t.updatedAt),
    vslWatchSessionsProjectStepIdx: index('vsl_watch_sessions_project_step_idx').on(
      t.projectId,
      t.stepId
    ),
  })
);

// Ponte G1 → G3 (apps/api/src/scripts/vsl-legacy.ts).
export const vslLegacyProjectLinks = pgTable(
  'vsl_legacy_project_links',
  {
    legacyPageId: uuid('legacy_page_id').notNull().primaryKey(),
    legacyRevisionId: uuid('legacy_revision_id').notNull(),
    legacyVideoId: uuid('legacy_video_id'),
    legacyBindingId: uuid('legacy_binding_id'),
    projectId: uuid('project_id').notNull(),
    stepId: uuid('step_id').notNull(),
    migrationState: text('migration_state').notNull().default('draft_mapped'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslLegacyProjectLinksProjectIdKey: unique('vsl_legacy_project_links_project_id_key').on(
      t.projectId
    ),
    vslLegacyProjectLinksStepIdKey: unique('vsl_legacy_project_links_step_id_key').on(t.stepId),
    vslLegacyProjectLinksLegacyBindingIdFkey: foreignKey({
      name: 'vsl_legacy_project_links_legacy_binding_id_fkey',
      columns: [t.legacyBindingId],
      foreignColumns: [vslDomainBindings.id],
    }).onDelete('restrict'),
    vslLegacyProjectLinksLegacyPageIdFkey: foreignKey({
      name: 'vsl_legacy_project_links_legacy_page_id_fkey',
      columns: [t.legacyPageId],
      foreignColumns: [landingPages.id],
    }).onDelete('restrict'),
    vslLegacyProjectLinksLegacyRevisionIdFkey: foreignKey({
      name: 'vsl_legacy_project_links_legacy_revision_id_fkey',
      columns: [t.legacyRevisionId],
      foreignColumns: [landingPageVersions.id],
    }).onDelete('restrict'),
    vslLegacyProjectLinksLegacyVideoIdFkey: foreignKey({
      name: 'vsl_legacy_project_links_legacy_video_id_fkey',
      columns: [t.legacyVideoId],
      foreignColumns: [landingVideoAssets.id],
    }).onDelete('restrict'),
    vslLegacyProjectLinksProjectIdFkey: foreignKey({
      name: 'vsl_legacy_project_links_project_id_fkey',
      columns: [t.projectId],
      foreignColumns: [vslProjects.id],
    }).onDelete('restrict'),
    vslLegacyProjectLinksStepIdFkey: foreignKey({
      name: 'vsl_legacy_project_links_step_id_fkey',
      columns: [t.stepId],
      foreignColumns: [vslSteps.id],
    }).onDelete('restrict'),
    vslLegacyProjectLinksStateCheck: check(
      'vsl_legacy_project_links_state_check',
      sql`(migration_state = ANY (ARRAY['draft_mapped'::text, 'reconciled'::text, 'cutover'::text]))`
    ),
  })
);

// 0088: jobs do import G3 assíncrono (API grava upload + job; worker processa com lease/fencing).
export const vslPageImportJobs = pgTable(
  'vsl_page_import_jobs',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    pageId: uuid('page_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    kind: text('kind').notNull(),
    // 0089: source_* só obrigatórios no import (revisões derivadas não têm upload).
    sourceKey: text('source_key'),
    sourceBytes: bigint('source_bytes', { mode: 'number' }),
    sourceSha256: text('source_sha256'),
    config: jsonb('config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    state: text('state').notNull().default('queued'),
    stage: text('stage').notNull().default('queued'),
    progress: smallint('progress').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    leaseToken: uuid('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    revisionId: uuid('revision_id'),
    reused: boolean('reused').notNull().default(false),
    report: jsonb('report'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    // 0089: revisão derivada (edição de textos / aplicar tradução).
    operation: text('operation').notNull().default('import'),
    baseRevisionId: uuid('base_revision_id'),
    payload: jsonb('payload'),
  },
  (t): PgTableExtraConfig => ({
    vslPageImportJobsBaseRevisionIdFkey: foreignKey({
      name: 'vsl_page_import_jobs_base_revision_id_fkey',
      columns: [t.baseRevisionId],
      foreignColumns: [vslPageRevisions.id],
    }).onDelete('restrict'),
    vslPageImportJobsOperationCheck: check('vsl_page_import_jobs_operation_check', sql`(operation = ANY (ARRAY['import'::text, 'text_edit'::text, 'translation_apply'::text]))`),
    vslPageImportJobsSourceCheck: check('vsl_page_import_jobs_source_check',
      sql`((operation <> 'import'::text) OR ((source_key IS NOT NULL) AND (source_bytes IS NOT NULL) AND (source_sha256 IS NOT NULL)))`),
    vslPageImportJobsDerivedCheck: check('vsl_page_import_jobs_derived_check',
      sql`((operation = 'import'::text) OR ((base_revision_id IS NOT NULL) AND (payload IS NOT NULL)))`),
    vslPageImportJobsIdempotencyUnique: unique('vsl_page_import_jobs_idempotency_unique').on(t.pageId, t.idempotencyKey),
    vslPageImportJobsPageIdFkey: foreignKey({
      name: 'vsl_page_import_jobs_page_id_fkey',
      columns: [t.pageId],
      foreignColumns: [vslPages.id],
    }).onDelete('restrict'),
    vslPageImportJobsRevisionIdFkey: foreignKey({
      name: 'vsl_page_import_jobs_revision_id_fkey',
      columns: [t.revisionId],
      foreignColumns: [vslPageRevisions.id],
    }).onDelete('restrict'),
    vslPageImportJobsKeyCheck: check('vsl_page_import_jobs_key_check', sql`((length(idempotency_key) >= 1) AND (length(idempotency_key) <= 200))`),
    vslPageImportJobsKindCheck: check('vsl_page_import_jobs_kind_check', sql`(kind = ANY (ARRAY['html'::text, 'zip'::text]))`),
    vslPageImportJobsStateCheck: check(
      'vsl_page_import_jobs_state_check',
      sql`(state = ANY (ARRAY['queued'::text, 'running'::text, 'needs_resolution'::text, 'succeeded'::text, 'failed'::text]))`
    ),
    vslPageImportJobsProgressCheck: check('vsl_page_import_jobs_progress_check', sql`((progress >= 0) AND (progress <= 100))`),
    vslPageImportJobsAttemptsCheck: check('vsl_page_import_jobs_attempts_check', sql`((attempts >= 0) AND ((max_attempts >= 1) AND (max_attempts <= 10)))`),
    vslPageImportJobsBytesCheck: check('vsl_page_import_jobs_bytes_check', sql`(source_bytes > 0)`),
    vslPageImportJobsShaCheck: check('vsl_page_import_jobs_sha_check', sql`(source_sha256 ~ '^[0-9a-f]{64}$'::text)`),
    vslPageImportJobsLeaseCheck: check('vsl_page_import_jobs_lease_check', sql`((state = 'running'::text) = (lease_token IS NOT NULL))`),
    vslPageImportJobsResultCheck: check('vsl_page_import_jobs_result_check', sql`((state <> 'succeeded'::text) OR (revision_id IS NOT NULL))`),
    vslPageImportJobsClaimIdx: index('vsl_page_import_jobs_claim_idx')
      .on(t.runAfter, t.createdAt)
      .where(sql`state IN ('queued','running')`),
    vslPageImportJobsPageIdx: index('vsl_page_import_jobs_page_idx').on(t.pageId, t.createdAt.desc().nullsFirst()),
  })
);

// 0089: tradução de páginas (Claude) com revisão por unidade.
export const vslPageTranslations = pgTable(
  'vsl_page_translations',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    storeId: text('store_id').notNull().default('l0i'),
    pageId: uuid('page_id').notNull(),
    sourceRevisionId: uuid('source_revision_id').notNull(),
    sourceLocale: text('source_locale'),
    targetLocale: text('target_locale').notNull(),
    status: text('status').notNull().default('extracting'),
    progress: smallint('progress').notNull().default(0),
    sourceChars: integer('source_chars').notNull().default(0),
    unitsTotal: integer('units_total').notNull().default(0),
    provider: text('provider'),
    model: text('model'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    leaseToken: uuid('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    applyJobId: uuid('apply_job_id'),
    targetPageId: uuid('target_page_id'),
    targetRevisionId: uuid('target_revision_id'),
    linkStepIds: jsonb('link_step_ids')
      .notNull()
      .default(sql`'[]'::jsonb`),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t): PgTableExtraConfig => ({
    vslPageTranslationsPageIdFkey: foreignKey({ name: 'vsl_page_translations_page_id_fkey', columns: [t.pageId], foreignColumns: [vslPages.id] }).onDelete('restrict'),
    vslPageTranslationsSourceRevisionIdFkey: foreignKey({
      name: 'vsl_page_translations_source_revision_id_fkey', columns: [t.sourceRevisionId], foreignColumns: [vslPageRevisions.id],
    }).onDelete('restrict'),
    vslPageTranslationsApplyJobIdFkey: foreignKey({
      name: 'vsl_page_translations_apply_job_id_fkey', columns: [t.applyJobId], foreignColumns: [vslPageImportJobs.id],
    }).onDelete('restrict'),
    vslPageTranslationsTargetPageIdFkey: foreignKey({
      name: 'vsl_page_translations_target_page_id_fkey', columns: [t.targetPageId], foreignColumns: [vslPages.id],
    }).onDelete('restrict'),
    vslPageTranslationsTargetRevisionIdFkey: foreignKey({
      name: 'vsl_page_translations_target_revision_id_fkey', columns: [t.targetRevisionId], foreignColumns: [vslPageRevisions.id],
    }).onDelete('restrict'),
    vslPageTranslationsStatusCheck: check('vsl_page_translations_status_check',
      sql`(status = ANY (ARRAY['extracting'::text, 'translating'::text, 'review'::text, 'applying'::text, 'done'::text, 'failed'::text]))`),
    vslPageTranslationsLocaleCheck: check('vsl_page_translations_locale_check',
      sql`(target_locale = ANY (ARRAY['it'::text, 'en'::text, 'es'::text, 'pt'::text, 'fr'::text, 'de'::text, 'nl'::text, 'pl'::text]))`),
    vslPageTranslationsProgressCheck: check('vsl_page_translations_progress_check', sql`((progress >= 0) AND (progress <= 100))`),
    vslPageTranslationsAttemptsCheck: check('vsl_page_translations_attempts_check', sql`((attempts >= 0) AND ((max_attempts >= 1) AND (max_attempts <= 10)))`),
    vslPageTranslationsLeaseCheck: check('vsl_page_translations_lease_check', sql`((lease_token IS NULL) OR (status = 'translating'::text))`),
    vslPageTranslationsDoneCheck: check('vsl_page_translations_done_check',
      sql`((status <> 'done'::text) OR ((target_page_id IS NOT NULL) AND (target_revision_id IS NOT NULL)))`),
    vslPageTranslationsStepsCheck: check('vsl_page_translations_steps_check', sql`(jsonb_typeof(link_step_ids) = 'array'::text)`),
    vslPageTranslationsClaimIdx: index('vsl_page_translations_claim_idx')
      .on(t.runAfter, t.createdAt)
      .where(sql`status = 'translating'`),
    vslPageTranslationsPageIdx: index('vsl_page_translations_page_idx').on(t.pageId, t.createdAt.desc().nullsFirst()),
  })
);

export const vslPageTranslationUnits = pgTable(
  'vsl_page_translation_units',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    translationId: uuid('translation_id').notNull(),
    position: integer('position').notNull(),
    blockId: text('block_id').notNull(),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    context: text('context').notNull().default(''),
    source: text('source').notNull(),
    translated: text('translated'),
    status: text('status').notNull().default('pending'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslPageTranslationUnitsTranslationIdFkey: foreignKey({
      name: 'vsl_page_translation_units_translation_id_fkey', columns: [t.translationId], foreignColumns: [vslPageTranslations.id],
    }).onDelete('cascade'),
    vslPageTranslationUnitsBlockUnique: unique('vsl_page_translation_units_block_unique').on(t.translationId, t.blockId),
    vslPageTranslationUnitsPositionUnique: unique('vsl_page_translation_units_position_unique').on(t.translationId, t.position),
    vslPageTranslationUnitsKindCheck: check('vsl_page_translation_units_kind_check',
      sql`(kind = ANY (ARRAY['text'::text, 'attribute'::text, 'title'::text, 'meta'::text, 'script-string'::text]))`),
    vslPageTranslationUnitsStatusCheck: check('vsl_page_translation_units_status_check',
      sql`(status = ANY (ARRAY['pending'::text, 'edited'::text, 'approved'::text]))`),
  })
);

// 0090 (VSL-13 Fase A) — registro de envio da Meta Conversions API. Sem token e sem PII
// (IP/UA/fbp/fbc/URL nunca são gravados). Retenção de 30 dias (expurgo na API).
export const vslMetaCapiDeliveries = pgTable(
  'vsl_meta_capi_deliveries',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    eventId: uuid('event_id').notNull(),
    pixelId: text('pixel_id').notNull(),
    projectId: uuid('project_id').notNull(),
    stepId: uuid('step_id').notNull(),
    releaseId: uuid('release_id').notNull(),
    eventName: text('event_name').notNull(),
    status: text('status').notNull().default('pending'),
    reason: text('reason'),
    attempts: smallint('attempts').notNull().default(0),
    httpStatus: smallint('http_status'),
    fbtraceId: text('fbtrace_id'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    vslMetaCapiDeliveriesProjectIdFkey: foreignKey({
      name: 'vsl_meta_capi_deliveries_project_id_fkey', columns: [t.projectId], foreignColumns: [vslProjects.id],
    }).onDelete('restrict'),
    vslMetaCapiDeliveriesStepIdFkey: foreignKey({
      name: 'vsl_meta_capi_deliveries_step_id_fkey', columns: [t.stepId], foreignColumns: [vslSteps.id],
    }).onDelete('restrict'),
    vslMetaCapiDeliveriesReleaseIdFkey: foreignKey({
      name: 'vsl_meta_capi_deliveries_release_id_fkey', columns: [t.releaseId], foreignColumns: [vslProjectReleases.id],
    }).onDelete('restrict'),
    vslMetaCapiDeliveriesEventPixelUnique: unique('vsl_meta_capi_deliveries_event_pixel_unique').on(t.eventId, t.pixelId),
    vslMetaCapiDeliveriesStatusCheck: check('vsl_meta_capi_deliveries_status_check',
      sql`(status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'skipped'::text]))`),
    vslMetaCapiDeliveriesEventNameCheck: check('vsl_meta_capi_deliveries_event_name_check',
      sql`(event_name = ANY (ARRAY['PageView'::text, 'ViewContent'::text, 'InitiateCheckout'::text]))`),
    vslMetaCapiDeliveriesPixelCheck: check('vsl_meta_capi_deliveries_pixel_check', sql`(pixel_id ~ '^[A-Za-z0-9._-]{2,120}$'::text)`),
    vslMetaCapiDeliveriesReasonCheck: check('vsl_meta_capi_deliveries_reason_check', sql`((reason IS NULL) OR (reason ~ '^[a-z_]{1,40}$'::text))`),
    vslMetaCapiDeliveriesAttemptsCheck: check('vsl_meta_capi_deliveries_attempts_check', sql`((attempts >= 0) AND (attempts <= 2))`),
    vslMetaCapiDeliveriesHttpCheck: check('vsl_meta_capi_deliveries_http_check',
      sql`((http_status IS NULL) OR ((http_status >= 100) AND (http_status <= 599)))`),
    vslMetaCapiDeliveriesDiagCheck: check('vsl_meta_capi_deliveries_diag_check',
      sql`(((fbtrace_id IS NULL) OR (length(fbtrace_id) <= 100)) AND ((error_code IS NULL) OR (length(error_code) <= 60)) AND ((error_message IS NULL) OR (length(error_message) <= 300)))`),
    vslMetaCapiDeliveriesProjectTimeIdx: index('vsl_meta_capi_deliveries_project_time_idx').on(t.projectId, t.createdAt.desc().nullsFirst()),
    vslMetaCapiDeliveriesCreatedIdx: index('vsl_meta_capi_deliveries_created_idx').on(t.createdAt),
  })
);
