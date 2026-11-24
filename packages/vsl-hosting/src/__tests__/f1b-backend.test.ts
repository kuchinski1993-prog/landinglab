// F1b (Postgres real): GC de storage/jobs, domínio suspenso só volta com reactivate, tempo médio assistido com
// sessões de play sem heartbeat, grant de prévia com picker, usedBy na biblioteca e 0089 no banco.
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  digest, LocalVslStorage, projectAnalytics, runVslGc, signFunnelPreview, verifyFunnelPreview, VslDomainService, VslIndependentPages,
  VslIndependentVideos, type Manifest, type StreamAdapter,
} from '../index.js';
import { startVslTestDatabase, type VslTestDatabase } from '../testing/pg-harness.js';

let db: VslTestDatabase;
let root: string;
let storage: LocalVslStorage;
beforeAll(async () => {
  db = await startVslTestDatabase();
  root = await mkdtemp(path.join(tmpdir(), 'vsl-f1b-'));
  storage = new LocalVslStorage(root);
}, 60_000);
afterAll(async () => {
  await db?.close();
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => { await db.reset(); });

const OLD = new Date(Date.now() - 10 * 86_400_000);
async function sealedRevision(pageId: string, createdAt = OLD) {
  const id = randomUUID();
  const prefix = `vsl/releases/${pageId}/${id}`;
  const html = Buffer.from(`<html><body><h1>${id}</h1></body></html>`);
  const manifest: Manifest = { version: 1, entryPath: 'index.html', files: { 'index.html': { storageKey: 'index.html', mimeType: 'text/html', bytes: html.length, sha256: digest(html) } } };
  await storage.putExclusive(`${prefix}/index.html`, html);
  await storage.seal(prefix, manifest);
  const [count] = await db.sql`SELECT COALESCE(MAX(version_number),0)+1 AS next FROM vsl_page_revisions WHERE page_id=${pageId}`;
  await db.sql`INSERT INTO vsl_page_revisions(id,page_id,version_number,entry_path,storage_prefix,manifest,source_sha256,fingerprint,created_at)
    VALUES(${id},${pageId},${count!.next},'index.html',${prefix},${db.sql.json(manifest as never)},${digest(html)},${digest(id)},${createdAt})`;
  return { id, prefix };
}
const exists = (key: string) => storage.read(key).then(() => true, () => false);
async function ageTree(dir: string) {
  const { readdir } = await import('node:fs/promises');
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await ageTree(full);
    await utimes(full, OLD, OLD);
  }
}

