import { randomUUID } from 'node:crypto';

import type { Sql } from 'postgres';

import { canonical } from './analysis.js';
import { vslError } from './errors.js';
import { VslError } from './imports.js';
import { digest } from './storage.js';
import { VIDEO_LIMITS, validateVideoBytes, type StreamAdapter, type StreamVideo } from './stream.js';
import { streamOriginsAllowed, vslStreamOriginPolicy } from './stream-origins.js';

/**
 * Contrato do upload G3 (TUS direto do browser para o Stream):
 * - `sha256` (arquivo inteiro) é OPCIONAL: o browser não precisa ler 5 GB na memória.
 * - `sampleSha256` (opcional) = SHA-256 de amostras (ver docs/vsl/api-contracts.md) usado só para
 *   apontar possível duplicata; nunca bloqueia o upload.
 * - Identidade/idempotência = header Idempotency-Key + hash canônico do pedido.
 */
export interface IndependentVideoIntent {
  bytes: number;
  mimeType: string;
  sha256?: string;
  sampleSha256?: string;
}

/**
 * Faixas de bytes do `sampleSha256` (o browser lê só ~3 MiB, nunca o arquivo inteiro):
 * SHA-256( `${size}:` + bytes[0,1MiB) + bytes[meio-512KiB, meio+512KiB) + bytes[size-1MiB, size) ),
 * com as faixas recortadas a [0,size) e sem sobreposição; arquivo <= 3 MiB = arquivo inteiro.
 */
export function videoSampleRanges(size: number): Array<[start: number, end: number]> {
  const MIB = 1024 * 1024;
  if (!Number.isSafeInteger(size) || size <= 0) return [];
  if (size <= 3 * MIB) return [[0, size]];
  const middle = Math.floor(size / 2);
  return [[0, MIB], [middle - MIB / 2, middle + MIB / 2], [size - MIB, size]];
}

export const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;
export const VIDEO_RECONCILE_MAX_ATTEMPTS = 40;
const HEX64 = /^[0-9a-f]{64}$/;

export interface VideoAssetRow {
  id: string; name: string; status: string; provider_asset_id: string | null; error_message: string | null;
  upload_state: string | null; expires_at: Date | null; [column: string]: unknown;
}
export interface VideoScanLog { warn: (obj: object, msg: string) => void }
export interface VideoScanResult { claimed: number; reconciled: number; failed: number; errors: number }

export class VslIndependentVideos {
  constructor(
    readonly sql: Sql,
    readonly provider: StreamAdapter,
    readonly originPolicy: () => Promise<string[]> = () => vslStreamOriginPolicy(sql),
  ) {}

  async list() {
    return this.sql`SELECT v.*,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('projectId',pr.id,'projectName',pr.name,'stepId',s.id,'stepName',s.name) ORDER BY pr.name, s.position)
        FROM vsl_steps s JOIN vsl_projects pr ON pr.id=s.project_id
        WHERE s.video_asset_id=v.id AND s.status<>'archived' AND pr.status<>'archived'), '[]'::jsonb) AS "usedBy"
      FROM vsl_video_assets v WHERE v.store_id='l0i' AND v.status!='deleted' ORDER BY v.updated_at DESC`;
  }

  async status(id: string): Promise<VideoAssetRow> {
    const [row] = await this.sql<VideoAssetRow[]>`SELECT a.*,i.state AS upload_state,i.expires_at FROM vsl_video_assets a LEFT JOIN vsl_video_upload_intents i ON i.id=a.id WHERE a.id=${id} AND a.store_id='l0i'`;
    if (!row) throw vslError('video_not_found');
    return row;
  }

