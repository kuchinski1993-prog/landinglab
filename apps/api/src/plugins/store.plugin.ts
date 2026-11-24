// Store context plugin — injects request.storeId from the X-Store-Id header.
//
// Story 17.2a · o cabeçalho passa a ser VALIDADO (docs/architecture/isolamento-de-loja.md):
//   ausente/vazio → 'default' (vitrine pública, checkout, webhooks de hoje), sem consultar o banco;
//   'default'     → sem consultar o banco (custo zero para a AuthenLondon);
//   formato inválido (espaço, vírgula, controle, > 64, cabeçalho repetido) → 400 validation_failed
//                   `details.reason = 'invalid_store_id'`, sem consultar o banco;
//   inexistente   → 404 plataforma.store_not_found;  desativada → 409 plataforma.store_inactive;
//   banco falhou  → 503 service_unavailable (fail-closed: nunca cai em 'default').
// Rotas ISENTAS (STORE_VALIDATION_EXEMPT_PREFIXES + zonas protegidas da 18.4, menos as rotas do
// painel do Atendimento — ATENDIMENTO_VALIDATED_PREFIXES, 17.6a) leem o cabeçalho exatamente como
// antes, sem validação.
import { isProtectedPath } from '@blackshop/observability';
import { COMMON_CATALOG } from '@blackshop/errors';
import { sendError } from '@blackshop/errors/fastify';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { PLATAFORMA_ERRORS } from '../lib/plataforma-errors.js';
import { createStoreResolver, isValidStoreIdFormat, type StoreResolver } from '../lib/store-resolver.js';

import '../types.js';

export const DEFAULT_STORE_ID = 'default';

/**
 * Prefixos (por segmento) fora da validação, além das zonas protegidas (PROTECTED_ROUTE_PREFIXES):
 * - `/webhooks` — Shopify/Stripe/Resend não mandam X-Store-Id; resolver por domínio é a 17.3.
 * - `/health`   — healthcheck do Railway; não lê dado de loja.
 * - `/stores`   — lista/cria/edita lojas e módulos: precisa responder mesmo com o cookie do painel
 *                 apontando para uma loja que sumiu/foi desativada (é como o painel se recupera).
 * - `/auth`     — login/logout/sessão: pelo mesmo motivo, o painel não pode ficar sem entrar.
 * - `/admin/users` — Story 22.1a-2 (C-2): tela de usuários é de CONTA (não de loja); com o cookie do
 *                 painel apontando para uma loja removida/inativa ela precisa continuar respondendo,
 *                 mesmo motivo de `/auth`.
 */
export const STORE_VALIDATION_EXEMPT_PREFIXES: readonly string[] = ['/webhooks', '/health', '/stores', '/auth', '/admin/users'];

/**
 * Story 17.6a · rotas autenticadas do Atendimento (painel) que SAEM da isenção das zonas protegidas
 * e passam a validar o X-Store-Id como o resto do painel (inexistente → 404, inativa → 409; ausente
 * ou `default` → sem consulta ao banco). Continuam isentas as chamadas externas, com allowlist
 * própria ou HMAC: `/webhooks/email/inbound` (17.6b), `/storefront/support|orders|refunds`.
 * A lista PROTECTED_ROUTE_PREFIXES da observabilidade (18.4) não muda.
 */
export const ATENDIMENTO_VALIDATED_PREFIXES: readonly string[] = [
  '/inbox',
  '/inbound-emails',
  '/automation-config',
  '/notifications',
  '/email-templates',
  '/refunds',
];

/** A rota fica fora da validação do X-Store-Id (zona protegida ou isenção justificada)? */
export function isStoreValidationExempt(url: string | undefined): boolean {
  const protectedExempt = isProtectedPath(url) && !isProtectedPath(url, ATENDIMENTO_VALIDATED_PREFIXES);
  return protectedExempt || isProtectedPath(url, STORE_VALIDATION_EXEMPT_PREFIXES);
}

/** Leitura de antes da 17.2a (rotas isentas): 1º valor, aparado; vazio → 'default'. */
function legacyStoreId(request: FastifyRequest): string {
  const header = request.headers['x-store-id'];
  const raw = Array.isArray(header) ? header[0] : header;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : DEFAULT_STORE_ID;
}

export interface RegisteredRoute {
  method: string;
  url: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Story 17.2a · resolve a loja do X-Store-Id (testes trocam pelo resolvedor permissivo). */
    storeResolver: StoreResolver;
    /** Story 17.2a · rotas registradas depois deste plugin (contrato do inventário de isolamento). */
    registeredRoutes: RegisteredRoute[];
  }
}

const storePlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('storeId', DEFAULT_STORE_ID);
  fastify.decorate('storeResolver', createStoreResolver());
  fastify.decorate('registeredRoutes', [] as RegisteredRoute[]);

  fastify.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) fastify.registeredRoutes.push({ method: String(method), url: route.url });
  });

  fastify.addHook('onRequest', async (request, reply) => {
    if (isStoreValidationExempt(request.url)) {
      request.storeId = legacyStoreId(request);
      return;
    }

    const header = request.headers['x-store-id'];
    if (Array.isArray(header)) {
      return sendError(reply, COMMON_CATALOG, 'validation_failed', { reason: 'invalid_store_id' });
    }
    const value = typeof header === 'string' ? header.trim() : '';
    if (value.length === 0 || value === DEFAULT_STORE_ID) {
      request.storeId = DEFAULT_STORE_ID;
      return;
    }
    if (!isValidStoreIdFormat(value)) {
      return sendError(reply, COMMON_CATALOG, 'validation_failed', { reason: 'invalid_store_id' });
    }

    let status;
    try {
      status = await fastify.storeResolver.resolve(fastify.db, value);
    } catch (err) {
      request.log.error({ err, storeId: value }, 'store resolution failed');
      return sendError(reply, COMMON_CATALOG, 'service_unavailable');
    }
    if (status === 'missing') {
      return sendError(reply, PLATAFORMA_ERRORS, 'plataforma.store_not_found', { storeId: value });
    }
    if (status === 'inactive') {
      return sendError(reply, PLATAFORMA_ERRORS, 'plataforma.store_inactive', { storeId: value });
    }
    request.storeId = value;
  });
};

export default fp(storePlugin, { name: 'store-plugin' });
