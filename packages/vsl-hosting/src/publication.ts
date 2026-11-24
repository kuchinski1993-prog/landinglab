import { randomUUID } from 'node:crypto';

import type { Sql } from 'postgres';

import { type PublishProject, type PublishStep } from './draft-state.js';
import { vslError } from './errors.js';
import { validateFunnelGraph } from './funnels.js';
import { validateCheckoutConfig, validateCtaConfig, validatePlayerConfig, validateTrackingConfig } from './funnel-config.js';
import { VslError } from './imports.js';
import { normalizeVslPathname } from './pathnames.js';
import { blockingPublishItems, runPublishCheck } from './publish-check.js';
import { type Manifest, type VslStorage } from './storage.js';
import { ensureVslVideoOrigins } from './stream-origins.js';

export type { PublishProject, PublishStep } from './draft-state.js';

export function validatePublishSteps(steps: PublishStep[]): void {
  if (!steps.length) throw new VslError('Project needs at least one active step', 409);
  validateFunnelGraph(steps.map((step) => ({ id: step.id, pathname: step.pathname, nextStepId: step.next_step_id })));
  for (const step of steps) {
    let checkout;
    try {
      checkout = validateCheckoutConfig(step.checkout_config);
      validateTrackingConfig(step.tracking_config);
      validatePlayerConfig((step.video_placement as { player?: unknown } | null)?.player);
      if (step.cta_config && Object.keys(step.cta_config as object).length)
        validateCtaConfig(step.cta_config, Boolean(step.next_step_id), Boolean(checkout));
    } catch (error) { throw new VslError(error instanceof Error ? error.message : 'Invalid step configuration', 409); }
    if (step.render_mode === 'IMPORTED_PAGE' && !step.page_revision_id) throw new VslError(`Step ${step.name} needs a page revision`, 409);
    if (step.render_mode === 'NATIVE_VIDEO' && !step.video_asset_id) throw new VslError(`Step ${step.name} needs a video`, 409);
    if (step.render_mode === 'REDIRECT') {
      if (!checkout) throw new VslError(`Redirect step ${step.name} needs a HTTPS URL`, 409);
    }
    if (step.video_asset_id) {
      const placement = step.video_placement as { strategy?: unknown; selector?: unknown } | null;
      if (step.render_mode === 'NATIVE_VIDEO') {
        if (placement?.strategy && placement.strategy !== 'DEDICATED') throw new VslError('Dedicated player placement required', 409);
      } else if (!placement || !['PLACEHOLDER', 'SELECTOR'].includes(String(placement.strategy)) ||
        (placement.strategy === 'SELECTOR' && (typeof placement.selector !== 'string' || !placement.selector.trim())))
        throw new VslError(`Step ${step.name} needs explicit video placement`, 409);
    }
  }
}

export class VslPublication {
  constructor(readonly sql: Sql, readonly storage: VslStorage) {}

  async history(projectId: string) {
    const [project] = await this.sql`SELECT id,active_release_id FROM vsl_projects WHERE id=${projectId} AND store_id='l0i'`;
    if (!project) throw vslError('project_not_found');
    const releases = await this.sql`SELECT id,version_number,domain_id,previous_release_id,created_at FROM vsl_project_releases WHERE project_id=${projectId} ORDER BY version_number DESC`;
    const events = await this.sql`SELECT * FROM vsl_publication_events WHERE project_id=${projectId} ORDER BY created_at DESC LIMIT 100`;
    return { activeReleaseId: project.active_release_id, releases, events };
  }

  private async assertDomain(domainId: string) {
    const [domain] = await this.sql`SELECT id,hostname,dns_status,ssl_status,lifecycle_status FROM blackshop_domains WHERE id=${domainId}`;
    if (!domain || domain.dns_status !== 'verified' || domain.ssl_status !== 'provisioned' || domain.lifecycle_status !== 'active')
      throw vslError('domain_not_verified');
    const [landing] = await this.sql`SELECT id FROM landing_domains WHERE lower(domain)=lower(${domain.hostname}) LIMIT 1`;
    if (landing) throw vslError('domain_landinglab_conflict');
    const [legacyVsl] = await this.sql`SELECT id FROM vsl_domain_bindings WHERE domain_id=${domainId} AND publication_status='published' LIMIT 1`;
    if (legacyVsl) throw vslError('domain_in_use', undefined, 'O domínio ainda serve uma página VSL antiga.');
    return domain;
  }

  private async allowVideoOrigins(steps: PublishStep[], hostname: string) {
    const hosts = [hostname, process.env['VSL_PREVIEW_DOMAIN']].filter((value): value is string => Boolean(value));
    for (const id of new Set(steps.map((step) => step.video_asset_id).filter((value): value is string => Boolean(value))))
      await ensureVslVideoOrigins(this.sql, id, hosts);
  }

