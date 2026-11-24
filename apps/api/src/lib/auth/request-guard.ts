// Story 22.1a-2 · C-1 (A6) — CSRF das rotas de conta.
//
// `originAllowed` (lib/origin-guard.ts) deixa passar requisição SEM Origin porque "a sessão continua
// obrigatória" — mas login/cadastro/esqueci/definir senha não têm sessão. Aqui:
//  - `originRequired`: em produção, Origin AUSENTE ⇒ recusa; presente ⇒ precisa estar na allowlist.
//    Fora de produção, ausente passa (inject/curl de dev); presente segue a mesma allowlist.
//  - só `Content-Type: application/json` nas rotas com corpo (formulário HTML de outro site não
//    consegue mandar JSON sem preflight CORS) ⇒ outro tipo = 415.
// Roda em `onRequest` (antes do parse do corpo e do rate limit por corpo).
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AppConfig } from '../../config.js';
import { originAllowed } from '../origin-guard.js';

type GuardConfig = Pick<AppConfig, 'corsOrigin' | 'nodeEnv'>;

export function originRequired(config: GuardConfig, origin: string | undefined): boolean {
  if (!origin) return config.nodeEnv !== 'production';
  return originAllowed(config, origin);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
}

export interface PublicGuardOptions {
  /** Exige JSON (rotas com corpo). */
  json: boolean;
  /** `required` = rotas públicas sem sessão (C-1); `allowed` = mutações com sessão (D13). */
  origin: 'required' | 'allowed';
}

/** onRequest das rotas de conta. Recusa com 403 (origem) ou 415 (tipo), corpo fixo e sem eco. */
export function accountRequestGuard(config: GuardConfig, opts: PublicGuardOptions) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    const origin = firstHeader(request.headers.origin);
    const ok = opts.origin === 'required' ? originRequired(config, origin) : originAllowed(config, origin);
    if (!ok) return reply.code(403).send({ code: 'origin_not_allowed' });
    if (opts.json && !isJsonContentType(firstHeader(request.headers['content-type']))) {
      return reply.code(415).send({ code: 'unsupported_media_type' });
    }
    return undefined;
  };
}
