import { createHmac, timingSafeEqual } from 'node:crypto';

import { VslError } from './imports.js';
export const VIDEO_LIMITS = { bytes: 5_000_000_000, seconds: 7200 } as const;
export const STREAM_SDK = 'https://embed.cloudflarestream.com/embed/sdk.latest.js';
export const STREAM_EVENTS = [
  'play',
  'pause',
  'playing',
  'waiting',
  'timeupdate',
  'seeking',
  'seeked',
  'ended',
  'error',
  'loadedmetadata',
] as const;
export interface StreamVideo {
  uid: string;
  creator: string;
  modified: string;
  state: string;
  ready: boolean;
  size: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  allowedOrigins: string[];
  signed: boolean;
  errorCode?: string;
}
export interface PlaybackDescriptor {
  provider: 'cloudflare_stream';
  videoId: string;
  iframeUrl: string;
  sdkUrl: string;
  events: typeof STREAM_EVENTS;
  signed: false;
}
export interface StreamAdapter {
  createResumableUpload(intent: {
    id: string;
    bytes: number;
    expiresAt: string;
  }): Promise<{ providerId: string; uploadUrl: string }>;
  findByIntent(id: string): Promise<StreamVideo[]>;
  getVideoStatus(id: string): Promise<StreamVideo | null>;
  getVideoMetadata(id: string): Promise<StreamVideo | null>;
  verifyWebhook(raw: Buffer, signature: string, now?: number): boolean;
  getPlaybackDescriptor(id: string): PlaybackDescriptor;
  deleteVideo(id: string): Promise<void>;
}
export function verifyStreamWebhook(
  raw: Buffer,
  signature: string,
  secret: string,
  now = Math.floor(Date.now() / 1000)
): boolean {
  if (!secret || raw.length > 1024 * 1024) return false;
  const match = /^time=(\d{1,12}),sig1=([0-9a-f]{64})$/.exec(signature);
  if (!match || Math.abs(now - Number(match[1])) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${match[1]}.`).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(match[2]!, 'hex'));
}
export function validateVideoBytes(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > VIDEO_LIMITS.bytes)
    throw new VslError('VSL video must be between 1 byte and 5 GB', 413);
}
export function validateUploadUrl(input: string): URL {
  const url = new URL(input);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !['upload.videodelivery.net', 'upload.cloudflarestream.com'].includes(url.hostname)
  )
    throw new VslError('Invalid Stream upload capability', 502);
  return url;
}
const providerId = (id: string): string => {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new VslError('Invalid Stream video identity', 502);
  return id;
};
export function streamPlaybackDescriptor(id: string, customerHost: string): PlaybackDescriptor {
  if (!/^customer-[a-z0-9]+\.cloudflarestream\.com$/.test(customerHost))
    throw new VslError('Invalid VSL Stream playback host', 503);
  return {
    provider: 'cloudflare_stream',
    videoId: providerId(id),
    iframeUrl: `https://${customerHost}/${id}/iframe`,
    sdkUrl: STREAM_SDK,
    events: STREAM_EVENTS,
    signed: false,
  };
}
export interface StreamConfig {
  accountId: string;
  apiToken: string;
  webhookSecret: string;
  customerHost: string;
  allowedOrigins: string[];
}
export function streamConfig(env: NodeJS.ProcessEnv = process.env): StreamConfig {
  const accountId = env['VSL_STREAM_ACCOUNT_ID'],
    apiToken = env['VSL_STREAM_API_TOKEN'],
    webhookSecret = env['VSL_STREAM_WEBHOOK_SECRET'],
    customerHost = env['VSL_STREAM_CUSTOMER_HOST'];
  const allowedOrigins = (env['VSL_STREAM_ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (
    !accountId ||
    !/^[0-9a-f]{32}$/.test(accountId) ||
    !apiToken ||
    !webhookSecret ||
    !customerHost ||
    !/^customer-[a-z0-9]+\.cloudflarestream\.com$/.test(customerHost) ||
    !allowedOrigins.length ||
    allowedOrigins.some(
      (x) =>
        !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/.test(x) ||
        !x.includes('.') ||
        x === '*'
    )
  )
    throw new VslError('VSL Stream server configuration missing or invalid', 503, 'stream_not_configured');
  // A scoped wildcard is only allowed under the configured, dedicated VSL preview domain.
  if (allowedOrigins.some((x) => x.startsWith('*.') && x !== `*.${env['VSL_PREVIEW_DOMAIN']}`))
    throw new VslError('Stream wildcard must be confined to dedicated VSL preview domain', 503, 'stream_not_configured');
  return { accountId, apiToken, webhookSecret, customerHost, allowedOrigins };
}
export class CloudflareStreamAdapter implements StreamAdapter {
  constructor(
    private readonly config: StreamConfig,
    private readonly network: typeof fetch = fetch
  ) {}
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.network(
        `https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/stream${path}`,
        {
          ...init,
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
          headers: { ...init.headers, authorization: `Bearer ${this.config.apiToken}` },
        }
      );
    } catch {
      throw new VslError('Stream request outcome uncertain; reconcile before retry', 502);
    }
  }
  private async result(response: Response): Promise<unknown> {
    if (!response.ok) throw new VslError('Stream operation unavailable', 502);
    try {
      const data = (await response.json()) as { success: boolean; result: unknown };
      if (!data.success) throw new Error();
      return data.result;
    } catch {
      throw new VslError('Invalid Stream response', 502);
    }
  }
  private normalize(input: unknown): StreamVideo {
    const data = input as Record<string, unknown>,
      status = data?.['status'] as
        | { state?: string; errorReasonCode?: string; errReasonCode?: string }
        | undefined,
      dimensions = data?.['input'] as { width?: number; height?: number } | undefined;
    const number = (x: unknown) =>
      typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
    if (
      !data ||
      typeof data['uid'] !== 'string' ||
      typeof data['creator'] !== 'string' ||
      typeof data['modified'] !== 'string' ||
      !Number.isFinite(Date.parse(data['modified']))
    )
      throw new VslError('Invalid Stream metadata', 502);
      // Política de origins (união de VSL_STREAM_ALLOWED_ORIGINS + hostnames publicados) é
    // aplicada por quem consome os metadados (independent-videos/videos): o publish adiciona
    // hostnames ao vídeo, então exigir igualdade exata aqui quebrava reconcile/webhook.
    return {
      uid: providerId(data['uid']),
      creator: data['creator'],
      modified: data['modified'],
      state: status?.state ?? 'unknown',
      errorCode: [
        'ERR_NON_VIDEO',
        'ERR_DURATION_EXCEED_CONSTRAINT',
        'ERR_FETCH_ORIGIN_ERROR',
        'ERR_MALFORMED_VIDEO',
        'ERR_DURATION_TOO_SHORT',
        'ERR_UNKNOWN',
      ].includes(status?.errorReasonCode ?? status?.errReasonCode ?? '')
        ? (status?.errorReasonCode ?? status?.errReasonCode)
        : undefined,
      ready: data['readyToStream'] === true,
      size: number(data['size']),
      duration: number(data['duration']),
      width: number(dimensions?.width),
      height: number(dimensions?.height),
      allowedOrigins: Array.isArray(data['allowedOrigins'])
        ? (data['allowedOrigins'] as string[])
        : [],
      signed: data['requireSignedURLs'] === true,
    };
  }
  async createResumableUpload(intent: { id: string; bytes: number; expiresAt: string }) {
    validateVideoBytes(intent.bytes);
    const metadata = Object.entries({
      name: `vsl-${intent.id}`,
      maxDurationSeconds: '7200',
      expiry: intent.expiresAt,
      allowedorigins: this.config.allowedOrigins.join(','),
    })
      .map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`)
      .join(',');
    const response = await this.request('?direct_user=true', {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(intent.bytes),
        'Upload-Creator': `vsl-${intent.id}`,
        'Upload-Metadata': metadata,
      },
    });
    if (response.status !== 201)
      throw new VslError('Stream provisioning outcome requires reconciliation', 502);
    const id = response.headers.get('stream-media-id'),
      url = response.headers.get('location');
    if (!id || !url) throw new VslError('Stream provisioning identity missing; reconcile', 502);
    providerId(id);
    validateUploadUrl(url);
    return { providerId: id, uploadUrl: url };
  }
  async findByIntent(id: string): Promise<StreamVideo[]> {
    const data = await this.result(
      await this.request(`?creator=${encodeURIComponent(`vsl-${id}`)}&limit=1000`)
    );
    if (!Array.isArray(data)) throw new VslError('Invalid Stream reconciliation response', 502);
    // Empty results do not prove non-existence after a lost response. Caller never recreates blindly.
    return data.map((x) => this.normalize(x)).filter((x) => x.creator === `vsl-${id}`);
  }
  async getVideoStatus(id: string): Promise<StreamVideo | null> {
    const response = await this.request(`/${providerId(id)}`);
    if (response.status === 404) return null;
    return this.normalize(await this.result(response));
  }
  getVideoMetadata(id: string) {
    return this.getVideoStatus(id);
  }
  verifyWebhook(raw: Buffer, signature: string, now?: number) {
    return verifyStreamWebhook(raw, signature, this.config.webhookSecret, now);
  }
  getPlaybackDescriptor(id: string): PlaybackDescriptor {
    return streamPlaybackDescriptor(id, this.config.customerHost);
  }
  async deleteVideo(id: string): Promise<void> {
    const response = await this.request(`/${providerId(id)}`, { method: 'DELETE' });
    if (response.status === 404 || response.status === 204) return;
    if (!response.ok) throw new VslError('Stream operation unavailable', 502);
    const body = await response.text();
    if (!body.trim()) return;
    try {
      const data = JSON.parse(body) as { success?: boolean };
      if (data.success !== true) throw new Error();
    } catch {
      throw new VslError('Invalid Stream response', 502);
    }
  }
}
