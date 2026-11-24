// Vídeos G3: intent sem SHA-256, política de origins por união, webhook e scan (Postgres real).
import { createHmac, randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { VslIndependentVideos } from '../independent-videos.js';
import { verifyStreamWebhook, type StreamAdapter, type StreamVideo } from '../stream.js';
import { startVslTestDatabase, type VslTestDatabase } from '../testing/pg-harness.js';

const SECRET = 'stream-webhook-secret';
let db: VslTestDatabase;
beforeAll(async () => { db = await startVslTestDatabase(); }, 60_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.reset(); });

class FakeStream implements StreamAdapter {
  remote = new Map<string, StreamVideo>();
  failMetadata = false;
  created: string[] = [];
  async createResumableUpload(intent: { id: string }) {
    const uid = randomBytes(16).toString('hex');
    this.created.push(intent.id);
    this.remote.set(uid, video(uid, intent.id, { state: 'pendingupload', ready: false }));
    return { providerId: uid, uploadUrl: `https://upload.videodelivery.net/tus/${uid}` };
  }
  async findByIntent(id: string) { return [...this.remote.values()].filter((item) => item.creator === `vsl-${id}`); }
  async getVideoStatus(id: string) {
    if (this.failMetadata) throw new Error('network');
    return this.remote.get(id) ?? null;
  }
  getVideoMetadata(id: string) { return this.getVideoStatus(id); }
  verifyWebhook(raw: Buffer, signature: string, now?: number) { return verifyStreamWebhook(raw, signature, SECRET, now); }
  getPlaybackDescriptor(id: string) {
    return { provider: 'cloudflare_stream' as const, videoId: id, iframeUrl: `https://customer-x.cloudflarestream.com/${id}/iframe`, sdkUrl: 'sdk', events: [] as never, signed: false as const };
  }
  async deleteVideo() { /* noop */ }
}
function video(uid: string, assetId: string, patch: Partial<StreamVideo> = {}): StreamVideo {
  return { uid, creator: `vsl-${assetId}`, modified: new Date().toISOString(), state: 'ready', ready: true, size: 1000, duration: 60,
    width: 1280, height: 720, allowedOrigins: ['preview.vsl.test'], signed: false, ...patch };
}
const sign = (raw: Buffer) => {
  const time = Math.floor(Date.now() / 1000);
  return `time=${time},sig1=${createHmac('sha256', SECRET).update(`${time}.`).update(raw).digest('hex')}`;
};

