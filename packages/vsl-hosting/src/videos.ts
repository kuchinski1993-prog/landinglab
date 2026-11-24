import { randomUUID } from 'node:crypto';

import type { Sql } from 'postgres';

import { canonical } from './analysis.js';
import { digest } from './storage.js';
import { VslError } from './imports.js';
import {
  VIDEO_LIMITS,
  validateVideoBytes,
  type StreamAdapter,
  type StreamVideo,
} from './stream.js';
export const VSL_VIDEO_QUEUE = 'vsl-video-reconcile';
export interface VideoIntent {
  bytes: number;
  sha256: string;
  mimeType: string;
}
const rank: Record<string, number> = {
  requested: 0,
  provisioning: 1,
  provisioning_uncertain: 1,
  uploading: 2,
  uploaded: 3,
  processing: 4,
  ready: 5,
};
export class VslVideos {
  constructor(
    readonly sql: Sql,
    readonly provider: StreamAdapter
  ) {}
  private async lock(tx: Sql, id: string) {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${id},0))`;
  }
  async status(id: string) {
    const [row] = await this.sql`SELECT * FROM vsl_video_uploads WHERE id=${id}`;
    if (!row) throw new VslError('VSL video not found', 404);
    return row;
  }
  async create(pageId: string, key: string, intent: VideoIntent) {
    validateVideoBytes(intent.bytes);
    if (
      !key ||
      key.length > 200 ||
      !/^[0-9a-f]{64}$/.test(intent.sha256) ||
      !['video/mp4', 'video/quicktime', 'video/webm'].includes(intent.mimeType)
    )
      throw new VslError('Invalid VSL video intent');
    const requestHash = digest(canonical(intent));
    const result = await this.sql.begin(async (tx) => {
      const [page] =
        await tx`SELECT id FROM landing_pages WHERE id=${pageId} AND content_mode='hosted' AND store_id='l0i' FOR UPDATE`;
      if (!page) throw new VslError('Hosted VSL page not found', 404);
      const [prior] =
        await tx`SELECT * FROM vsl_video_uploads WHERE page_id=${pageId} AND request_key=${key}`;
      if (prior) {
        if (prior.request_hash !== requestHash)
          throw new VslError('VSL video request key conflict', 409);
        return { row: prior, claimed: false };
      }
      const id = randomUUID();
      await tx`INSERT INTO landing_video_assets(id,landing_page_id,provider,status,mime_type) VALUES(${id},${pageId},'cloudflare_stream','uploading',${intent.mimeType})`;
      const [row] =
        await tx`INSERT INTO vsl_video_uploads(id,page_id,request_key,request_hash,declared_bytes,source_sha256,mime_type,state,expires_at) VALUES(${id},${pageId},${key},${requestHash},${intent.bytes},${intent.sha256},${intent.mimeType},'requested',now()+interval '1 day') RETURNING *`;
      await tx`UPDATE vsl_video_uploads SET state='provisioning' WHERE id=${id}`;
      return { row: row!, claimed: true };
    });
    if (!result.claimed) return Object.assign(result.row, { clientResumeRequired: true });
    try {
      const remote = await this.provider.createResumableUpload({
        id: result.row.id,
        bytes: intent.bytes,
        expiresAt: new Date(result.row.expires_at).toISOString(),
      });
      await this.sql.begin(async (tx) => {
        await this.lock(tx as unknown as Sql, result.row.id);
        await tx`UPDATE vsl_video_uploads SET provider_id=${remote.providerId},state='uploading',error_code=NULL,updated_at=now() WHERE id=${result.row.id} AND state='provisioning'`;
        await tx`UPDATE landing_video_assets SET provider_asset_id=${remote.providerId},updated_at=now() WHERE id=${result.row.id}`;
      });
      return Object.assign(await this.status(result.row.id), { uploadUrl: remote.uploadUrl });
    } catch {
      await this
        .sql`UPDATE vsl_video_uploads SET state='provisioning_uncertain',error_code='provisioning_outcome_uncertain',updated_at=now() WHERE id=${result.row.id} AND state='provisioning'`;
      return Object.assign(await this.status(result.row.id), { clientResumeRequired: true });
    }
  }
  async reconcile(id: string) {
    let row = await this.status(id);
    if (row.state === 'deleted' || row.state === 'policy_rejected') return row;
    if (row.state === 'delete_pending') return this.delete(id);
    if (!row.provider_id) {
      const matches = await this.provider.findByIntent(id);
      if (matches.length !== 1) {
        await this
          .sql`UPDATE vsl_video_uploads SET error_code=${matches.length ? 'multiple_provider_matches' : 'provisioning_unresolved'} WHERE id=${id} AND provider_id IS NULL`;
        return this.status(id);
      }
      await this.sql.begin(async (tx) => {
        await this.lock(tx as unknown as Sql, id);
        await tx`UPDATE vsl_video_uploads SET provider_id=${matches[0]!.uid},state='uploading',error_code=NULL WHERE id=${id} AND provider_id IS NULL AND state IN ('requested','provisioning','provisioning_uncertain')`;
        await tx`UPDATE landing_video_assets SET provider_asset_id=${matches[0]!.uid} WHERE id=${id}`;
      });
      row = await this.status(id);
    }
    if (!row.provider_id) return row;
    const remote = await this.provider.getVideoMetadata(row.provider_id);
    if (!remote)
      throw new VslError('VSL provider video missing; manual reconciliation required', 409);
    return this.apply(id, remote);
  }
  async apply(id: string, remote: StreamVideo) {
    return this.sql.begin(async (tx) => {
      await this.lock(tx as unknown as Sql, id);
      const [row] = await tx`SELECT * FROM vsl_video_uploads WHERE id=${id} FOR UPDATE`;
      if (!row || remote.uid !== row.provider_id || remote.creator !== `vsl-${id}`)
        throw new VslError('VSL provider ownership mismatch', 409);
      if (['deleted', 'delete_pending', 'policy_rejected'].includes(row.state)) return row;
      // A provider can publish the terminal ready flag without advancing the
      // modified timestamp from the preceding processing snapshot. Readiness
      // is a monotonic local transition and must still be applied.
      if (
        row.provider_modified_at &&
        !remote.ready &&
        Date.parse(remote.modified) <= new Date(row.provider_modified_at).getTime()
      )
        return row;
      let state =
        remote.state === 'error'
          ? 'failed'
          : remote.ready && remote.state === 'ready'
            ? 'ready'
            : remote.state === 'inprogress'
              ? 'processing'
              : remote.state === 'queued'
                ? 'uploaded'
                : 'uploading';
      let error: string | null = state === 'failed' ? (remote.errorCode ?? 'provider_error') : null;
      if (remote.errorCode === 'ERR_DURATION_EXCEED_CONSTRAINT') {
        state = 'policy_rejected';
        error = 'video_duration_exceeded';
      }
      if (
        (remote.duration !== null && remote.duration > VIDEO_LIMITS.seconds) ||
        (remote.size !== null && remote.size > VIDEO_LIMITS.bytes)
      ) {
        state = 'policy_rejected';
        error = 'video_limits_exceeded';
      }
      if (
        state === 'ready' &&
        (!remote.duration ||
          !remote.size ||
          !remote.width ||
          !remote.height ||
          !remote.allowedOrigins.length ||
          remote.signed)
      ) {
        state = 'policy_rejected';
        error = remote.signed ? 'signed_playback_not_supported' : 'invalid_ready_metadata';
      }
      if ((rank[state] ?? 100) < (rank[row.state] ?? 0)) return row;
      const metadata = {
        size: remote.size,
        duration: remote.duration,
        width: remote.width,
        height: remote.height,
        allowedOrigins: remote.allowedOrigins,
        signed: remote.signed,
      };
      const [updated] =
        await tx`UPDATE vsl_video_uploads SET state=${state},provider_modified_at=${remote.modified},metadata=${tx.json(metadata)},error_code=${error},updated_at=now() WHERE id=${id} RETURNING *`;
      const legacyState = ['ready', 'failed'].includes(state)
        ? state
        : state === 'policy_rejected'
          ? 'failed'
          : state === 'processing' || state === 'uploaded'
            ? 'processing'
            : 'uploading';
      await tx`UPDATE landing_video_assets SET status=${legacyState},duration_seconds=${remote.duration ? Math.ceil(remote.duration) : null},bytes=${remote.size !== null && remote.size <= 2147483647 ? remote.size : null},error_message=${error},updated_at=now() WHERE id=${id}`;
      return updated!;
    });
  }
  async webhook(raw: Buffer, signature: string) {
    if (!this.provider.verifyWebhook(raw, signature))
      throw new VslError('Invalid Stream webhook signature', 401);
    let uid: unknown;
    try {
      uid = (JSON.parse(raw.toString()) as { uid?: unknown }).uid;
    } catch {
      throw new VslError('Invalid Stream webhook', 400);
    }
    if (typeof uid !== 'string' || !/^[0-9a-f]{32}$/.test(uid))
      throw new VslError('Invalid Stream webhook identity');
    const [row] = await this.sql`SELECT id FROM vsl_video_uploads WHERE provider_id=${uid}`;
    if (!row) return { accepted: true, ignored: true };
    const hash = digest(raw);
    const [event] = await this
      .sql`INSERT INTO vsl_stream_events(body_hash,video_id) VALUES(${hash},${row.id}) ON CONFLICT DO NOTHING RETURNING body_hash`;
    // Duplicate callbacks also reconcile: a previous delivery may have failed after event persistence.
    await this.reconcile(row.id);
    return { accepted: true, duplicate: !event };
  }
  async playback(id: string) {
    const row = await this.status(id);
    if (row.state !== 'ready' || !row.provider_id)
      throw new VslError('VSL video is not ready', 409);
    return this.provider.getPlaybackDescriptor(row.provider_id);
  }
  async bindDraft(pageId: string, id: string) {
    return this.sql.begin(async (tx) => {
      await tx`SELECT id FROM landing_pages WHERE id=${pageId} FOR UPDATE`;
      const [settings] =
        await tx`SELECT video_asset_id FROM landing_hosting_settings WHERE landing_page_id=${pageId}`;
      if (settings?.video_asset_id && settings.video_asset_id !== id)
        throw new VslError('VSL draft already references another video', 409);
      await this.lock(tx as unknown as Sql, id);
      const [row] =
        await tx`SELECT * FROM vsl_video_uploads WHERE id=${id} AND page_id=${pageId} AND state='ready'`;
      if (!row) throw new VslError('Ready VSL video required', 409);
      await tx`INSERT INTO landing_hosting_settings(landing_page_id,video_asset_id) VALUES(${pageId},${id}) ON CONFLICT(landing_page_id) DO UPDATE SET video_asset_id=${id},updated_at=now()`;
      return { pageId, videoAssetId: id };
    });
  }
  async delete(id: string) {
    const row = await this.sql.begin(async (tx) => {
      await this.lock(tx as unknown as Sql, id);
      const [item] = await tx`SELECT * FROM vsl_video_uploads WHERE id=${id} FOR UPDATE`;
      if (!item) throw new VslError('VSL video not found', 404);
      if (item.state === 'deleted') return item;
      if (!item.provider_id)
        throw new VslError('Resolve uncertain provisioning before deletion', 409);
      const [refs] =
        await tx`SELECT EXISTS(SELECT 1 FROM landing_hosting_settings WHERE video_asset_id=${id}) OR EXISTS(SELECT 1 FROM vsl_video_references WHERE video_id=${id}) OR EXISTS(SELECT 1 FROM landing_page_versions WHERE config_snapshot @> ${tx.json({ videoAssetId: id })} OR config_snapshot @> ${tx.json({ video_asset_id: id })}) AS present`;
      if (refs?.present) throw new VslError('VSL video is referenced', 409);
      await tx`UPDATE vsl_video_uploads SET state='delete_pending',updated_at=now() WHERE id=${id}`;
      return item;
    });
    if (row.state === 'deleted') return row;
    try {
      await this.provider.deleteVideo(row.provider_id);
    } catch {
      await this
        .sql`UPDATE vsl_video_uploads SET error_code='delete_outcome_uncertain' WHERE id=${id} AND state='delete_pending'`;
      throw new VslError('Stream deletion pending reconciliation', 502);
    }
    await this.sql.begin(async (tx) => {
      await this.lock(tx as unknown as Sql, id);
      await tx`UPDATE vsl_video_uploads SET state='deleted',error_code=NULL,updated_at=now() WHERE id=${id} AND state='delete_pending'`;
      await tx`UPDATE landing_video_assets SET status='deleted',updated_at=now() WHERE id=${id}`;
    });
    return this.status(id);
  }
}
