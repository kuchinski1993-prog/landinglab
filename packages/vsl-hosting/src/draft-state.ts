// Rascunho (vsl_steps/vsl_projects) x release ativa (snapshot imutável).
// O público serve sempre a release ativa; `hasUnpublishedChanges` compara o hash do
// rascunho efetivo com o hash do snapshot da release (mesma normalização do publish).
import type { Sql } from 'postgres';

import { canonical } from './analysis.js';
import { digest } from './storage.js';

export interface PublishStep {
  id: string; project_id: string; position: number; name: string; type: string; pathname: string;
  status: string; render_mode: string; page_revision_id: string | null; video_asset_id: string | null;
  video_placement: unknown; checkout_config: unknown; cta_config: unknown; tracking_config: unknown;
  next_step_id: string | null;
}
export interface PublishProject {
  id: string; store_id: string; name?: string; domain_id: string | null; active_release_id: string | null; status: string;
  version: number; default_checkout_config: unknown; default_tracking_config: unknown;
}

const isEmpty = (value: unknown) => !value || typeof value !== 'object' || !Object.keys(value as object).length;

/** Config efetiva por etapa, exatamente como o publish grava em vsl_step_releases. */
export function effectiveSteps<T extends PublishStep>(project: Pick<PublishProject, 'default_checkout_config' | 'default_tracking_config'>, steps: T[]): T[] {
  return steps.map((step) => ({
    ...step,
    checkout_config: isEmpty(step.checkout_config) ? project.default_checkout_config : step.checkout_config,
    tracking_config: { ...(project.default_tracking_config as object), ...(step.tracking_config as object) },
  }));
}

interface SnapshotStep {
  stepId: string; position: number; name: string; type: string; pathname: string; renderMode: string;
  pageRevisionId: string | null; videoAssetId: string | null; videoPlacement: unknown;
  checkout: unknown; cta: unknown; tracking: unknown; nextStepId: string | null;
}

export function snapshotHash(domainId: string | null, config: { checkout: unknown; tracking: unknown }, steps: SnapshotStep[]): string {
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  return digest(canonical({ domainId, config: { checkout: config.checkout ?? {}, tracking: config.tracking ?? {} }, steps: ordered.map((step) => ({
    ...step, videoPlacement: step.videoPlacement ?? {}, checkout: step.checkout ?? {}, cta: step.cta ?? {}, tracking: step.tracking ?? {},
  })) }));
}

export function draftHash(project: PublishProject, steps: PublishStep[]): string {
  return snapshotHash(project.domain_id, { checkout: project.default_checkout_config, tracking: project.default_tracking_config },
    effectiveSteps(project, steps.filter((step) => step.status !== 'archived')).map((step) => ({
      stepId: step.id, position: step.position, name: step.name, type: step.type, pathname: step.pathname, renderMode: step.render_mode,
      pageRevisionId: step.page_revision_id, videoAssetId: step.video_asset_id, videoPlacement: step.video_placement,
      checkout: step.checkout_config, cta: step.cta_config, tracking: step.tracking_config, nextStepId: step.next_step_id,
    })));
}

interface ReleaseRow { id: string; project_id: string; version_number: number; domain_id: string; config_snapshot: { checkout?: unknown; tracking?: unknown }; created_at: Date }
interface StepReleaseRow extends Omit<PublishStep, 'id' | 'project_id' | 'status'> { project_release_id: string; step_id: string }

export function releaseHash(release: ReleaseRow, steps: StepReleaseRow[]): string {
  return snapshotHash(release.domain_id, { checkout: release.config_snapshot?.checkout, tracking: release.config_snapshot?.tracking },
    steps.map((step) => ({
      stepId: step.step_id, position: step.position, name: step.name, type: step.type, pathname: step.pathname, renderMode: step.render_mode,
      pageRevisionId: step.page_revision_id, videoAssetId: step.video_asset_id, videoPlacement: step.video_placement,
      checkout: step.checkout_config, cta: step.cta_config, tracking: step.tracking_config, nextStepId: step.next_step_id,
    })));
}

export interface DraftState {
  activeRelease: { id: string; versionNumber: number; domainId: string; createdAt: Date } | null;
  hasUnpublishedChanges: boolean;
}

/** Estado rascunho x release para vários projetos (2 consultas por lote). */
export async function draftStates(sql: Sql, projects: PublishProject[]): Promise<Map<string, DraftState>> {
  const result = new Map<string, DraftState>();
  const published = projects.filter((project) => project.active_release_id);
  for (const project of projects) result.set(project.id, { activeRelease: null, hasUnpublishedChanges: false });
  if (!published.length) return result;
  const releaseIds = published.map((project) => project.active_release_id!);
  const projectIds = published.map((project) => project.id);
  const releases = await sql<ReleaseRow[]>`SELECT * FROM vsl_project_releases WHERE id IN ${sql(releaseIds)}`;
  const releaseSteps = await sql<StepReleaseRow[]>`SELECT * FROM vsl_step_releases WHERE project_release_id IN ${sql(releaseIds)}`;
  const steps = await sql<PublishStep[]>`SELECT * FROM vsl_steps WHERE project_id IN ${sql(projectIds)} AND status<>'archived'`;
  for (const project of published) {
    const release = releases.find((row) => row.id === project.active_release_id);
    if (!release) continue;
    const draft = draftHash(project, steps.filter((step) => step.project_id === project.id));
    const active = releaseHash(release, releaseSteps.filter((step) => step.project_release_id === release.id));
    result.set(project.id, {
      activeRelease: { id: release.id, versionNumber: release.version_number, domainId: release.domain_id, createdAt: release.created_at },
      hasUnpublishedChanges: draft !== active,
    });
  }
  return result;
}