  private async assertPaths(domainId: string, projectId: string, paths: string[]) {
    for (const path of paths) {
      const pathname = normalizeVslPathname(path);
      const [legacy] = await this.sql`SELECT id FROM vsl_domain_bindings WHERE domain_id=${domainId} AND normalized_pathname=${pathname} AND publication_status='published' LIMIT 1`;
      if (legacy) throw vslError('pathname_conflict', { pathname });
      const [route] = await this.sql`SELECT project_id,publication_status FROM vsl_public_routes WHERE domain_id=${domainId} AND pathname=${pathname}`;
      if (route && route.project_id !== projectId && route.publication_status === 'published') throw vslError('pathname_conflict', { pathname });
    }
  }

  /** Checklist sem efeitos colaterais (mesmas regras do publish). */
  async check(projectId: string) {
    const { projectId: id, ready, items } = await runPublishCheck(this.sql, this.storage, projectId);
    return { projectId: id, ready, items };
  }

  async publish(projectId: string) {
    const check = await runPublishCheck(this.sql, this.storage, projectId);
    if (!check.ready) throw vslError('publish_check_failed', { items: blockingPublishItems(check.items) });
    const { project, hostname } = check;
    const effectiveSteps = check.steps;
    const steps = check.rawSteps;
    await this.allowVideoOrigins(effectiveSteps, String(hostname));
    return this.sql.begin(async (tx) => {
      const [locked] = await tx<PublishProject[]>`SELECT * FROM vsl_projects WHERE id=${projectId} AND store_id='l0i' FOR UPDATE`;
      if (!locked || locked.version !== project.version || locked.domain_id !== project.domain_id || locked.status === 'archived') throw vslError('publish_conflict');
      const latest = await tx<PublishStep[]>`SELECT * FROM vsl_steps WHERE project_id=${projectId} AND status!='archived' ORDER BY position FOR UPDATE`;
      if (JSON.stringify(latest) !== JSON.stringify(steps)) throw vslError('publish_conflict');
      const [version] = await tx`SELECT COALESCE(MAX(version_number),0)+1 AS next FROM vsl_project_releases WHERE project_id=${projectId}`;
      const releaseId = randomUUID();
      await tx`INSERT INTO vsl_project_releases(id,project_id,version_number,domain_id,previous_release_id,config_snapshot)
        VALUES(${releaseId},${projectId},${version!.next},${project.domain_id},${locked.active_release_id},${tx.json({ checkout: locked.default_checkout_config, tracking: locked.default_tracking_config } as never)})`;
      const releaseSteps = [];
      for (const step of effectiveSteps) {
        const stepReleaseId = randomUUID();
        await tx`INSERT INTO vsl_step_releases(id,project_release_id,step_id,position,name,type,pathname,render_mode,page_revision_id,video_asset_id,video_placement,checkout_config,cta_config,tracking_config,next_step_id)
          VALUES(${stepReleaseId},${releaseId},${step.id},${step.position},${step.name},${step.type},${step.pathname},${step.render_mode},${step.page_revision_id},${step.video_asset_id},${tx.json(step.video_placement as never)},${tx.json(step.checkout_config as never)},${tx.json(step.cta_config as never)},${tx.json(step.tracking_config as never)},${step.next_step_id})`;
        releaseSteps.push({ stepId: step.id, stepReleaseId, pathname: step.pathname });
      }
      await tx`UPDATE vsl_public_routes SET publication_status='unpublished',active_project_release_id=NULL,active_step_release_id=NULL,cache_version=cache_version+1,updated_at=now() WHERE project_id=${projectId}`;
      for (const step of releaseSteps) {
        const [bound] = await tx`INSERT INTO vsl_public_routes(domain_id,pathname,project_id,step_id,active_project_release_id,active_step_release_id,publication_status)
          VALUES(${project.domain_id},${step.pathname},${projectId},${step.stepId},${releaseId},${step.stepReleaseId},'published')
          ON CONFLICT(domain_id,pathname) DO UPDATE SET project_id=EXCLUDED.project_id,step_id=EXCLUDED.step_id,active_project_release_id=EXCLUDED.active_project_release_id,
          active_step_release_id=EXCLUDED.active_step_release_id,publication_status='published',cache_version=vsl_public_routes.cache_version+1,updated_at=now()
          WHERE vsl_public_routes.project_id=EXCLUDED.project_id OR vsl_public_routes.publication_status='unpublished' RETURNING id`;
        if (!bound) throw vslError('pathname_conflict', { pathname: step.pathname });
      }
      await tx`UPDATE vsl_projects SET active_release_id=${releaseId},status='published',version=version+1,updated_at=now() WHERE id=${projectId}`;
      await tx`UPDATE vsl_steps SET publication_state='published' WHERE project_id=${projectId} AND status!='archived'`;
      await tx`INSERT INTO vsl_publication_events(project_id,from_release_id,to_release_id,event_type) VALUES(${projectId},${locked.active_release_id},${releaseId},'publish')`;
      return { projectId, releaseId, version: version!.next, routes: releaseSteps.length };
    });
  }

