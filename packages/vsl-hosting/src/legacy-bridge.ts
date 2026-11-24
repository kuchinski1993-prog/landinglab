import { createHash } from 'node:crypto';

import type { Sql } from 'postgres';

import { validateCheckoutConfig } from './funnel-config.js';
import { VslError } from './imports.js';
import { normalizeVslPathname } from './pathnames.js';
import { type Manifest, type VslStorage, validateManifest } from './storage.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Explicit, draft-only bridge. Legacy routes and rows are never mutated. */
export class VslLegacyBridge {
  constructor(readonly sql: Sql, readonly storage: VslStorage) {}

  async inspect(pageId: string) {
    const [page] = await this.sql`SELECT id,title,slug,store_id,published_version_id FROM landing_pages
      WHERE id=${pageId} AND content_mode='hosted' AND store_id='l0i'`;
    if (!page) throw new VslError('Hosted VSL page not found', 404);
    const [existing] = await this.sql`SELECT * FROM vsl_legacy_project_links WHERE legacy_page_id=${pageId}`;
    const [revision] = await this.sql`SELECT id,version_number,release_storage_prefix,entry_path,asset_manifest,
      validation_report,html_body,checksum,status FROM landing_page_versions
      WHERE landing_page_id=${pageId} AND status IN ('ready','published')
      ORDER BY (id=${page.published_version_id}) DESC,version_number DESC LIMIT 1`;
    const [settings] = await this.sql`SELECT video_asset_id,video_selector,checkout_url,cta_selectors,unlock_after_seconds
      FROM landing_hosting_settings WHERE landing_page_id=${pageId}`;
    const [video] = settings?.video_asset_id ? await this.sql`SELECT id,provider_asset_id,status,duration_seconds,bytes,mime_type,playback_url,poster_url
      FROM landing_video_assets WHERE id=${settings.video_asset_id} AND landing_page_id=${pageId}` : [];
    const [binding] = await this.sql`SELECT id,domain_id,normalized_pathname,publication_status FROM vsl_domain_bindings
      WHERE page_id=${pageId} ORDER BY (publication_status='published') DESC,updated_at DESC LIMIT 1`;
    const warnings: string[] = [];
    if (!revision?.release_storage_prefix || !revision.asset_manifest) warnings.push('No ready sealed revision');
    else {
      try {
        validateManifest(revision.asset_manifest as Manifest);
        if (!(await this.storage.isSealed(String(revision.release_storage_prefix), revision.asset_manifest as Manifest))) warnings.push('Revision seal missing');
      } catch { warnings.push('Revision manifest invalid'); }
    }
    if (settings?.video_asset_id && (!video || video.status !== 'ready')) warnings.push('Legacy video is not READY');
    if (settings?.checkout_url) {
      try { validateCheckoutConfig({ url: settings.checkout_url }); } catch { warnings.push('Legacy checkout needs a valid HTTPS URL'); }
    }
    return { page, existing, revision, settings, video, binding, warnings };
  }

  async backfill(pageId: string) {
    const source = await this.inspect(pageId);
    if (source.existing) return { projectId: source.existing.project_id, stepId: source.existing.step_id, reused: true, warnings: source.warnings };
    if (!source.revision || source.warnings.some((warning) => warning.includes('revision') || warning.includes('manifest') || warning.includes('seal')))
      throw new VslError('Legacy source revision is not safe to map', 409);
    const checkout = source.settings?.checkout_url && !source.warnings.some((warning) => warning.includes('checkout'))
      ? { url: String(source.settings.checkout_url) } : {};
    const pathname = normalizeVslPathname(String(source.binding?.normalized_pathname ?? `/${source.page.slug}`));
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${pageId}))`;
      const [prior] = await tx`SELECT project_id,step_id FROM vsl_legacy_project_links WHERE legacy_page_id=${pageId}`;
      if (prior) return { projectId: prior.project_id, stepId: prior.step_id, reused: true, warnings: source.warnings };
      const [project] = await tx`INSERT INTO vsl_projects(store_id,name,domain_id,default_checkout_config)
        VALUES('l0i',${String(source.page.title).slice(0, 200)},${source.binding?.domain_id ?? null},${tx.json(checkout)}) RETURNING id`;
      const [page] = await tx`INSERT INTO vsl_pages(store_id,name,legacy_page_id)
        VALUES('l0i',${String(source.page.title).slice(0, 200)},${pageId}) RETURNING id`;
      const manifest = source.revision.asset_manifest as Manifest;
      const fingerprint = hash(`legacy:${source.revision.id}:${hash(JSON.stringify(manifest))}`);
      const sourceSha = /^[0-9a-f]{64}$/.test(String(source.revision.checksum ?? ''))
        ? String(source.revision.checksum) : hash(String(source.revision.html_body ?? ''));
      const [revision] = await tx`INSERT INTO vsl_page_revisions(page_id,version_number,entry_path,storage_prefix,manifest,validation_report,
        source_sha256,fingerprint,status,legacy_revision_id)
        VALUES(${page!.id},1,${source.revision.entry_path},${source.revision.release_storage_prefix},${tx.json(manifest as never)},
          ${tx.json((source.revision.validation_report ?? {}) as never)},${sourceSha},${fingerprint},'ready',${source.revision.id}) RETURNING id`;
      await tx`UPDATE vsl_pages SET current_revision_id=${revision!.id} WHERE id=${page!.id}`;
      let videoId: string | null = null;
      if (source.video?.status === 'ready' && source.video.provider_asset_id) {
        const [video] = await tx`INSERT INTO vsl_video_assets(store_id,name,provider_asset_id,status,duration_seconds,bytes,mime_type,
          playback_url,poster_url,legacy_video_id)
          VALUES('l0i',${String(source.page.title).slice(0, 190) + ' video'},${source.video.provider_asset_id},'ready',
            ${source.video.duration_seconds},${source.video.bytes},${source.video.mime_type},${source.video.playback_url},
            ${source.video.poster_url},${source.video.id}) RETURNING id`;
        videoId = String(video!.id);
      }
      const placement = videoId && source.settings?.video_selector
        ? { strategy: 'SELECTOR', selector: String(source.settings.video_selector) } : {};
      const [step] = await tx`INSERT INTO vsl_steps(project_id,position,name,type,pathname,render_mode,page_revision_id,video_asset_id,video_placement)
        VALUES(${project!.id},0,${String(source.page.title).slice(0, 200)},'VSL',${pathname},'IMPORTED_PAGE',${revision!.id},
          ${videoId},${tx.json(placement)}) RETURNING id`;
      await tx`INSERT INTO vsl_legacy_project_links(legacy_page_id,legacy_revision_id,legacy_video_id,legacy_binding_id,project_id,step_id)
        VALUES(${pageId},${source.revision.id},${source.video?.id ?? null},${source.binding?.id ?? null},${project!.id},${step!.id})`;
      return { projectId: project!.id, stepId: step!.id, reused: false, warnings: source.warnings };
    });
  }
}
