// Story 22.1a-2 · D6/A11 + SEC-003 (QA 22.1a-1) — rate limit por IP das rotas públicas de conta.
//
// QUAL IP (A11): a API confia só em TRUST_PROXY_HOPS proxies (Railway = 1). O painel chama a API
// pelo rewrite da Vercel (`/api/*` → API), então `request.ip` é o IP de SAÍDA da Vercel (pool
// compartilhado), não o do navegador. Os cabeçalhos `x-forwarded-for`/`x-real-ip`/
// `x-vercel-forwarded-for` NÃO são confiáveis aqui: a API também é alcançável direto na Railway e
// qualquer um pode forjá-los. O único IP de cliente confiável é o ASSINADO (`x-ll-client-ip` +
// HMAC com LANDINGLAB_PROXY_SECRET — lib/client-ip.ts); sem ele vale `request.ip`. (Recomendação
// para a 22.1b: o middleware do painel assinar o IP do cliente com o mesmo cabeçalho.)
//
// Por isso o limite por IP é REDE DE SEGURANÇA, e as chaves são compostas para um terceiro que
// divide o IP da Vercel com o dono não conseguir esgotar o balde do dono:
//  - login / emergência / esqueci: IP + e-mail (sha256 truncado; o e-mail em claro não vira chave);
//  - definir/validar senha: IP + prefixo do sha256 do token (quem não tem o link não acerta o balde);
//  - cadastro: só IP (não protege conta existente).
// O controle principal contra força bruta continua sendo o bloqueio por conta (throttle.ts), e o
// dono sempre tem saída: o link de redefinição usado ABRE sessão (SEC-003), sem passar pela trava.
import { createHash } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

import { clientIpKeyGenerator } from '../client-ip.js';

export interface AuthRateLimit {
  max: number;
  timeWindow: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** D6: login 10/min, cadastro 5/h, esqueci 5/h, definir senha 10/h (por chave). */
export const AUTH_RATE_LIMITS = {
  login: { max: 10, timeWindow: MINUTE },
  emergency: { max: 10, timeWindow: MINUTE },
  signup: { max: 5, timeWindow: HOUR },
  forgot: { max: 5, timeWindow: HOUR },
  passwordSet: { max: 10, timeWindow: HOUR },
  passwordValidate: { max: 30, timeWindow: HOUR },
  passwordChange: { max: 10, timeWindow: HOUR },
} as const satisfies Record<string, AuthRateLimit>;

export type AuthRateLimitName = keyof typeof AUTH_RATE_LIMITS;

function shortHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

function bodyField(request: FastifyRequest, field: string): string {
  const body = request.body as Record<string, unknown> | null | undefined;
  const value = body && typeof body === 'object' ? body[field] : undefined;
  return typeof value === 'string' ? value : '';
}

export type AuthKeyKind = 'ip' | 'ip+email' | 'ip+token' | 'ip+legacy';

/** keyGenerator do @fastify/rate-limit (hook `preHandler`: o corpo já foi validado). */
export function authRateLimitKey(kind: AuthKeyKind, proxySecret: string | null): (request: FastifyRequest) => string {
  const ipOf = clientIpKeyGenerator(proxySecret);
  return (request) => {
    const ip = ipOf(request);
    switch (kind) {
      case 'ip':
        return `auth:${ip}`;
      case 'ip+legacy':
        return `auth:${ip}|legacy`;
      case 'ip+email':
        return `auth:${ip}|e:${shortHash(bodyField(request, 'email').trim().toLowerCase())}`;
      case 'ip+token':
        return `auth:${ip}|t:${shortHash(bodyField(request, 'token'))}`;
    }
  };
}
