// Checklist de publicação, publish/rollback com códigos e rascunho x release (Postgres real).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { draftStates, type PublishProject } from '../draft-state.js';
import { VslPageImportJobs } from '../page-import-jobs.js';
import { VslPublication } from '../publication.js';
import { runPublishCheck } from '../publish-check.js';
import { LocalVslStorage } from '../storage.js';
import { startVslTestDatabase, type VslTestDatabase } from '../testing/pg-harness.js';

let db: VslTestDatabase;
let root: string;
let storage: LocalVslStorage;
beforeAll(async () => { db = await startVslTestDatabase(); }, 60_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.reset();
  root = await mkdtemp(path.join(tmpdir(), 'vsl-publish-'));
  storage = new LocalVslStorage(root);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const html = Buffer.from('<html><body><h1>Oferta</h1><div data-blackshop-video></div><a id="cta" href="#">Comprar</a></body></html>');
const CHECKOUT = { url: 'https://pay.example.com/checkout' };

async function importedRevision(): Promise<string> {
  const [page] = await db.sql`INSERT INTO vsl_pages(name) VALUES('Página') RETURNING id`;
  const jobs = new VslPageImportJobs(db.sql, storage);
  const { job } = await jobs.submit({ pageId: String(page!.id), idempotencyKey: 'k', kind: 'html', config: {}, contentLength: html.length, source: Readable.from([html]) });
  await jobs.process((await jobs.claimNext())!);
  return String((await jobs.get(String(page!.id), job.id)).result!.revisionId);
}
async function verifiedDomain(hostname = 'oferta.example.com'): Promise<string> {
  const [domain] = await db.sql`INSERT INTO blackshop_domains(hostname,dns_status,ssl_status,lifecycle_status) VALUES(${hostname},'verified','provisioned','active') RETURNING id`;
  return String(domain!.id);
}
async function project(domainId: string | null, name = 'Funil') {
  const [row] = await db.sql`INSERT INTO vsl_projects(name,domain_id,default_checkout_config) VALUES(${name},${domainId},${db.sql.json(CHECKOUT)}) RETURNING id`;
  return String(row!.id);
}
async function step(projectId: string, revisionId: string, extra: { pathname?: string; cta?: unknown; position?: number } = {}) {
  const [row] = await db.sql`INSERT INTO vsl_steps(project_id,position,name,pathname,page_revision_id,cta_config)
    VALUES(${projectId},${extra.position ?? 0},'Página de vendas',${extra.pathname ?? '/'},${revisionId},${db.sql.json((extra.cta ?? {}) as never)}) RETURNING id`;
  return String(row!.id);
}
const cta = (unlockAfterSeconds: number) => ({ ctas: [{ id: 'buy', selectors: ['#cta'], unlockAfterSeconds, action: { type: 'CHECKOUT' } }] });
const failing = (items: Array<{ code: string; ok: boolean; severity: string }>) => items.filter((item) => !item.ok && item.severity === 'blocking').map((item) => item.code).sort();
const warnings = (items: Array<{ code: string; ok: boolean; severity: string }>) => items.filter((item) => item.severity === 'warning').map((item) => item.code).sort();

describe('publish check', () => {
  it('lists every blocking item with PT-BR messages and fix hints', async () => {
    const id = await project(null);
    const result = await runPublishCheck(db.sql, storage, id);
    expect(result.ready).toBe(false);
    expect(failing(result.items)).toEqual(['domain_selected', 'has_steps']);
    const domainItem = result.items.find((item) => item.code === 'domain_selected')!;
    expect(domainItem.message).toBe('Nenhum domínio selecionado.');
    expect(domainItem.fixHint).toMatch(/domínio/);
  });

  it('flags unverified/LandingLab domains; timed CTA without video and dynamic CTA targets are warnings (F2)', async () => {
    const [domain] = await db.sql`INSERT INTO blackshop_domains(hostname) VALUES('lp.example.com') RETURNING id`;
    await db.sql`INSERT INTO landing_pages(slug,title,currency,fulfillment_type,html_body,price) VALUES('x','x','USD','info_product','',0)`;
    await db.sql`INSERT INTO landing_domains(landing_page_id,domain,role) SELECT id,'lp.example.com','primary' FROM landing_pages LIMIT 1`;
    const revision = await importedRevision();
    const id = await project(String(domain!.id));
    await step(id, revision, { cta: cta(30) });
    let result = await runPublishCheck(db.sql, storage, id);
    expect(failing(result.items)).toEqual(['domain_not_landinglab', 'domain_verified']);
    expect(warnings(result.items)).toEqual(['CTA_TIMED_WITHOUT_VIDEO']);
    expect(result.items.find((item) => item.code === 'CTA_TIMED_WITHOUT_VIDEO')).toMatchObject({ ok: false, severity: 'warning', ctaId: 'buy', stepId: expect.any(String) });

    // Seletor ausente do HTML estático = CTA dinâmico (aviso); seletor ilegível = bloqueante.
    await db.sql`UPDATE vsl_steps SET cta_config=${db.sql.json({ ctas: [{ id: 'buy', selectors: ['#nao-existe'], unlockAfterSeconds: 0, action: { type: 'CHECKOUT' } }] })}`;
    result = await runPublishCheck(db.sql, storage, id);
    expect(failing(result.items)).toEqual(['domain_not_landinglab', 'domain_verified']);
    expect(result.items.find((item) => item.code === 'CTA_SELECTOR_DYNAMIC')).toMatchObject({ severity: 'warning', ctaId: 'buy', selector: '#nao-existe' });
    await db.sql`UPDATE vsl_steps SET cta_config=${db.sql.json({ ctas: [{ id: 'buy', selectors: ['a['], unlockAfterSeconds: 0, action: { type: 'CHECKOUT' } }] })}`;
    expect(failing((await runPublishCheck(db.sql, storage, id)).items)).toContain('step_cta');
  });

  it('publishes with warnings only and blocks an invalid player config', async () => {
    const revision = await importedRevision();
    const id = await project(await verifiedDomain());
    const stepId = await step(id, revision, { cta: { ctas: [{ id: 'quiz', selectors: ['#gerado-por-js'], unlockAfterSeconds: 20, action: { type: 'CHECKOUT' } }] } });
    const publication = new VslPublication(db.sql, storage);
    const check = await publication.check(id);
    expect(check.ready).toBe(true);
    expect(warnings(check.items)).toEqual(['CTA_SELECTOR_DYNAMIC', 'CTA_TIMED_WITHOUT_VIDEO']);
    await db.sql`UPDATE vsl_steps SET video_placement=${db.sql.json({ player: { barColor: 'red' } })} WHERE id=${stepId}`;
    const blocked = await publication.check(id);
    expect(blocked.ready).toBe(false);
    expect(failing(blocked.items)).toEqual(['step_player']);
    await expect(publication.publish(id)).rejects.toMatchObject({ code: 'publish_check_failed', details: { items: [expect.objectContaining({ code: 'step_player', severity: 'blocking' })] } });
    await db.sql`UPDATE vsl_steps SET video_placement=${db.sql.json({ player: { barColor: '#00FF00', aspectRatio: '9:16' } })} WHERE id=${stepId}`;
    expect((await publication.publish(id)).releaseId).toEqual(expect.any(String));
  });

  it('checks video readiness and placement, and Stream configuration', async () => {
    const revision = await importedRevision();
    const id = await project(await verifiedDomain());
    const stepId = await step(id, revision);
    const [video] = await db.sql`INSERT INTO vsl_video_assets(name,status) VALUES('v','processing') RETURNING id`;
    await db.sql`UPDATE vsl_steps SET video_asset_id=${video!.id} WHERE id=${stepId}`;
    let result = await runPublishCheck(db.sql, storage, id, { env: {} });
    expect(failing(result.items)).toEqual(['step_video_placement', 'step_video_ready', 'stream_configured']);
    await db.sql`UPDATE vsl_video_assets SET status='ready'`;
    await db.sql`UPDATE vsl_steps SET video_placement=${db.sql.json({ strategy: 'PLACEHOLDER' })}`;
    result = await runPublishCheck(db.sql, storage, id, { env: { VSL_STREAM_ACCOUNT_ID: 'a', VSL_STREAM_API_TOKEN: 't' } });
    expect(result.ready).toBe(true);
    expect(result.items.find((item) => item.code === 'step_video_placement')).toMatchObject({ ok: true, stepId });
  });

  it('detects pathnames already published by another project', async () => {
    const domainId = await verifiedDomain();
    const revision = await importedRevision();
    const first = await project(domainId, 'A');
    await step(first, revision, { pathname: '/oferta' });
    await new VslPublication(db.sql, storage).publish(first);
    const second = await project(domainId, 'B');
    await step(second, revision, { pathname: '/oferta' });
    const result = await runPublishCheck(db.sql, storage, second);
    expect(failing(result.items)).toEqual(['paths_available']);
    const conflict = result.items.find((item) => item.code === 'paths_available')!;
    expect(conflict.message).toContain('/oferta');
    expect(conflict.message).toContain('"A"');
    expect(conflict.fixHint).toContain('"A"');
    await expect(new VslPublication(db.sql, storage).publish(second)).rejects.toMatchObject({
      code: 'publish_check_failed', statusCode: 409, details: { items: [expect.objectContaining({ code: 'paths_available' })] },
    });
  });
});

describe('published funnel stays editable (draft x release)', () => {
  it('publishes, tracks unpublished changes and keeps releases immutable', async () => {
    const revision = await importedRevision();
    const id = await project(await verifiedDomain());
    const stepId = await step(id, revision, { cta: cta(0) });
    const publication = new VslPublication(db.sql, storage);
    expect((await publication.check(id)).ready).toBe(true);
    const published = await publication.publish(id);

    const load = async () => (await db.sql<PublishProject[]>`SELECT * FROM vsl_projects WHERE id=${id}`)[0]!;
    let state = (await draftStates(db.sql, [await load()])).get(id)!;
    expect(state).toMatchObject({ hasUnpublishedChanges: false, activeRelease: { id: published.releaseId, versionNumber: 1 } });

    await db.sql`UPDATE vsl_steps SET name='Nova copy' WHERE id=${stepId}`;
    state = (await draftStates(db.sql, [await load()])).get(id)!;
    expect(state.hasUnpublishedChanges).toBe(true);
    // A rota pública continua apontando para a release ativa.
    const [route] = await db.sql`SELECT active_project_release_id FROM vsl_public_routes WHERE project_id=${id}`;
    expect(route?.active_project_release_id).toBe(published.releaseId);

    await db.sql`UPDATE vsl_steps SET name='Página de vendas' WHERE id=${stepId}`;
    expect((await draftStates(db.sql, [await load()])).get(id)!.hasUnpublishedChanges).toBe(false);

    // Mudar default de checkout do projeto também conta como alteração.
    await db.sql`UPDATE vsl_projects SET default_checkout_config=${db.sql.json({ url: 'https://pay.example.com/v2' })} WHERE id=${id}`;
    expect((await draftStates(db.sql, [await load()])).get(id)!.hasUnpublishedChanges).toBe(true);

    const second = await publication.publish(id);
    expect(second.version).toBe(2);
    await expect(db.sql`UPDATE vsl_project_releases SET config_snapshot='{}' WHERE id=${published.releaseId}`).rejects.toThrow(/immutable/);

    const rolled = await publication.rollback(id, published.releaseId);
    expect(rolled.releaseId).toBe(published.releaseId);
    await expect(publication.rollback(id, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'release_not_found' });
    expect((await publication.history(id)).releases).toHaveLength(2);
    expect(await publication.unpublish(id)).toEqual({ projectId: id, unpublished: true });
    expect((await draftStates(db.sql, [await load()])).get(id)).toEqual({ activeRelease: null, hasUnpublishedChanges: false });
  });

  it('rejects unknown and archived projects with stable codes', async () => {
    await expect(runPublishCheck(db.sql, storage, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'project_not_found' });
    const id = await project(null);
    await db.sql`UPDATE vsl_projects SET status='archived' WHERE id=${id}`;
    await expect(runPublishCheck(db.sql, storage, id)).rejects.toMatchObject({ code: 'project_not_editable' });
  });
});

describe('herança de checkout/pixels projeto → etapa', () => {
  it('etapa com config vazio ({}) publica com o checkout e os pixels do projeto; pixels da etapa sobrescrevem só o que definem', async () => {
    const revision = await importedRevision();
    const id = await project(await verifiedDomain());
    const tracking = { enabled: true, metaPixelId: '111', googleAdsId: 'AW-1' };
    await db.sql`UPDATE vsl_projects SET default_tracking_config=${db.sql.json(tracking)} WHERE id=${id}`;
    const inherits = await step(id, revision, { pathname: '/oferta', cta: cta(0) });
    const overrides = await step(id, revision, { pathname: '/video', cta: cta(0), position: 1 });
    await db.sql`UPDATE vsl_steps SET checkout_config='{}', tracking_config='{}' WHERE id=${inherits}`;
    await db.sql`UPDATE vsl_steps SET checkout_config=${db.sql.json({ url: 'https://pay.example.com/etapa' })},
      tracking_config=${db.sql.json({ metaPixelId: '222' })} WHERE id=${overrides}`;
    const { releaseId } = await new VslPublication(db.sql, storage).publish(id);
    const rows = await db.sql`SELECT step_id, checkout_config, tracking_config FROM vsl_step_releases WHERE project_release_id=${releaseId}`;
    const byStep = Object.fromEntries(rows.map((row) => [String(row.step_id), row]));
    expect(byStep[inherits]).toMatchObject({ checkout_config: CHECKOUT, tracking_config: tracking });
    expect(byStep[overrides]).toMatchObject({ checkout_config: { url: 'https://pay.example.com/etapa' },
      tracking_config: { enabled: true, metaPixelId: '222', googleAdsId: 'AW-1' } });
    // Mudar o padrão do projeto muda o rascunho efetivo da etapa que herda.
    await db.sql`UPDATE vsl_projects SET default_tracking_config=${db.sql.json({ ...tracking, metaPixelId: '333' })} WHERE id=${id}`;
    const [loaded] = await db.sql<PublishProject[]>`SELECT * FROM vsl_projects WHERE id=${id}`;
    expect((await draftStates(db.sql, [loaded!])).get(id)!.hasUnpublishedChanges).toBe(true);
  });
});