  async create(name: string, key: string, intent: IndependentVideoIntent): Promise<VideoAssetRow & { possibleDuplicateOf: string | null; uploadUrl?: string; clientResumeRequired?: boolean }> {
    try { validateVideoBytes(intent.bytes); } catch { throw vslError('video_too_large'); }
    if (!name?.trim() || name.trim().length > 200 || !key || key.length > 200 ||
      (intent.sha256 !== undefined && !HEX64.test(intent.sha256)) ||
      (intent.sampleSha256 !== undefined && !HEX64.test(intent.sampleSha256)) ||
      !(VIDEO_MIME_TYPES as readonly string[]).includes(intent.mimeType))
      throw vslError('video_intent_invalid');
    const normalized = { bytes: intent.bytes, mimeType: intent.mimeType, sha256: intent.sha256 ?? null, sampleSha256: intent.sampleSha256 ?? null };
    const hash = digest(canonical({ name: name.trim(), intent: normalized }));
    const claim = await this.sql.begin(async (tx) => {
      const [prior] = await tx`SELECT id,request_hash FROM vsl_video_upload_intents WHERE request_key=${key} FOR UPDATE`;
      if (prior) {
        if (prior.request_hash !== hash) throw vslError('idempotency_conflict');
        return { id: prior.id as string, fresh: false };
      }
      const id = randomUUID();
      await tx`INSERT INTO vsl_video_assets(id,store_id,name,provider,status,mime_type) VALUES(${id},'l0i',${name.trim()},'cloudflare_stream','uploading',${intent.mimeType})`;
      await tx`INSERT INTO vsl_video_upload_intents(id,request_key,request_hash,declared_bytes,source_sha256,sample_sha256,mime_type,state,expires_at)
        VALUES(${id},${key},${hash},${intent.bytes},${normalized.sha256},${normalized.sampleSha256},${intent.mimeType},'requested',now()+interval '1 day')`;
      return { id, fresh: true };
    });
    const possibleDuplicateOf = await this.duplicateOf(claim.id, intent);
    if (!claim.fresh) return { ...(await this.status(claim.id)), possibleDuplicateOf, clientResumeRequired: true };
    try {
      const remote = await this.provider.createResumableUpload({ id: claim.id, bytes: intent.bytes, expiresAt: new Date(Date.now() + 86400000).toISOString() });
      await this.sql.begin(async (tx) => {
        await tx`SELECT id FROM vsl_video_assets WHERE id=${claim.id} FOR UPDATE`;
        await tx`UPDATE vsl_video_assets SET provider_asset_id=${remote.providerId},updated_at=now() WHERE id=${claim.id}`;
        await tx`UPDATE vsl_video_upload_intents SET state='uploading',updated_at=now() WHERE id=${claim.id}`;
      });
      return { ...(await this.status(claim.id)), possibleDuplicateOf, uploadUrl: remote.uploadUrl };
    } catch {
      // The provider may have created the upload. Reconcile by creator identity before another attempt.
      return { ...(await this.status(claim.id)), possibleDuplicateOf, clientResumeRequired: true };
    }
  }

  /** Vídeo existente com mesmo tamanho e mesmo hash (inteiro ou por amostragem). Só informativo. */
  private async duplicateOf(id: string, intent: IndependentVideoIntent): Promise<string | null> {
    if (!intent.sha256 && !intent.sampleSha256) return null;
    const [row] = await this.sql`SELECT a.id FROM vsl_video_upload_intents i JOIN vsl_video_assets a ON a.id=i.id
      WHERE a.id<>${id} AND a.store_id='l0i' AND a.status IN ('uploading','processing','ready') AND i.declared_bytes=${intent.bytes}
        AND ((${intent.sha256 ?? null}::text IS NOT NULL AND i.source_sha256=${intent.sha256 ?? null})
          OR (${intent.sampleSha256 ?? null}::text IS NOT NULL AND i.sample_sha256=${intent.sampleSha256 ?? null}))
      ORDER BY (a.status='ready') DESC, a.created_at LIMIT 1`;
    return row ? String(row.id) : null;
  }

