import { randomBytes, randomUUID } from 'node:crypto';

import { getDomain } from 'tldts';
import type { Sql } from 'postgres';
import { signVslPreviewToken, verifyVslPreviewToken } from '@blackshop/shared/vsl-preview-token';

import { digest, safePath, type Manifest, type VslStorage } from './storage.js';
import { STREAM_PLAYER_SOURCE } from './stream-player.js';
import { VslError } from './imports.js';
const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export interface PreviewConfig {
  domain: string;
  port?: string;
  frameOrigin: string;
  localDevelopment?: boolean;
  secret: string;
  ttlSeconds: number;
  hardTtlSeconds: number;
}
export function previewConfig(env: NodeJS.ProcessEnv = process.env): PreviewConfig {
  const secret = env['VSL_PREVIEW_TOKEN_SECRET'];
  if (!secret || secret.length < 32)
    throw new VslError('VSL preview signing configuration missing', 503);
  const domain = env['VSL_PREVIEW_DOMAIN']?.trim().toLowerCase(),
    frameOrigin = env['VSL_PREVIEW_FRAME_ORIGIN'];
  if (
    !domain ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) ||
    !domain.includes('.') ||
    domain.length > 200 ||
    !domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    !frameOrigin
  )
    throw new VslError('VSL preview configuration missing', 503);
  const frame = new URL(frameOrigin);
  if (
    env['NODE_ENV'] === 'production' &&
    (!getDomain(domain) || getDomain(domain) === getDomain(frame.hostname))
  )
    throw new VslError('VSL preview requires a separate registrable site from administration', 503);
  const localDevelopment =
    env['VSL_PREVIEW_LOCAL_TEST'] === 'true' &&
    env['NODE_ENV'] !== 'production' &&
    /\.(?:test|localhost)$/.test(domain) &&
    ['localhost', '127.0.0.1'].includes(frame.hostname);
  if (frame.origin !== frameOrigin || (frame.protocol !== 'https:' && !localDevelopment))
    throw new VslError('Invalid VSL frame origin', 503);
  const port = env['VSL_PREVIEW_PORT'];
  if (port && (!localDevelopment || !/^\d{1,5}$/.test(port) || Number(port) > 65535))
    throw new VslError('Invalid VSL preview port', 503);
  const ttlSeconds = Number(env['VSL_PREVIEW_TTL_SECONDS'] ?? 300),
    hardTtlSeconds = Number(env['VSL_PREVIEW_SESSION_MAX_SECONDS'] ?? 1800);
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > 300 ||
    !Number.isInteger(hardTtlSeconds) ||
    hardTtlSeconds < ttlSeconds ||
    hardTtlSeconds > 1800
  )
    throw new VslError('Invalid VSL preview expiration policy', 503);
  return { domain, frameOrigin, localDevelopment, port, secret, ttlSeconds, hardTtlSeconds };
}
export function previewHeaders(
  config: PreviewConfig,
  mime: string,
  streamHost?: string
): Record<string, string> {
  if (streamHost && !/^customer-[a-z0-9]+\.cloudflarestream\.com$/.test(streamHost))
    throw new VslError('Invalid VSL Stream CSP host', 503);
  return {
    'content-type': `${mime}${mime.startsWith('text/') || mime === 'application/javascript' ? '; charset=utf-8' : ''}`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'origin-agent-cluster': '?1',
    'content-security-policy': `default-src 'self'; script-src 'self' 'unsafe-inline'${streamHost ? ' https://embed.cloudflarestream.com' : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; worker-src 'none'; frame-src ${streamHost ? `https://${streamHost}` : "'none'"}; frame-ancestors ${config.frameOrigin}; sandbox allow-scripts allow-same-origin allow-forms`,
    'access-control-allow-origin': config.frameOrigin,
    vary: 'Origin',
  };
}
export class VslPreview {
  constructor(
    readonly sql: Sql,
    readonly storage: VslStorage,
    readonly config: PreviewConfig
  ) {}
  async create(pageId: string, revisionId: string) {
    const [row] = await this
      .sql`SELECT v.id,v.entry_path FROM landing_page_versions v JOIN vsl_releases r ON r.revision_id=v.id JOIN landing_pages p ON p.id=v.landing_page_id WHERE v.id=${revisionId} AND p.id=${pageId} AND p.content_mode='hosted' AND p.store_id='l0i'`;
    if (!row) throw new VslError('Sealed VSL revision not found', 404);
    const grant = randomBytes(32).toString('hex'),
      originId = randomBytes(16).toString('hex'),
      sessionId = randomUUID();
    const origin = `https://g-${originId}.${this.config.domain}${this.config.port ? `:${this.config.port}` : ''}`;
    const [session] = await this
      .sql`INSERT INTO vsl_preview_sessions(id,grant_hash,origin_id,origin,page_id,revision_id,expires_at,hard_expires_at) VALUES(${sessionId},${digest(grant)},${originId},${origin},${pageId},${revisionId},now()+${this.config.ttlSeconds}*interval '1 second',now()+${this.config.hardTtlSeconds}*interval '1 second') RETURNING expires_at`;
    const token = signVslPreviewToken(
      { pageId, revisionId },
      this.config.secret,
      Math.floor(Date.now() / 1000),
      this.config.ttlSeconds,
      sessionId
    );
    return {
      sessionId,
      pageId,
      revisionId,
      url: `${origin}/vsl-preview/${pageId}/${revisionId}/${grant}/__bootstrap?token=${encodeURIComponent(token)}`,
      origin,
      expiresAt: Math.floor(new Date(session!.expires_at).getTime() / 1000),
    };
  }

