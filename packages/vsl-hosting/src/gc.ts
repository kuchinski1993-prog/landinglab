// GC simples do VSL G3 (worker): só objetos VSL G3, nunca LandingLab/legacy.
//  1. Jobs de import em `needs_resolution` parados há mais de N dias → `failed/import_expired` (+ apaga o upload).
//  2. Revisões G3 órfãs (sem etapa, release, página atual, job/tradução em andamento) há mais de N dias →
//     `status='archived'`, apaga o prefixo `vsl/releases/<página>/<revisão>` e marca `storage_deleted_at`.
//  3. Com `storage.list`: uploads `vsl/sources/g3/<job>` sem job ativo e prefixos de revisão sem linha no
//     banco (escrita interrompida) sob páginas G3, mais velhos que N dias.
// `dryRun` só registra o que faria.
import type { Sql } from 'postgres';

import type { VslObjectStore } from './storage.js';

export interface VslGcOptions {
  dryRun: boolean;
  olderThanDays?: number;
  /** Teto de itens por categoria e execução. */
  max?: number;
  now?: Date;
  log?: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}
export interface VslGcReport {
  dryRun: boolean; cutoff: string;
  expiredJobs: string[]; revisions: string[]; sourcePrefixes: string[]; releasePrefixes: string[]; errors: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Revisão órfã: nada no banco aponta para ela (nem legacy). Mesmo predicado no SELECT (dry-run) e no UPDATE. */
const orphanRevision = (sql: Sql) => sql`r.storage_deleted_at IS NULL AND r.legacy_revision_id IS NULL AND r.storage_prefix LIKE 'vsl/releases/%'
  AND NOT EXISTS (SELECT 1 FROM vsl_pages p WHERE p.current_revision_id=r.id)
  AND NOT EXISTS (SELECT 1 FROM vsl_steps s WHERE s.page_revision_id=r.id)
  AND NOT EXISTS (SELECT 1 FROM vsl_step_releases sr WHERE sr.page_revision_id=r.id)
  AND NOT EXISTS (SELECT 1 FROM vsl_asset_references a WHERE a.page_revision_id=r.id)
  AND NOT EXISTS (SELECT 1 FROM vsl_page_import_jobs j WHERE j.base_revision_id=r.id AND j.state IN ('queued','running'))
  AND NOT EXISTS (SELECT 1 FROM vsl_page_translations t WHERE t.source_revision_id=r.id AND t.status IN ('extracting','translating','review','applying'))
  AND NOT EXISTS (SELECT 1 FROM vsl_releases lr WHERE lr.storage_prefix=r.storage_prefix)
  AND NOT EXISTS (SELECT 1 FROM landing_page_versions v WHERE v.release_storage_prefix=r.storage_prefix)`;

export async function runVslGc(sql: Sql, storage: VslObjectStore, options: VslGcOptions): Promise<VslGcReport> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.olderThanDays ?? 7) * 86_400_000);
  const max = options.max ?? 200;
  const { dryRun, log } = options;
  const report: VslGcReport = { dryRun, cutoff: cutoff.toISOString(), expiredJobs: [], revisions: [], sourcePrefixes: [], releasePrefixes: [], errors: 0 };
  const remove = async (prefix: string) => {
    if (dryRun) return true;
    try { await storage.deletePrefix(prefix); return true; }
    catch (error) {
      report.errors++;
      log?.warn({ prefix, errName: error instanceof Error ? error.name : typeof error }, '[vsl-gc] delete failed');
      return false;
    }
  };

  // 1. Imports parados aguardando decisão.
  const stale = dryRun
    ? await sql`SELECT id,source_key FROM vsl_page_import_jobs WHERE state='needs_resolution' AND updated_at<${cutoff} ORDER BY updated_at LIMIT ${max}`
    : await sql`UPDATE vsl_page_import_jobs SET state='failed',stage='failed',progress=100,error_code='import_expired',
        error_message='expired waiting for resolution',finished_at=now(),updated_at=now()
        WHERE id IN (SELECT id FROM vsl_page_import_jobs WHERE state='needs_resolution' AND updated_at<${cutoff} ORDER BY updated_at LIMIT ${max} FOR UPDATE SKIP LOCKED)
        RETURNING id,source_key`;
  for (const job of stale) {
    report.expiredJobs.push(String(job.id));
    if (job.source_key) await remove(`vsl/sources/g3/${job.id}`);
  }

  // 2. Revisões órfãs.
  const orphans = dryRun
    ? await sql`SELECT r.id,r.storage_prefix FROM vsl_page_revisions r WHERE r.created_at<${cutoff} AND ${orphanRevision(sql)} ORDER BY r.created_at LIMIT ${max}`
    : await sql`UPDATE vsl_page_revisions SET status='archived' WHERE id IN (SELECT r.id FROM vsl_page_revisions r
        WHERE r.created_at<${cutoff} AND ${orphanRevision(sql)} ORDER BY r.created_at LIMIT ${max} FOR UPDATE SKIP LOCKED) RETURNING id,storage_prefix`;
  for (const revision of orphans) {
    report.revisions.push(String(revision.id));
    if (await remove(String(revision.storage_prefix)) && !dryRun)
      await sql`UPDATE vsl_page_revisions SET storage_deleted_at=now() WHERE id=${revision.id}`;
  }

  // 3. Restos no storage sem dono no banco.
  if (storage.list) {
    const group = (objects: Array<{ key: string; lastModified: Date }>, depth: number) => {
      const newest = new Map<string, number>();
      for (const object of objects) {
        const prefix = object.key.split('/').slice(0, depth).join('/');
        newest.set(prefix, Math.max(newest.get(prefix) ?? 0, object.lastModified.getTime()));
      }
      return [...newest.entries()].filter(([, time]) => time < cutoff.getTime()).map(([prefix]) => prefix);
    };
    const sources = group(await storage.list('vsl/sources/g3'), 4).filter((prefix) => UUID.test(prefix.split('/')[3] ?? ''));
    if (sources.length) {
      const ids = sources.map((prefix) => prefix.split('/')[3]!);
      const active = new Set((await sql`SELECT id FROM vsl_page_import_jobs WHERE id IN ${sql(ids)} AND state IN ('queued','running','needs_resolution')`)
        .map((row) => String(row.id)));
      for (const prefix of sources.filter((item) => !active.has(item.split('/')[3]!)).slice(0, max))
        if (await remove(prefix)) report.sourcePrefixes.push(prefix);
    }
    const pages = await sql`SELECT id FROM vsl_pages WHERE legacy_page_id IS NULL ORDER BY updated_at DESC`;
    for (const page of pages) {
      if (report.releasePrefixes.length >= max) break;
      const prefixes = group(await storage.list(`vsl/releases/${page.id}`), 4).filter((prefix) => UUID.test(prefix.split('/')[3] ?? ''));
      if (!prefixes.length) continue;
      const known = new Set((await sql`SELECT storage_prefix FROM vsl_page_revisions WHERE storage_prefix IN ${sql(prefixes)} AND storage_deleted_at IS NULL`)
        .map((row) => String(row.storage_prefix)));
      for (const prefix of prefixes.filter((item) => !known.has(item)))
        if (report.releasePrefixes.length < max && await remove(prefix)) report.releasePrefixes.push(prefix);
    }
  }
  log?.info({ dryRun, cutoff: report.cutoff, expiredJobs: report.expiredJobs.length, revisions: report.revisions.length,
    sourcePrefixes: report.sourcePrefixes.length, releasePrefixes: report.releasePrefixes.length, errors: report.errors,
    sample: { revisions: report.revisions.slice(0, 10), sourcePrefixes: report.sourcePrefixes.slice(0, 10), releasePrefixes: report.releasePrefixes.slice(0, 10) } },
  dryRun ? '[vsl-gc] dry-run (nada apagado)' : '[vsl-gc] done');
  return report;
}
