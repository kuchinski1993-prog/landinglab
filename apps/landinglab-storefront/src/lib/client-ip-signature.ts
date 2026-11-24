// Assinatura do IP do cliente para a API (QA 15.4 SEC-001). Mesmo esquema de
// apps/api/src/lib/client-ip.ts: HMAC-SHA256(segredo, "ll-client-ip:<ip>").
// Só servidor (route handlers / páginas server-side) — usa node:crypto.
import { createHmac } from 'node:crypto';

const MIN_SECRET_LENGTH = 32;

export function proxySecret(): string | null {
  const secret = process.env['LANDINGLAB_PROXY_SECRET'] ?? '';
  return secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

export function signedClientIpHeaders(clientIp: string | null | undefined): Record<string, string> {
  const secret = proxySecret();
  const ip = clientIp?.trim();
  if (!secret || !ip || ip.length > 64) return {};
  return {
    'x-ll-client-ip': ip,
    'x-ll-client-ip-sig': createHmac('sha256', secret).update(`ll-client-ip:${ip}`).digest('hex'),
  };
}
