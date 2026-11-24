// Story 19.3a — registro de módulos por loja (ligar/desligar).
//
//   GET   /stores/:id/modules            (sessão)
//         → { storeId, modules: [{ id, label, area, enabled, alwaysOn }] }
//   PATCH /stores/:id/modules/:module    (sessão + origem permitida)
//         body { enabled: boolean } (estrito) → { storeId, module, enabled, changed }
//
// Ausência de linha = ligado. PATCH idempotente: só grava (estado + evento de
// auditoria, mesma transação) quando o estado muda. Invalida o cache da home
// da loja. Desligar SÓ esconde menu/pendência da home — nenhuma rota, fila ou
// tabela é bloqueada (Tracker/TrustShield em especial).
//
// Arquivo próprio, caminhos completos: `stores.routes.ts` (Épico 17/20) não muda.
// Erros: { code, message, details?, error } pelo pacote da 18.1 — catálogo
// `plataforma` (lib/plataforma-errors.ts) + comum; handler encapsulado
// (`installErrorHandler`). Falha de banco → 503 `service_unavailable` (comum).
// Tabela ainda não criada (deploy antes da 0096) → GET responde "tudo ligado".
import { COMMON_CATALOG } from '@blackshop/errors';
import { installErrorHandler, sendError } from '@blackshop/errors/fastify';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { originAllowed } from '../lib/origin-guard.js';
import { PLATAFORMA_ERRORS } from '../lib/plataforma-errors.js';
import {
  OWNER_ACTOR,
  getModuleStates,
  invalidateModuleCaches,
  setModule,
  validateModuleToggle,
  type RedisDelLike,
  type TxDb,
} from '../lib/store-modules.repo.js';

import '../types.js';

export interface StoreModulesRoutesOptions {
  /** Banco (padrão: fastify.db; testes injetam um banco que falha). */
  db?: TxDb;
}

interface ModuleParams {
  id: string;
  module: string;
}

/** Corpo do PATCH: exatamente `{ enabled: boolean }` (sem coerção, sem campo extra — C5). */
export function parseToggleBody(body: unknown): { enabled: boolean } | { reason: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { reason: 'body_must_be_object' };
  const keys = Object.keys(body);
  const extra = keys.filter((k) => k !== 'enabled');
  if (extra.length > 0) return { reason: 'unexpected_fields' };
  const enabled = (body as { enabled?: unknown }).enabled;
  if (enabled === undefined) return { reason: 'enabled_required' };
  if (typeof enabled !== 'boolean') return { reason: 'enabled_must_be_boolean' };
  return { enabled };
}

const storeModulesRoutes: FastifyPluginAsync<StoreModulesRoutesOptions> = async (fastify, opts) => {
  const db = (): TxDb => opts.db ?? (fastify.db as unknown as TxDb);
  const redis = (app: FastifyInstance): RedisDelLike | null =>
    (app.hasDecorator('redis') ? app.redis : null) as unknown as RedisDelLike | null;

  const requireSession = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.session?.authenticated) await sendError(reply, COMMON_CATALOG, 'unauthorized');
  };
  const requireOrigin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!originAllowed(fastify.config, request.headers.origin)) await sendError(reply, COMMON_CATALOG, 'cross_site_rejected');
  };

  // Escopo encapsulado (padrão 18.1): JSON malformado/413/415/404/429 com códigos próprios do comum.
  installErrorHandler(fastify, { catalogs: [PLATAFORMA_ERRORS], logMessage: 'store modules request failed' });

  /** Falha de banco: loga o erro real e responde 503 sem detalhes do driver. */
  function unavailable(request: FastifyRequest, reply: FastifyReply, err: unknown): FastifyReply {
    request.log.error({ err, storeId: (request.params as { id?: string })?.id }, 'store modules request failed');
    return sendError(reply, COMMON_CATALOG, 'service_unavailable');
  }

  fastify.get<{ Params: Pick<ModuleParams, 'id'> }>(
    '/stores/:id/modules',
    { preHandler: requireSession },
    async (request, reply) => {
      const { id } = request.params;
      let modules;
      try {
        modules = await getModuleStates(db(), id, request.log);
      } catch (err) {
        return unavailable(request, reply, err);
      }
      if (!modules) return sendError(reply, PLATAFORMA_ERRORS, 'plataforma.store_not_found', { storeId: id });
      return reply.code(200).send({ storeId: id, modules });
    },
  );

  fastify.patch<{ Params: ModuleParams }>(
    '/stores/:id/modules/:module',
    { preHandler: [requireSession, requireOrigin] },
    async (request, reply) => {
      const { id, module } = request.params;
      const parsed = parseToggleBody(request.body);
      if ('reason' in parsed) return sendError(reply, COMMON_CATALOG, 'validation_failed', { reason: parsed.reason });
      const invalid = validateModuleToggle(module);
      if (invalid) return sendError(reply, PLATAFORMA_ERRORS, invalid, { module });

      let result;
      try {
        result = await setModule(db(), { storeId: id, module, enabled: parsed.enabled, actor: OWNER_ACTOR });
      } catch (err) {
        return unavailable(request, reply, err);
      }
      if (result.status === 'store_not_found')
        return sendError(reply, PLATAFORMA_ERRORS, 'plataforma.store_not_found', { storeId: id });

      if (result.changed) {
        request.log.info(
          { storeId: id, module, from: result.from, to: result.to, actor: OWNER_ACTOR },
          'store module toggled (só esconde no painel; rotas e filas seguem iguais)',
        );
        await invalidateModuleCaches(redis(fastify), id, (err) =>
          request.log.warn({ err, storeId: id }, 'home cache invalidation failed (TTL curto cobre)'),
        );
      }
      return reply.code(200).send({ storeId: id, module, enabled: result.to, changed: result.changed });
    },
  );
};

export default storeModulesRoutes;
