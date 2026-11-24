import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const VSL_PREVIEW_AUDIENCE = 'vsl-preview';
export const VSL_PREVIEW_TTL_SECONDS = 5 * 60;

export interface VslPreviewTokenPayload {
  audience: typeof VSL_PREVIEW_AUDIENCE;
  pageId: string;
  revisionId: string;
  issuedAt: number;
  expiresAt: number;
  jti: string;
}

export type VslPreviewTokenVerification =
  | { ok: true; payload: VslPreviewTokenPayload }
  | { ok: false; reason: 'malformed' | 'invalid_signature' | 'expired' | 'wrong_audience' };

function encode(input: Buffer): string {
  return input.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized + '='.repeat((4 - (normalized.length % 4)) % 4), 'base64');
}

function signature(payload: string, secret: string): string {
  return encode(createHmac('sha256', secret).update(payload).digest());
}

export function signVslPreviewToken(
  input: Pick<VslPreviewTokenPayload, 'pageId' | 'revisionId'>,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  ttlSeconds = VSL_PREVIEW_TTL_SECONDS,
  jti = randomUUID()
): string {
  const payload: VslPreviewTokenPayload = {
    audience: VSL_PREVIEW_AUDIENCE,
    pageId: input.pageId,
    revisionId: input.revisionId,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + ttlSeconds,
    jti,
  };
  const encodedPayload = encode(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${encodedPayload}.${signature(encodedPayload, secret)}`;
}

export function verifyVslPreviewToken(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): VslPreviewTokenVerification {
  if (typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const [encodedPayload, providedSignature, ...extra] = token.split('.');
  if (!encodedPayload || !providedSignature || extra.length > 0) {
    return { ok: false, reason: 'malformed' };
  }
  const expectedSignature = signature(encodedPayload, secret);
  const expected = Buffer.from(expectedSignature, 'utf8');
  const provided = Buffer.from(providedSignature, 'utf8');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  let payload: VslPreviewTokenPayload;
  try {
    payload = JSON.parse(decode(encodedPayload).toString('utf8')) as VslPreviewTokenPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    payload.audience !== VSL_PREVIEW_AUDIENCE ||
    typeof payload.pageId !== 'string' ||
    typeof payload.revisionId !== 'string' ||
    typeof payload.issuedAt !== 'number' ||
    typeof payload.expiresAt !== 'number' ||
    typeof payload.jti !== 'string'
  ) {
    return {
      ok: false,
      reason: payload.audience !== VSL_PREVIEW_AUDIENCE ? 'wrong_audience' : 'malformed',
    };
  }
  if (payload.expiresAt <= nowSeconds || payload.issuedAt > nowSeconds + 30) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, payload };
}