describe('runVslGc', () => {
  it('dry-run reports, then removes orphan revisions, stale jobs and leftover prefixes — never referenced data', async () => {
    const [page] = await db.sql`INSERT INTO vsl_pages(name) VALUES('P') RETURNING id`;
    const pageId = String(page!.id);
    const current = await sealedRevision(pageId);
    const usedByStep = await sealedRevision(pageId);
    const orphan = await sealedRevision(pageId);
    const recentOrphan = await sealedRevision(pageId, new Date());
    await db.sql`UPDATE vsl_pages SET current_revision_id=${current.id} WHERE id=${pageId}`;
    const [project] = await db.sql`INSERT INTO vsl_projects(name) VALUES('F') RETURNING id`;
    await db.sql`INSERT INTO vsl_steps(project_id,position,name,pathname,page_revision_id) VALUES(${project!.id},0,'S','/',${usedByStep.id})`;
    // Job parado em needs_resolution há 10 dias, com upload.
    const jobId = randomUUID();
    await storage.putExclusive(`vsl/sources/g3/${jobId}/original.html`, Buffer.from('<p>x</p>'));
    await db.sql`INSERT INTO vsl_page_import_jobs(id,page_id,idempotency_key,request_hash,kind,source_key,source_bytes,source_sha256,state,stage,updated_at)
      VALUES(${jobId},${pageId},'k','h','html',${`vsl/sources/g3/${jobId}/original.html`},8,${'a'.repeat(64)},'needs_resolution','needs_resolution',${OLD})`;
    // Restos sem dono: upload sem job e prefixo de revisão sem linha (escrita interrompida).
    const strayJob = randomUUID(), strayRevision = randomUUID();
    await mkdir(path.join(root, 'vsl/sources/g3', strayJob), { recursive: true });
    await writeFile(path.join(root, 'vsl/sources/g3', strayJob, 'original.zip'), 'zip');
    await mkdir(path.join(root, 'vsl/releases', pageId, strayRevision), { recursive: true });
    await writeFile(path.join(root, 'vsl/releases', pageId, strayRevision, 'index.html'), 'partial');
    await ageTree(path.join(root, 'vsl'));
    // Legacy (landing page) nunca é tocado.
    await mkdir(path.join(root, 'vsl/releases', randomUUID(), randomUUID()), { recursive: true });

    const log = { info: vi.fn(), warn: vi.fn() };
    const dry = await runVslGc(db.sql, storage, { dryRun: true, log });
    expect(dry).toMatchObject({ dryRun: true, expiredJobs: [jobId], revisions: [orphan.id], errors: 0 });
    expect(dry.sourcePrefixes).toEqual([`vsl/sources/g3/${strayJob}`]);
    expect(dry.releasePrefixes).toEqual([`vsl/releases/${pageId}/${strayRevision}`]);
    expect(await exists(`${orphan.prefix}/index.html`)).toBe(true);
    expect((await db.sql`SELECT state FROM vsl_page_import_jobs WHERE id=${jobId}`)[0]!.state).toBe('needs_resolution');
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true, revisions: 1 }), expect.stringContaining('dry-run'));

    const real = await runVslGc(db.sql, storage, { dryRun: false, log });
    expect(real).toMatchObject({ expiredJobs: [jobId], revisions: [orphan.id], errors: 0 });
    expect(await exists(`${orphan.prefix}/index.html`)).toBe(false);
    for (const kept of [current, usedByStep, recentOrphan]) expect(await exists(`${kept.prefix}/index.html`), kept.id).toBe(true);
    expect(await exists(`vsl/sources/g3/${jobId}/original.html`)).toBe(false);
    expect(await exists(`vsl/sources/g3/${strayJob}/original.zip`)).toBe(false);
    expect(await exists(`vsl/releases/${pageId}/${strayRevision}/index.html`)).toBe(false);
    const [job] = await db.sql`SELECT state,error_code FROM vsl_page_import_jobs WHERE id=${jobId}`;
    expect(job).toMatchObject({ state: 'failed', error_code: 'import_expired' });
    const [archived] = await db.sql`SELECT status,storage_deleted_at FROM vsl_page_revisions WHERE id=${orphan.id}`;
    expect(archived!.status).toBe('archived');
    expect(archived!.storage_deleted_at).toBeTruthy();
    // Idempotente: nada mais a fazer.
    expect(await runVslGc(db.sql, storage, { dryRun: false })).toMatchObject({ expiredJobs: [], revisions: [], sourcePrefixes: [], releasePrefixes: [] });
  });
});

describe('domain lifecycle', () => {
  const healthy = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://cloudflare-dns.com/')) return Response.json({ Status: 0, Answer: [{ type: 5, data: 'cname.vercel-dns.com.' }, { type: 1, data: '76.76.21.21' }] });
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
  const healthProbe = async () => ({ status: 200, body: JSON.stringify({ service: 'blackshop-vsl-runtime' }) });

  it('verify never reactivates a suspended domain; reactivate does', async () => {
    const service = new VslDomainService(db.sql, { fetch: healthy, healthProbe, vercel: null, env: {} });
    const { domain } = await service.add('vsl.oferta.com');
    await db.sql`UPDATE blackshop_domains SET lifecycle_status='suspended' WHERE id=${domain.id}`;
    const checked = await service.verify(domain.id);
    expect(checked).toMatchObject({ lifecycleStatus: 'suspended', dnsStatus: 'verified', sslStatus: 'provisioned', status: { code: 'suspended' } });
    expect(await service.reactivate(domain.id)).toMatchObject({ lifecycleStatus: 'active', status: { code: 'active' } });
    await expect(service.reactivate(domain.id)).rejects.toMatchObject({ code: 'domain_not_suspended' });
    await expect(service.reactivate(randomUUID())).rejects.toMatchObject({ code: 'domain_not_found' });
  });
});