describe('VslIndependentVideos', () => {
  let stream: FakeStream;
  let videos: VslIndependentVideos;
  const policy = ['preview.vsl.test'];
  beforeEach(() => {
    stream = new FakeStream();
    videos = new VslIndependentVideos(db.sql, stream, async () => policy);
  });

  it('creates an upload intent without full-file SHA-256 and flags sampled duplicates', async () => {
    const sample = 'b'.repeat(64);
    const first = await videos.create('VSL', 'key-1', { bytes: 1000, mimeType: 'video/mp4', sampleSha256: sample });
    expect(first.uploadUrl).toMatch(/^https:\/\/upload\.videodelivery\.net\//);
    expect(first.possibleDuplicateOf).toBeNull();
    const second = await videos.create('VSL cópia', 'key-2', { bytes: 1000, mimeType: 'video/mp4', sampleSha256: sample });
    expect(second.possibleDuplicateOf).toBe(first.id);
    const retry = await videos.create('VSL', 'key-1', { bytes: 1000, mimeType: 'video/mp4', sampleSha256: sample });
    expect(retry).toMatchObject({ id: first.id, clientResumeRequired: true });
    await expect(videos.create('VSL', 'key-1', { bytes: 2000, mimeType: 'video/mp4' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(videos.create('VSL', 'key-3', { bytes: 1000, mimeType: 'video/avi' })).rejects.toMatchObject({ code: 'video_intent_invalid' });
    await expect(videos.create('VSL', 'key-4', { bytes: 6e9, mimeType: 'video/mp4' })).rejects.toMatchObject({ code: 'video_too_large' });
  });

  it('accepts origins added by publish (union policy) and rejects foreign ones', async () => {
    const created = await videos.create('VSL', 'k', { bytes: 1000, mimeType: 'video/mp4' });
    const uid = String(created.provider_asset_id);
    stream.remote.set(uid, video(uid, created.id, { allowedOrigins: ['preview.vsl.test', 'oferta.example.com'] }));
    // oferta.example.com só é aceito se já recebeu publish (está na política).
    policy.push('oferta.example.com');
    expect((await videos.reconcile(created.id)).status).toBe('ready');
    policy.pop();

    const other = await videos.create('VSL 2', 'k2', { bytes: 1000, mimeType: 'video/mp4' });
    const uid2 = String(other.provider_asset_id);
    stream.remote.set(uid2, video(uid2, other.id, { allowedOrigins: ['evil.example.com'] }));
    const rejected = await videos.reconcile(other.id);
    expect(rejected).toMatchObject({ status: 'failed', error_message: 'video_policy_rejected' });
  });

  it('builds the policy from env + preview + hostnames that received a release', async () => {
    const real = new VslIndependentVideos(db.sql, stream);
    const [domain] = await db.sql`INSERT INTO blackshop_domains(hostname) VALUES('oferta.example.com') RETURNING id`;
    await db.sql`INSERT INTO blackshop_domains(hostname) VALUES('nunca-publicado.example.com')`;
    const [project] = await db.sql`INSERT INTO vsl_projects(name) VALUES('P') RETURNING id`;
    await db.sql`INSERT INTO vsl_project_releases(project_id,version_number,domain_id) VALUES(${project!.id},1,${domain!.id})`;
    const previous = { ...process.env };
    process.env['VSL_STREAM_ALLOWED_ORIGINS'] = 'app.example.com';
    process.env['VSL_PREVIEW_DOMAIN'] = 'preview.vsl.test';
    try {
      expect((await real.originPolicy()).sort()).toEqual(['app.example.com', 'oferta.example.com', 'preview.vsl.test']);
    } finally { process.env = previous; }
  });

  it('webhook verifies the signature, matches by uid or creator and reconciles', async () => {
    const created = await videos.create('VSL', 'k', { bytes: 1000, mimeType: 'video/mp4' });
    const uid = String(created.provider_asset_id);
    stream.remote.set(uid, video(uid, created.id));
    const raw = Buffer.from(JSON.stringify({ uid, creator: `vsl-${created.id}`, readyToStream: true }));
    await expect(videos.webhook(raw, 'time=1,sig1=' + '0'.repeat(64))).rejects.toMatchObject({ code: 'webhook_signature_invalid' });
    await expect(videos.webhook(Buffer.from('nope'), sign(Buffer.from('nope')))).rejects.toMatchObject({ code: 'webhook_invalid' });
    expect(await videos.webhook(raw, sign(raw))).toMatchObject({ matched: true, reconciled: true, videoId: created.id });
    expect((await videos.status(created.id)).status).toBe('ready');
    const unknown = Buffer.from(JSON.stringify({ uid: 'f'.repeat(32) }));
    expect(await videos.webhook(unknown, sign(unknown))).toEqual({ accepted: true, matched: false });

    // Upload cujo providerId se perdeu: casa pelo creator.
    const [lost] = await db.sql`INSERT INTO vsl_video_assets(name,status) VALUES('perdido','uploading') RETURNING id`;
    await db.sql`INSERT INTO vsl_video_upload_intents(id,request_key,request_hash,declared_bytes,mime_type,expires_at) VALUES(${lost!.id},'lost','h',1000,'video/mp4',now()+interval '1 day')`;
    const lostUid = 'a'.repeat(32);
    stream.remote.set(lostUid, video(lostUid, String(lost!.id)));
    const lostRaw = Buffer.from(JSON.stringify({ uid: lostUid, creator: `vsl-${lost!.id}` }));
    expect(await videos.webhook(lostRaw, sign(lostRaw))).toMatchObject({ matched: true, reconciled: true });
    expect((await videos.status(String(lost!.id))).provider_asset_id).toBe(lostUid);
  });

  it('webhook keeps the video in the scan when reconcile fails transiently', async () => {
    const created = await videos.create('VSL', 'k', { bytes: 1000, mimeType: 'video/mp4' });
    await db.sql`UPDATE vsl_video_assets SET next_reconcile_at=now()+interval '1 hour' WHERE id=${created.id}`;
    stream.failMetadata = true;
    const raw = Buffer.from(JSON.stringify({ uid: created.provider_asset_id }));
    expect(await videos.webhook(raw, sign(raw))).toMatchObject({ matched: true, reconciled: false });
    const [row] = await db.sql`SELECT next_reconcile_at <= now() AS due, last_webhook_at IS NOT NULL AS hooked FROM vsl_video_assets WHERE id=${created.id}`;
    expect(row).toEqual({ due: true, hooked: true });
  });

  it('scan claims each pending video once (dedupe), backs off and never rescans failed', async () => {
    const a = await videos.create('A', 'a', { bytes: 1000, mimeType: 'video/mp4' });
    const b = await videos.create('B', 'b', { bytes: 1000, mimeType: 'video/mp4' });
    stream.remote.set(String(a.provider_asset_id), video(String(a.provider_asset_id), a.id));
    stream.remote.set(String(b.provider_asset_id), video(String(b.provider_asset_id), b.id, { state: 'error', ready: false, errorCode: 'ERR_NON_VIDEO' }));
    expect(await videos.scan()).toMatchObject({ claimed: 2, reconciled: 2 });
    expect((await videos.status(a.id)).status).toBe('ready');
    expect((await videos.status(b.id)).status).toBe('failed');
    expect(await videos.scan()).toMatchObject({ claimed: 0 });

    const c = await videos.create('C', 'c', { bytes: 1000, mimeType: 'video/mp4' });
    expect(await videos.scan()).toMatchObject({ claimed: 1, reconciled: 1 }); // ainda pendingupload
    expect(await videos.scan()).toMatchObject({ claimed: 0 }); // backoff: não reprocessa já
    const [row] = await db.sql`SELECT reconcile_attempts, next_reconcile_at > now() AS later FROM vsl_video_assets WHERE id=${c.id}`;
    expect(row).toEqual({ reconcile_attempts: 1, later: true });
  });

  it('scan fails expired uploads and exhausted reconciliations', async () => {
    const expired = await videos.create('E', 'e', { bytes: 1000, mimeType: 'video/mp4' });
    await db.sql`UPDATE vsl_video_upload_intents SET expires_at=now()-interval '2 hours' WHERE id=${expired.id}`;
    const stuck = await videos.create('S', 's', { bytes: 1000, mimeType: 'video/mp4' });
    stream.remote.set(String(stuck.provider_asset_id), video(String(stuck.provider_asset_id), stuck.id, { state: 'inprogress', ready: false }));
    await db.sql`UPDATE vsl_video_assets SET reconcile_attempts=39 WHERE id=${stuck.id}`;
    expect(await videos.scan()).toMatchObject({ claimed: 2, failed: 2 });
    expect(await videos.status(expired.id)).toMatchObject({ status: 'failed', error_message: 'upload_expired' });
    expect(await videos.status(stuck.id)).toMatchObject({ status: 'failed', error_message: 'reconcile_timeout' });
  });

  it('playback requires a ready video', async () => {
    const created = await videos.create('VSL', 'k', { bytes: 1000, mimeType: 'video/mp4' });
    await expect(videos.playback(created.id)).rejects.toMatchObject({ code: 'video_not_ready' });
    await expect(videos.status('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'video_not_found' });
  });
});

describe('videoSampleRanges', () => {
  it('reads at most 3 MiB in three non-overlapping ranges', async () => {
    const { videoSampleRanges } = await import('../independent-videos.js');
    const MIB = 1024 * 1024;
    expect(videoSampleRanges(0)).toEqual([]);
    expect(videoSampleRanges(2 * MIB)).toEqual([[0, 2 * MIB]]);
    const ranges = videoSampleRanges(1000 * MIB);
    expect(ranges).toEqual([[0, MIB], [500 * MIB - MIB / 2, 500 * MIB + MIB / 2], [999 * MIB, 1000 * MIB]]);
    expect(ranges.reduce((total, [start, end]) => total + end - start, 0)).toBe(3 * MIB);
    const small = videoSampleRanges(3 * MIB + 1);
    for (let i = 1; i < small.length; i++) expect(small[i]![0]).toBeGreaterThanOrEqual(small[i - 1]![1]);
  });
});
