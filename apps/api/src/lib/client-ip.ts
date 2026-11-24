// IP do cliente para rate-limit (QA 15.4 SEC-001).
//
// - A API confia só no número de proxies configurado (TRUST_PROXY_HOPS;
//   Railway = 1): o X-Forwarded-For enviado pelo cliente não escolhe o IP.
// - O storefront (Vercel) chama a API servidor→servidor; com 1 hop o IP visto
//   seria o da Vercel, compartilhado por todos os clientes. Por isso ele envia
//   o IP do cliente em `x-ll-client-ip` + HMAC-SHA256 com o segredo
//   compartilhado LANDINGLAB_PROXY_SECRET. Sem segredo (ou assinatura
//   inválida) vale `request.ip` (comportamento com hops=1).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

import type { FastifyRequest } from 'fastify';

export const CLIENT_IP_HEADER = 'x-ll-client-ip';
export const CLIENT_IP_SIG_HEADER = 'x-ll-client-ip-sig';

/** Mesma assinatura do storefront (apps/landinglab-storefront/src/lib/client-ip-signature.ts). */
export function signClientIp(ip: string, secret: string): string {
  return createHmac('sha256', secret).update(`ll-client-ip:${ip}`).digest('hex');
}

function header(headers: Record<string, unknown>, name: string): string | null {
  const value = headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first.trim() : null;
}

/** IP do cliente enviado pelo storefront, se assinado com o segredo; senão null. */
export function trustedClientIp(headers: Record<string, unknown>, secret: string | null): string | null {
  if (!secret) return null;
  const ip = header(headers, CLIENT_IP_HEADER);
  const sig = header(headers, CLIENT_IP_SIG_HEADER);
  if (!ip || !sig || ip.length > 64 || isIP(ip) === 0 || !/^[0-9a-f]{64}$/i.test(sig)) return null;
  const expected = Buffer.from(signClientIp(ip, secret), 'hex');
  const given = Buffer.from(sig, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected) ? ip : null;
}

/** keyGenerator do @fastify/rate-limit: IP assinado pelo storefront, senão request.ip. */
export function clientIpKeyGenerator(secret: string | null): (request: FastifyRequest) => string {
  return (request) => trustedClientIp(request.headers as Record<string, unknown>, secret) ?? request.ip;
}

/**
 * QA 15.4 SEC-002 — em produção sem LANDINGLAB_PROXY_SECRET todas as chamadas
 * do storefront caem no bucket do IP de saída da Vercel. Não derruba o boot
 * (não há fallback seguro sem segredo), mas loga em `error` com a correção.
 */
export function reportMissingProxySecret(
  config: { nodeEnv: string; landinglabProxySecret: string | null },
  log: { error: (msg: string) => void },
): boolean {
  if (config.nodeEnv !== 'production' || config.landinglabProxySecret) return false;
  log.error(
    'LANDINGLAB_PROXY_SECRET ausente ou com menos de 32 caracteres: as chamadas do storefront (checkout, obrigado, /rastreio, /assinatura) ' +
      'compartilham o rate-limit do IP de saída da Vercel e clientes reais vão receber 429. Correção: gere um segredo ' +
      '(ex.: `openssl rand -hex 32`) e defina o MESMO valor em LANDINGLAB_PROXY_SECRET na API (Railway) e no storefront (Vercel); ' +
      'faça o deploy da API primeiro e depois do storefront.',
  );
  return true;
}
