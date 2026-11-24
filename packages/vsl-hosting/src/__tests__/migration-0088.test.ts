// 0088 aplicada (2x) sobre 0086/0087 num Postgres real (PGlite).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startVslTestDatabase, type VslTestDatabase } from '../testing/pg-harness.js';

let db: VslTestDatabase;
beforeAll(async () => { db = await startVslTestDatabase(); }, 60_000);
afterAll(async () => { await db?.close(); });

async function seedRelease() {
  const { sql } = db;
  const [domain] = await sql`INSERT INTO blackshop_domains(hostname) VALUES('vsl.example.com') RETURNING id`;
  const [project] = await sql`INSERT INTO vsl_projects(name) VALUES('P') RETURNING id`;
  const [step] = await sql`INSERT INTO vsl_steps(project_id,position,name,pathname) VALUES(${project!.id},0,'S','/') RETURNING id`;
  const [release] = await sql`INSERT INTO vsl_project_releases(project_id,version_number,domain_id) VALUES(${project!.id},1,${domain!.id}) RETURNING id`;
  const [stepRelease] = await sql`INSERT INTO vsl_step_releases(project_release_id,step_id,position,name,type,pathname,render_mode)
    VALUES(${release!.id},${step!.id},0,'S','PAGE','/','IMPORTED_PAGE') RETURNING id`;
  return { release: release!.id as string, stepRelease: stepRelease!.id as string };
}

describe('0088_vsl_g3_backend on Postgres', () => {
  it('creates the import job table with RLS enabled', async () => {
    const [row] = await db.sql`SELECT relrowsecurity FROM pg_class WHERE relname='vsl_page_import_jobs'`;
    expect(row?.relrowsecurity).toBe(true);
  });

  it('makes releases immutable (UPDATE and DELETE blocked)', async () => {
    await db.reset();
    const { release, stepRelease } = await seedRelease();
    await expect(db.sql`UPDATE vsl_project_releases SET config_snapshot='{"x":1}' WHERE id=${release}`).rejects.toThrow(/immutable/);
    await expect(db.sql`DELETE FROM vsl_step_releases WHERE id=${stepRelease}`).rejects.toThrow(/immutable/);
    await expect(db.sql`UPDATE vsl_step_releases SET name='x' WHERE id=${stepRelease}`).rejects.toThrow(/immutable/);
  });

  it('accepts video intents without full-file SHA-256 but validates the sample hash', async () => {
    await db.reset();
    const [video] = await db.sql`INSERT INTO vsl_video_assets(name) VALUES('v') RETURNING id`;
    await db.sql`INSERT INTO vsl_video_upload_intents(id,request_key,request_hash,declared_bytes,mime_type,expires_at,sample_sha256)
      VALUES(${video!.id},'k','h',10,'video/mp4',now(),${'a'.repeat(64)})`;
    const [video2] = await db.sql`INSERT INTO vsl_video_assets(name) VALUES('v2') RETURNING id`;
    await expect(db.sql`INSERT INTO vsl_video_upload_intents(id,request_key,request_hash,declared_bytes,mime_type,expires_at,sample_sha256)
      VALUES(${video2!.id},'k2','h',10,'video/mp4',now(),'nothex')`).rejects.toThrow(/sample_check/);
  });

  it('requires a lease token exactly while running', async () => {
    await db.reset();
    const [page] = await db.sql`INSERT INTO vsl_pages(name) VALUES('p') RETURNING id`;
    await expect(db.sql`INSERT INTO vsl_page_import_jobs(page_id,idempotency_key,request_hash,kind,source_key,source_bytes,source_sha256,state)
      VALUES(${page!.id},'k','h','html','s',1,${'a'.repeat(64)},'running')`).rejects.toThrow(/lease_check/);
  });
});