  async rollback(projectId: string, releaseId: string) {
    const [release] = await this.sql`SELECT * FROM vsl_project_releases WHERE id=${releaseId} AND project_id=${projectId}`;
    if (!release) throw vslError('release_not_found');
    const domain = await this.assertDomain(String(release.domain_id));
    const steps = await this.sql<Array<PublishStep & { step_id: string }>>`SELECT * FROM vsl_step_releases WHERE project_release_id=${releaseId} ORDER BY position`;
    if (!steps.length) throw vslError('release_unavailable');
    await this.assertPaths(String(release.domain_id), projectId, steps.map((step) => String(step.pathname)));
    for (const step of steps) {
      if (step.page_revision_id) {
        const [page] = await this.sql`SELECT manifest,storage_prefix,status FROM vsl_page_revisions WHERE id=${step.page_revision_id}`;
        if (!page || page.status !== 'ready' || !(await this.storage.isSealed(String(page.storage_prefix), page.manifest as Manifest)))
          throw vslError('release_unavailable', { stepId: step.step_id });
      }
      if (step.video_asset_id) {
        const [video] = await this.sql`SELECT status FROM vsl_video_assets WHERE id=${step.video_asset_id}`;
        if (!video || video.status !== 'ready') throw vslError('release_unavailable', { stepId: step.step_id });
      }
    }
    await this.allowVideoOrigins(steps, String(domain.hostname));
    return this.sql.begin(async (tx) => {
      const [project] = await tx`SELECT * FROM vsl_projects WHERE id=${projectId} AND store_id='l0i' FOR UPDATE`;
      if (!project || project.status === 'archived') throw vslError('project_not_editable');
      await tx`UPDATE vsl_public_routes SET publication_status='unpublished',active_project_release_id=NULL,active_step_release_id=NULL,cache_version=cache_version+1,updated_at=now() WHERE project_id=${projectId}`;
      for (const step of steps) {
        const [bound] = await tx`INSERT INTO vsl_public_routes(domain_id,pathname,project_id,step_id,active_project_release_id,active_step_release_id,publication_status)
          VALUES(${release.domain_id},${step.pathname},${projectId},${step.step_id},${releaseId},${step.id},'published')
          ON CONFLICT(domain_id,pathname) DO UPDATE SET project_id=EXCLUDED.project_id,step_id=EXCLUDED.step_id,active_project_release_id=EXCLUDED.active_project_release_id,
          active_step_release_id=EXCLUDED.active_step_release_id,publication_status='published',cache_version=vsl_public_routes.cache_version+1,updated_at=now()
          WHERE vsl_public_routes.project_id=EXCLUDED.project_id OR vsl_public_routes.publication_status='unpublished' RETURNING id`;
        if (!bound) throw vslError('pathname_conflict', { pathname: step.pathname });
      }
      await tx`UPDATE vsl_projects SET domain_id=${release.domain_id},active_release_id=${releaseId},status='published',version=version+1,updated_at=now() WHERE id=${projectId}`;
      await tx`UPDATE vsl_steps SET publication_state='unpublished' WHERE project_id=${projectId}`;
      for (const step of steps) await tx`UPDATE vsl_steps SET publication_state='published' WHERE id=${step.step_id} AND project_id=${projectId}`;
      await tx`INSERT INTO vsl_publication_events(project_id,from_release_id,to_release_id,event_type) VALUES(${projectId},${project.active_release_id},${releaseId},'rollback')`;
      return { projectId, releaseId, routes: steps.length };
    });
  }

  async unpublish(projectId: string) {
    return this.sql.begin(async (tx) => {
      const [project] = await tx`SELECT * FROM vsl_projects WHERE id=${projectId} AND store_id='l0i' FOR UPDATE`;
      if (!project) throw vslError('project_not_found');
      if (!project.active_release_id) return { projectId, unpublished: false };
      await tx`UPDATE vsl_public_routes SET publication_status='unpublished',active_project_release_id=NULL,active_step_release_id=NULL,cache_version=cache_version+1,updated_at=now() WHERE project_id=${projectId}`;
      await tx`UPDATE vsl_projects SET active_release_id=NULL,status='draft',version=version+1,updated_at=now() WHERE id=${projectId}`;
      await tx`UPDATE vsl_steps SET publication_state='unpublished' WHERE project_id=${projectId}`;
      await tx`INSERT INTO vsl_publication_events(project_id,from_release_id,to_release_id,event_type) VALUES(${projectId},${project.active_release_id},NULL,'unpublish')`;
      return { projectId, unpublished: true };
    });
  }
}