  async reconcile(id: string) {
    let row = await this.status(id);
    if (row.status === 'deleted' || row.status === 'failed') return row;
    let providerId = row.provider_asset_id as string | null;
    if (!providerId) {
      const matches = await this.provider.findByIntent(id);
      if (matches.length !== 1) return { ...row, reconciliationPending: true };
      providerId = matches[0]!.uid;
      await this.sql`UPDATE vsl_video_assets SET provider_asset_id=${providerId},updated_at=now() WHERE id=${id} AND provider_asset_id IS NULL`;
    }
    const remote = await this.provider.getVideoMetadata(providerId);
    if (!remote) throw vslError('video_missing_remote');
    await this.apply(id, remote, await this.originPolicy());
    row = await this.status(id);
    return row;
  }

  private async apply(id: string, remote: StreamVideo, policy: string[]) {
    return this.sql.begin(async (tx) => {
      const [asset] = await tx`SELECT * FROM vsl_video_assets WHERE id=${id} AND store_id='l0i' FOR UPDATE`;
      if (!asset || asset.provider_asset_id !== remote.uid || remote.creator !== `vsl-${id}`)
        throw vslError('video_ownership_mismatch');
      const [intent] = await tx`SELECT * FROM vsl_video_upload_intents WHERE id=${id} FOR UPDATE`;
      if (!intent) throw new VslError('Video intent not found', 409, 'constraint_conflict');
      if (intent.provider_modified_at && !remote.ready && Date.parse(remote.modified) <= new Date(intent.provider_modified_at).getTime()) return asset;
      let status = remote.state === 'error' ? 'failed' : remote.ready && remote.state === 'ready' ? 'ready' : remote.state === 'queued' || remote.state === 'inprogress' ? 'processing' : 'uploading';
      let error = status === 'failed' ? remote.errorCode ?? 'provider_error' : null;
      if ((remote.duration !== null && remote.duration > VIDEO_LIMITS.seconds) ||
        (remote.size !== null && remote.size > VIDEO_LIMITS.bytes) ||
        (status === 'ready' && (!remote.duration || !remote.size || !remote.width || !remote.height || remote.signed ||
          !streamOriginsAllowed(remote.allowedOrigins, policy)))) {
        status = 'failed'; error = 'video_policy_rejected';
      }
      if (asset.status === 'ready' && status !== 'ready') return asset;
      await tx`UPDATE vsl_video_assets SET status=${status},duration_seconds=${remote.duration},bytes=${remote.size},error_message=${error},updated_at=now() WHERE id=${id}`;
      await tx`UPDATE vsl_video_upload_intents SET state=${status},provider_modified_at=${remote.modified},updated_at=now() WHERE id=${id}`;
      return asset;
    });
  }

  /** Webhook do Cloudflare Stream (corpo cru, assinatura HMAC `Webhook-Signature`). */
  async webhook(raw: Buffer, signature: string): Promise<{ accepted: true; matched: boolean; videoId?: string; reconciled?: boolean }> {
    if (!this.provider.verifyWebhook(raw, signature)) throw vslError('webhook_signature_invalid');
    let body: { uid?: unknown; creator?: unknown };
    try { body = JSON.parse(raw.toString()) as typeof body; } catch { throw vslError('webhook_invalid'); }
    if (typeof body.uid !== 'string' || !/^[0-9a-f]{32}$/.test(body.uid)) throw vslError('webhook_invalid');
    let [asset] = await this.sql`SELECT id FROM vsl_video_assets WHERE provider='cloudflare_stream' AND provider_asset_id=${body.uid}`;
    // Resposta do createResumableUpload perdida: a identidade vem do creator (vsl-<assetId>).
    const creator = typeof body.creator === 'string' ? /^vsl-([0-9a-f-]{36})$/.exec(body.creator)?.[1] : undefined;
    if (!asset && creator) [asset] = await this.sql`SELECT id FROM vsl_video_assets WHERE id=${creator} AND provider_asset_id IS NULL`;
    if (!asset) return { accepted: true, matched: false };
    const videoId = String(asset.id);
    await this.sql`UPDATE vsl_video_assets SET last_webhook_at=now() WHERE id=${videoId}`;
    try {
      await this.reconcile(videoId);
      return { accepted: true, matched: true, videoId, reconciled: true };
    } catch {
      // Falha transitória: o scan do worker pega na próxima rodada.
      await this.sql`UPDATE vsl_video_assets SET next_reconcile_at=now() WHERE id=${videoId} AND status IN ('uploading','processing')`;
      return { accepted: true, matched: true, videoId, reconciled: false };
    }
  }

