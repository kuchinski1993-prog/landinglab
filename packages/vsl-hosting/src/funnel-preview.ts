import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/** `picker`: a prévia injeta o script "clique para escolher" (só prévia, nunca público). */
export const VSL_PREVIEW_PICKERS = ['video', 'cta'] as const;
export type VslPreviewPicker = (typeof VSL_PREVIEW_PICKERS)[number];
export interface FunnelPreviewGrant { projectId: string; expiresAt: number; nonce: string; picker?: VslPreviewPicker }
const sign = (body: string, secret: string) => createHmac('sha256', secret).update(`vsl-funnel-preview.v1.${body}`).digest('base64url');
const isPicker = (value: unknown): value is VslPreviewPicker => typeof value === 'string' && (VSL_PREVIEW_PICKERS as readonly string[]).includes(value);

export function signFunnelPreview(projectId: string, secret: string, now = Math.floor(Date.now() / 1000), ttlSeconds = 900,
  options: { picker?: VslPreviewPicker } = {}): string {
  if (!/^[0-9a-f-]{36}$/.test(projectId) || secret.length < 32 || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 1800 ||
    (options.picker !== undefined && !isPicker(options.picker)))
    throw new Error('Invalid VSL preview grant configuration');
  const grant: FunnelPreviewGrant = { projectId, expiresAt: now + ttlSeconds, nonce: randomUUID(), ...(options.picker ? { picker: options.picker } : {}) };
  const body = Buffer.from(JSON.stringify(grant)).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

export function verifyFunnelPreview(token: string, secret: string, now = Math.floor(Date.now() / 1000)): FunnelPreviewGrant | null {
  if (!secret || secret.length < 32 || token.length > 1024) return null;
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  const expected = Buffer.from(sign(body, secret));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try {
    const grant = JSON.parse(Buffer.from(body, 'base64url').toString()) as FunnelPreviewGrant;
    if (!/^[0-9a-f-]{36}$/.test(grant.projectId) || !/^[0-9a-f-]{36}$/.test(grant.nonce) ||
      !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= now || grant.expiresAt > now + 1800 ||
      (grant.picker !== undefined && !isPicker(grant.picker))) return null;
    return grant;
  } catch { return null; }
}
