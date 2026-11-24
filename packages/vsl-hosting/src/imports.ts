import { randomUUID } from 'node:crypto';

import type { Sql } from 'postgres';

// Caminho relativo (não '@blackshop/errors'): este arquivo entra no bundle Vercel do
// vsl-storefront (stream.ts → imports.ts), que só empacota fontes de workspace por caminho
// relativo (ver commit 488edfef). Mesmo módulo em runtime → `instanceof AppError` vale.
import { AppError } from '../../errors/src/app-error.js';

import { validateImportConfig } from './config.js';
import { analyze, canonical, VERSIONS, type ImportConfig } from './analysis.js';
import { extractSource, LIMITS } from './archive.js';
import { digest, type VslStorage } from './storage.js';
// Story 18.1: estende AppError (@blackshop/errors) com a mesma assinatura de antes.
export class VslError extends AppError {
  constructor(
    message: string,
    statusCode = 400,
    /** Código estável G3 (ver errors.ts / docs/vsl/api-errors.md). */
    code?: string,
    details?: unknown
  ) {
    super(message, statusCode, code, details);
  }
}
export const VSL_IMPORT_QUEUE = 'vsl-import';
export interface ImportJob {
  importId: string;
}
export class VslImports {
  constructor(
    readonly sql: Sql,
    readonly storage: VslStorage
  ) {}
  async upload(
    pageId: string,
    key: string,
    bytes: Buffer,
    kind: 'html' | 'zip',
    config: ImportConfig = {}
  ) {
    config = validateImportConfig(config);
    if (config.requiredTargets !== undefined || config.allowForms !== undefined || config.assetBasePath !== undefined) throw new VslError('Legacy VSL target policy cannot be overridden');
    if (!key || key.length > 200) throw new VslError('Invalid VSL request key');
    if (bytes.length === 0) throw new VslError('Empty VSL upload');
    if (bytes.length > LIMITS[kind]) throw new VslError('Upload exceeds size limit', 413);
    const [page] = await this
      .sql`SELECT id FROM landing_pages WHERE id=${pageId} AND content_mode='hosted' AND store_id='l0i'`;
    if (!page) throw new VslError('VSL page not found', 404);
    const hash = digest(bytes),
      requestHash = digest(canonical({ hash, kind, config })),
      id = randomUUID(),
      sourceKey = `vsl/sources/${id}/original.${kind}`;
    const [prior] = await this
      .sql`SELECT * FROM vsl_imports WHERE page_id=${pageId} AND request_key=${key}`;
    if (prior) {
      if (prior.request_hash !== requestHash)
        throw new VslError('Idempotency key reused with different request', 409);
      return prior;
    }
    // Private original is immutable; losing request-key races leave an unreferenced original, never a partial revision.
    await this.storage.putExclusive(sourceKey, bytes);
    const [created] = await this
      .sql`INSERT INTO vsl_imports(id,page_id,request_key,request_hash,source_sha256,source_key,source_bytes,kind,config) VALUES(${id},${pageId},${key},${requestHash},${hash},${sourceKey},${bytes.length},${kind},${this.sql.json(config as never)}) ON CONFLICT(page_id,request_key) DO NOTHING RETURNING *`;
    const existing =
      created ??
      (
        await this.sql`SELECT * FROM vsl_imports WHERE page_id=${pageId} AND request_key=${key}`
      )[0]!;
    if (existing.request_hash !== requestHash)
      throw new VslError('Idempotency key reused with different request', 409);
    return existing;
  }
  async get(id: string) {
    const [item] = await this.sql`SELECT * FROM vsl_imports WHERE id=${id}`;
    if (!item) throw new VslError('Import not found', 404);
    const attempts = await this
      .sql`SELECT id,status,error,release_id,storage_prefix,created_at,finished_at FROM vsl_import_attempts WHERE import_id=${id} ORDER BY created_at`;
    return Object.assign(item, { attempts });
  }
  async resume(id: string, config: ImportConfig) {
    config = validateImportConfig(config);
    if (config.requiredTargets !== undefined || config.allowForms !== undefined || config.assetBasePath !== undefined) throw new VslError('Legacy VSL target policy cannot be overridden');
    return this.sql.begin(async (tx) => {
      const [item] = await tx`SELECT * FROM vsl_imports WHERE id=${id} FOR UPDATE`;
      if (!item) throw new VslError('Import not found', 404);
      if (
        !['queued', 'awaiting_selection', 'awaiting_resolution', 'failed'].includes(item.status) &&
        !(item.active_attempt_id && new Date(item.lease_until).getTime() <= Date.now())
      )
        throw new VslError('Import cannot be resumed', 409);
      if (config.entryPath && !(item.candidates as string[]).includes(config.entryPath))
        throw new VslError('Entry is not a candidate');
      const merged = { ...item.config, ...config };
      const [row] =
        await tx`UPDATE vsl_imports SET config=${tx.json(merged)},entry_path=${merged.entryPath ?? item.entry_path},status='queued',error=NULL,active_attempt_id=NULL,lease_until=NULL,updated_at=now() WHERE id=${id} RETURNING *`;
      return row!;
    });
  }
  async cancel(id: string) {
    const [row] = await this
      .sql`UPDATE vsl_imports SET status='cancelled',active_attempt_id=NULL,lease_until=NULL,updated_at=now() WHERE id=${id} AND status!='succeeded' RETURNING *`;
    if (!row) throw new VslError('Already completed or not found', 409);
    return row;
  }
  async process(id: string): Promise<void> {
    const attemptId = randomUUID();
    const claimed = await this.sql.begin(async (tx) => {
      const [row] = await tx`SELECT * FROM vsl_imports WHERE id=${id} FOR UPDATE`;
      if (
        !row ||
        ![
          'queued',
          'failed',
          'validating',
          'extracting',
          'analyzing',
          'transforming',
          'materializing',
          'verifying',
          'sealing',
          'committing',
        ].includes(row.status) ||
        (row.lease_until && new Date(row.lease_until).getTime() > Date.now())
      )
        return null;
      if (row.active_attempt_id)
        await tx`UPDATE vsl_import_attempts SET status='abandoned',finished_at=now() WHERE id=${row.active_attempt_id} AND status='running'`;
      await tx`INSERT INTO vsl_import_attempts(id,import_id,status) VALUES(${attemptId},${id},'running')`;
      await tx`UPDATE vsl_imports SET active_attempt_id=${attemptId},lease_until=now()+interval '10 minutes',status='validating',updated_at=now() WHERE id=${id}`;
      return row;
    });
    if (!claimed) return;

    const assertActive = async () => {
      const [row] = await this
        .sql`SELECT id FROM vsl_imports WHERE id=${id} AND active_attempt_id=${attemptId} AND lease_until>now() AND status!='cancelled'`;
      if (!row) throw new VslError('Attempt fenced/cancelled', 409);
    };
    try {
      if (claimed.active_attempt_id)
        await this.storage.removeAttempt(id, claimed.active_attempt_id);
      const source = await this.storage.read(claimed.source_key);
      if (digest(source) !== claimed.source_sha256) throw new VslError('Source checksum mismatch');
      await this
        .sql`UPDATE vsl_imports SET status='extracting',updated_at=now() WHERE id=${id} AND active_attempt_id=${attemptId}`;
      const files = (() => {
          try {
            return extractSource(source, claimed.kind);
          } catch (error) {
            throw new VslError(error instanceof Error ? error.message : 'VSL validation failed');
          }
        })(),
        candidates = files.filter((f) => f.mime === 'text/html').map((f) => f.path);
      if (!candidates.length) throw new VslError('No HTML candidates');
      await this
        .sql`UPDATE vsl_imports SET candidates=${this.sql.json(candidates)},extracted_bytes=${files.reduce((sum, file) => sum + file.bytes.length, 0)},file_count=${files.length} WHERE id=${id} AND active_attempt_id=${attemptId}`;
      const entry =
        claimed.config.entryPath ??
        claimed.entry_path ??
        (candidates.length === 1 ? candidates[0] : null);
      if (!entry) {
        await this.finishWaiting(id, attemptId, 'awaiting_selection', { candidates });
        return;
      }
      for (const file of files) {
        await assertActive();
        await this.storage.putExclusive(
          `vsl/quarantine/${id}/attempts/${attemptId}/${file.path}`,
          file.bytes
        );
      }
      await this
        .sql`UPDATE vsl_imports SET status='analyzing',updated_at=now() WHERE id=${id} AND active_attempt_id=${attemptId}`;
      const effectiveConfig = { ...claimed.config, entryPath: entry };
      const analysis = (() => {
        try {
          return analyze(files, entry, effectiveConfig);
        } catch (error) {
          throw new VslError(error instanceof Error ? error.message : 'VSL analysis failed');
        }
      })();
      await this
        .sql`UPDATE vsl_imports SET status='transforming',updated_at=now() WHERE id=${id} AND active_attempt_id=${attemptId}`;
      if (analysis.report.pending.length) {
        await this.finishWaiting(id, attemptId, 'awaiting_resolution', analysis.report);
        return;
      }
      const fingerprint = digest(
        canonical({
          pageId: claimed.page_id,
          source: claimed.source_sha256,
          entryPath: entry,
          config: effectiveConfig,
          versions: VERSIONS,
        })
      );
      await assertActive();
      const releaseId = randomUUID(),
        prefix = `vsl/releases/${claimed.page_id}/${releaseId}`;
      await this
        .sql`UPDATE vsl_import_attempts SET release_id=${releaseId},storage_prefix=${prefix} WHERE id=${attemptId}`;
      await this
        .sql`UPDATE vsl_imports SET status='materializing',fingerprint=${fingerprint},entry_path=${entry},report=${this.sql.json(analysis.report as never)} WHERE id=${id} AND active_attempt_id=${attemptId}`;
      for (const file of analysis.files) {
        await assertActive();
        await this.storage.putExclusive(`${prefix}/${file.path}`, file.bytes);
      }
      await this
        .sql`UPDATE vsl_imports SET status='verifying',updated_at=now() WHERE id=${id} AND active_attempt_id=${attemptId}`;
      await assertActive();
      await this
        .sql`UPDATE vsl_imports SET status='sealing',updated_at=now() WHERE id=${id} AND active_attempt_id=${attemptId}`;
      await this.storage.seal(prefix, analysis.manifest);
      if (!(await this.storage.isSealed(prefix, analysis.manifest)))
        throw new Error('Seal verification failed');
      await assertActive();
      await this
        .sql`UPDATE vsl_imports SET status='committing',updated_at=now() WHERE id=${id} AND active_attempt_id=${attemptId}`;
      await this.sql.begin(async (tx) => {
        const [item] = await tx`SELECT * FROM vsl_imports WHERE id=${id} FOR UPDATE`;
        if (
          item?.active_attempt_id !== attemptId ||
          item.status === 'cancelled' ||
          new Date(item.lease_until).getTime() <= Date.now()
        )
          throw new VslError('Attempt fenced', 409);
        await tx`SELECT id FROM landing_pages WHERE id=${claimed.page_id} FOR UPDATE`;
        const [existing] =
          await tx`SELECT revision_id FROM vsl_releases WHERE page_id=${claimed.page_id} AND fingerprint=${fingerprint}`;
        let revisionId = existing?.revision_id;
        if (!revisionId) {
          revisionId = randomUUID();
          const [number] =
            await tx`SELECT COALESCE(MAX(version_number),0)+1 AS next FROM landing_page_versions WHERE landing_page_id=${claimed.page_id}`;
          const html = analysis.files.find((f) => f.path === entry)!.bytes.toString('utf8');
          await tx`INSERT INTO landing_page_versions(id,landing_page_id,version_number,source_storage_key,release_storage_prefix,entry_path,html_body,asset_manifest,validation_report,config_snapshot,status,checksum,runtime_version) VALUES(${revisionId},${claimed.page_id},${number!.next},${claimed.source_key},${prefix},${entry},${html},${tx.json(analysis.manifest as never)},${tx.json(analysis.report as never)},${tx.json(effectiveConfig)},'ready',${digest(html)},'vsl-import-1')`;
          await tx`INSERT INTO vsl_releases(id,page_id,import_id,attempt_id,fingerprint,storage_prefix,manifest,sealed_at,revision_id) VALUES(${releaseId},${claimed.page_id},${id},${attemptId},${fingerprint},${prefix},${tx.json(analysis.manifest as never)},now(),${revisionId})`;
        }
        await tx`UPDATE vsl_imports SET status='succeeded',revision_id=${revisionId},fingerprint=${fingerprint},report=${tx.json(analysis.report as never)},active_attempt_id=NULL,lease_until=NULL,error=NULL,updated_at=now() WHERE id=${id}`;
        await tx`UPDATE vsl_import_attempts SET status='succeeded',finished_at=now() WHERE id=${attemptId}`;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'VSL import failed';
      const findingId = digest(`${claimed.source_sha256}:${message}`).slice(0, 24);
      const failureReport = {
        version: 1,
        entryPath: claimed.entry_path ?? null,
        versions: VERSIONS,
        config: claimed.config,
        findings: [
          {
            id: findingId,
            file: `original.${claimed.kind}`,
            location: 'import-validation-or-storage',
            category: error instanceof VslError ? 'validation-rejection' : 'operational-failure',
            severity: 'blocking',
            action: error instanceof VslError ? 'rejected' : 'retry',
            reason: message,
            evidence: claimed.source_sha256,
            beforeHash: claimed.source_sha256,
          },
        ],
        pending: [findingId],
      };
      await this
        .sql`UPDATE vsl_imports SET status='failed',error=${message},report=${this.sql.json(failureReport as never)},active_attempt_id=NULL,lease_until=NULL,updated_at=now() WHERE id=${id} AND active_attempt_id=${attemptId}`;
      await this
        .sql`UPDATE vsl_import_attempts SET status='failed',error=${message},finished_at=now() WHERE id=${attemptId} AND status='running'`;
      if (!(error instanceof VslError)) throw error;
    } finally {
      await this.storage.removeAttempt(id, attemptId);
    }
  }
  private async finishWaiting(id: string, attemptId: string, status: string, report: unknown) {
    await this
      .sql`UPDATE vsl_imports SET status=${status},report=${this.sql.json(report as never)},active_attempt_id=NULL,lease_until=NULL,updated_at=now() WHERE id=${id} AND active_attempt_id=${attemptId}`;
    await this
      .sql`UPDATE vsl_import_attempts SET status='succeeded',finished_at=now() WHERE id=${attemptId}`;
  }
}