  /**
   * Scan periódico (worker). Reivindica até `limit` vídeos pendentes com SKIP LOCKED e
   * empurra next_reconcile_at (backoff exponencial, teto 30 min) — dedupe entre instâncias.
   * `failed`/`ready`/`deleted` nunca entram; upload expirado ou tentativas esgotadas viram `failed`.
   */
  async scan(limit = 25, log?: VideoScanLog): Promise<VideoScanResult> {
    const claimed = await this.sql<{ id: string; reconcile_attempts: number; expired: boolean }[]>`
      WITH due AS (
        SELECT id FROM vsl_video_assets
        WHERE store_id='l0i' AND status IN ('uploading','processing') AND (next_reconcile_at IS NULL OR next_reconcile_at<=now())
        ORDER BY next_reconcile_at NULLS FIRST, updated_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      UPDATE vsl_video_assets a SET reconcile_attempts=a.reconcile_attempts+1,
        next_reconcile_at=now()+make_interval(secs => LEAST(1800, 30 * power(2, LEAST(a.reconcile_attempts, 10))::int))
      FROM due WHERE a.id=due.id
      RETURNING a.id, a.reconcile_attempts,
        EXISTS (SELECT 1 FROM vsl_video_upload_intents i WHERE i.id=a.id AND i.expires_at < now() - interval '1 hour') AS expired`;
    const result: VideoScanResult = { claimed: claimed.length, reconciled: 0, failed: 0, errors: 0 };
    for (const row of claimed) {
      try {
        const after = await this.reconcile(row.id).catch((error: unknown) => {
          if (error instanceof VslError && error.code === 'video_missing_remote' && row.expired) return null;
          throw error;
        });
        const pending = !after || after.status === 'uploading' || after.status === 'processing';
        if (pending && (row.reconcile_attempts >= VIDEO_RECONCILE_MAX_ATTEMPTS || (row.expired && (!after || after.status === 'uploading')))) {
          const reason = row.expired ? 'upload_expired' : 'reconcile_timeout';
          await this.sql`UPDATE vsl_video_assets SET status='failed',error_message=${reason},next_reconcile_at=NULL,updated_at=now()
            WHERE id=${row.id} AND status IN ('uploading','processing')`;
          await this.sql`UPDATE vsl_video_upload_intents SET state='failed',updated_at=now() WHERE id=${row.id}`;
          result.failed++;
        } else result.reconciled++;
      } catch (error) {
        result.errors++;
        if (row.reconcile_attempts >= VIDEO_RECONCILE_MAX_ATTEMPTS) {
          await this.sql`UPDATE vsl_video_assets SET status='failed',error_message='reconcile_timeout',next_reconcile_at=NULL,updated_at=now()
            WHERE id=${row.id} AND status IN ('uploading','processing')`.catch(() => undefined);
          result.failed++;
        }
        log?.warn({ videoId: row.id, errName: error instanceof Error ? error.name : typeof error, code: (error as VslError)?.code }, '[vsl] video reconcile failed');
      }
    }
    return result;
  }

  async playback(id: string) {
    const row = await this.status(id);
    if (row.status !== 'ready' || !row.provider_asset_id) throw vslError('video_not_ready');
    return this.provider.getPlaybackDescriptor(String(row.provider_asset_id));
  }
}