describe('analytics watch time', () => {
  it('counts sessions that played without a heartbeat as 0 s in the average', async () => {
    const { sql } = db;
    const [domain] = await sql`INSERT INTO blackshop_domains(hostname) VALUES('a.example.com') RETURNING id`;
    const [project] = await sql`INSERT INTO vsl_projects(name) VALUES('Funil') RETURNING id`;
    const [step] = await sql`INSERT INTO vsl_steps(project_id,position,name,pathname) VALUES(${project!.id},0,'VSL','/') RETURNING id`;
    const [release] = await sql`INSERT INTO vsl_project_releases(project_id,version_number,domain_id) VALUES(${project!.id},1,${domain!.id}) RETURNING id`;
    const at = '2026-10-05T10:00:00Z';
    const [a, b] = [randomUUID(), randomUUID()];
    for (const session of [a, b])
      await sql`INSERT INTO vsl_events(event_id,project_id,step_id,release_id,session_id,event_name,cta_id,event_at,received_at)
        VALUES(${randomUUID()},${project!.id},${step!.id},${release!.id},${session},'VSLStart','',${at},${at})`;
    await sql`INSERT INTO vsl_watch_sessions(release_id,project_id,step_id,session_id,watched_seconds,watched_percentage,updated_at)
      VALUES(${release!.id},${project!.id},${step!.id},${a},100,0.5,${at})`;
    const report = await projectAnalytics(sql, String(project!.id), { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-07T00:00:00Z') });
    expect(report.steps[0]).toMatchObject({ plays: 2, watchedSessions: 2, averageWatchedSeconds: 50, averageWatchedPercentage: 0.25 });
    expect(report.totals.averageWatchedSeconds).toBe(50);
  });
});

describe('library usedBy', () => {
  it('lists the active steps using each page and video', async () => {
    const [page] = await db.sql`INSERT INTO vsl_pages(name) VALUES('Página') RETURNING id`;
    const revision = await sealedRevision(String(page!.id));
    const [video] = await db.sql`INSERT INTO vsl_video_assets(name,status) VALUES('Vídeo','ready') RETURNING id`;
    const [project] = await db.sql`INSERT INTO vsl_projects(name) VALUES('Funil A') RETURNING id`;
    const [archivedProject] = await db.sql`INSERT INTO vsl_projects(name,status) VALUES('Velho','archived') RETURNING id`;
    const [step] = await db.sql`INSERT INTO vsl_steps(project_id,position,name,pathname,page_revision_id,video_asset_id)
      VALUES(${project!.id},0,'VSL','/',${revision.id},${video!.id}) RETURNING id`;
    await db.sql`INSERT INTO vsl_steps(project_id,position,name,pathname,page_revision_id) VALUES(${archivedProject!.id},0,'X','/',${revision.id})`;
    const pages = await new VslIndependentPages(db.sql, storage).list();
    expect(pages[0]!.usedBy).toEqual([{ projectId: project!.id, projectName: 'Funil A', stepId: step!.id, stepName: 'VSL', pageRevisionId: revision.id }]);
    const videos = await new VslIndependentVideos(db.sql, {} as StreamAdapter, async () => []).list();
    expect(videos[0]!.usedBy).toEqual([{ projectId: project!.id, projectName: 'Funil A', stepId: step!.id, stepName: 'VSL' }]);
  });
});

describe('preview grant picker', () => {
  const secret = 's'.repeat(32);
  const projectId = randomUUID();
  it('carries the picker mode signed in the grant', () => {
    expect(verifyFunnelPreview(signFunnelPreview(projectId, secret, undefined, 900, { picker: 'cta' }), secret)).toMatchObject({ projectId, picker: 'cta' });
    expect(verifyFunnelPreview(signFunnelPreview(projectId, secret), secret)?.picker).toBeUndefined();
    expect(() => signFunnelPreview(projectId, secret, undefined, 900, { picker: 'x' as never })).toThrow();
  });
});

describe('0089 on Postgres', () => {
  it('enables RLS on new tables and guards derived jobs/translations', async () => {
    const rls = await db.sql`SELECT relname,relrowsecurity FROM pg_class WHERE relname IN ('vsl_page_translations','vsl_page_translation_units') ORDER BY relname`;
    expect(rls.map((row) => row.relrowsecurity)).toEqual([true, true]);
    const [page] = await db.sql`INSERT INTO vsl_pages(name,locale) VALUES('p','it') RETURNING id`;
    await expect(db.sql`INSERT INTO vsl_pages(name,locale) VALUES('p','italiano')`).rejects.toThrow(/locale_check/);
    await expect(db.sql`INSERT INTO vsl_page_import_jobs(page_id,idempotency_key,request_hash,kind,operation) VALUES(${page!.id},'k','h','html','text_edit')`)
      .rejects.toThrow(/derived_check/);
    await expect(db.sql`INSERT INTO vsl_page_import_jobs(page_id,idempotency_key,request_hash,kind) VALUES(${page!.id},'k2','h','html')`)
      .rejects.toThrow(/source_check/);
  });
});