  async activate(
    host: string,
    pageId: string,
    revisionId: string,
    grant: string,
    token: string
  ): Promise<string | null> {
    if (
      !host.endsWith(`.${this.config.domain}${this.config.port ? `:${this.config.port}` : ''}`) ||
      !/^g-[0-9a-f]{32}\./.test(host)
    )
      return null;
    if (!/^[0-9a-f]{64}$/.test(grant) || !isUuid(pageId) || !isUuid(revisionId)) return null;
    const verified = verifyVslPreviewToken(token, this.config.secret);
    if (
      !verified.ok ||
      verified.payload.pageId !== pageId ||
      verified.payload.revisionId !== revisionId
    )
      return null;
    const origin = `https://${host}`;
    const [row] = await this
      .sql`UPDATE vsl_preview_sessions SET state='active' WHERE id=${verified.payload.jti} AND grant_hash=${digest(grant)} AND page_id=${pageId} AND revision_id=${revisionId} AND origin=${origin} AND state IN ('pending','active') AND expires_at>now() AND hard_expires_at>now() RETURNING revision_id`;
    if (!row) return null;
    const [revision] = await this
      .sql`SELECT entry_path FROM landing_page_versions WHERE id=${revisionId}`;
    return `/vsl-preview/${pageId}/${revisionId}/${grant}/${String(revision!.entry_path).split('/').map(encodeURIComponent).join('/')}`;
  }
  async renew(id: string, pageId: string, revisionId: string) {
    const [row] = await this
      .sql`UPDATE vsl_preview_sessions SET expires_at=LEAST(now()+${this.config.ttlSeconds}*interval '1 second',hard_expires_at) WHERE id=${id} AND page_id=${pageId} AND revision_id=${revisionId} AND state='active' AND expires_at>now() AND hard_expires_at>now() RETURNING expires_at`;
    if (!row) throw new VslError('Preview session expired', 410);
    return { expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000) };
  }
  async resolve(
    host: string,
    pageId: string,
    revisionId: string,
    grant: string,
    assetPath: string
  ): Promise<{ bytes: Buffer; mime: string } | null> {
    const expectedSuffix = `.${this.config.domain}${this.config.port ? `:${this.config.port}` : ''}`;
    if (
      !host.startsWith('g-') ||
      !host.endsWith(expectedSuffix) ||
      !/^g-[0-9a-f]{32}\./.test(host) ||
      !/^[0-9a-f]{64}$/.test(grant) ||
      !isUuid(pageId) ||
      !isUuid(revisionId)
    )
      return null;
    let name: string;
    try {
      name = safePath(assetPath);
    } catch {
      return null;
    }
    const origin = `https://${host}`;
    const [release] = await this
      .sql`SELECT r.storage_prefix,r.manifest FROM vsl_preview_sessions s JOIN vsl_releases r ON r.revision_id=s.revision_id AND r.page_id=s.page_id WHERE s.grant_hash=${digest(grant)} AND s.page_id=${pageId} AND s.revision_id=${revisionId} AND s.origin=${origin} AND s.state='active' AND s.expires_at>now() AND s.hard_expires_at>now()`;
    if (!release) return null;
    const manifest = release.manifest as Manifest;
    if (!(await this.storage.isSealed(release.storage_prefix, manifest))) return null;
    if (name === '__vsl/stream-player.mjs')
      return { bytes: Buffer.from(STREAM_PLAYER_SOURCE), mime: 'application/javascript' };
    if (name === 'manifest.json')
      return { bytes: Buffer.from(JSON.stringify(manifest)), mime: 'application/json' };
    const asset = Object.hasOwn(manifest.files, name) ? manifest.files[name] : null;
    if (!asset) return null;
    try {
      const bytes = await this.storage.read(`${release.storage_prefix}/${asset.storageKey}`);
      if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256) return null;
      return { bytes, mime: asset.mimeType };
    } catch {
      return null;
    }
  }
}
