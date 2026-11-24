// Session-based authentication plugin.
//
// Story 22.1a-2 · o plugin agora só DECORA: `authenticate` (contrato idêntico ao de antes — checa
// `request.session.authenticated`), `requireOwner` (D13: relê o usuário no banco a cada chamada),
// `authRepo` e `authMailer`. As rotas de conta vivem em routes/auth.routes.ts e
// routes/admin-users.routes.ts. A senha única antiga (APP_PASSWORD_HASH) virou acesso de
// emergência com prazo (lib/auth/legacy.ts).
import { VaultService } from '@blackshop/vault';
import type { Database } from '@blackshop/db';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

import { legacyLoginState, reportLegacyLoginState } from '../lib/auth/legacy.js';
import { createMockAuthMailer, createResendAuthMailer, loadAuthResendKey, type AuthMailer } from '../lib/auth/mailer.js';
import { createDrizzleAuthRepo, type AuthRepo, type AuthUser } from '../lib/auth/users.repo.js';

import '../types.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Preenchido por `requireOwner` (usuário relido do banco). */
    authUser: AuthUser | null;
  }
}

export interface AuthPluginOptions {
  repo?: AuthRepo;
  mailer?: AuthMailer;
}

/** Repositório Drizzle resolvido na hora do uso (o `db` pode ser decorado depois do plugin, ex.: harness). */
function lazyDrizzleRepo(getDb: () => Database): AuthRepo {
  let cachedDb: Database | null = null;
  let cached: AuthRepo | null = null;
  return new Proxy({} as AuthRepo, {
    get(_target, prop: string | symbol) {
      const db = getDb();
      if (!cached || db !== cachedDb) {
        cached = createDrizzleAuthRepo(db);
        cachedDb = db;
      }
      return (cached as unknown as Record<string | symbol, unknown>)[prop];
    },
  });
}

/** Owner que pode usar as rotas de usuários: ativo; na emergência, também o owner ainda sem senha. */
export function ownerCanAdminister(user: AuthUser | null, via: 'password' | 'legacy' | undefined): user is AuthUser {
  if (!user || user.role !== 'owner') return false;
  if (user.status === 'active') return true;
  return via === 'legacy' && user.status === 'approved_pending_password';
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, opts) => {
  const config = fastify.config;

  const repo = opts.repo ?? lazyDrizzleRepo(() => fastify.db);
  const mailer =
    opts.mailer ??
    (config.nodeEnv === 'test'
      ? createMockAuthMailer({ nodeEnv: 'test', backofficeUrl: config.backofficeUrl || undefined })
      : createResendAuthMailer({
          nodeEnv: config.nodeEnv,
          from: config.authEmailFrom,
          backofficeUrl: config.backofficeUrl,
          loadApiKey: () => loadAuthResendKey(new VaultService(fastify.db, config.vaultSecret)),
        }));

  fastify.decorate('authRepo', repo);
  fastify.decorate('authMailer', mailer);
  fastify.decorateRequest('authUser', null);

  fastify.decorate(
    'authenticate',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!request.session.authenticated) {
        await reply.code(401).send({ error: 'Unauthorized', statusCode: 401 });
        return;
      }
      // QA 22.1a-2 · a sessão de emergência morre com a emergência em TODAS as rotas autenticadas,
      // não só em /auth/me (o rolling de 24 h a manteria viva nas chamadas diretas à API).
      if (request.session.via === 'legacy' && !legacyLoginState(config, new Date()).enabled) {
        await request.session.destroy();
        await reply.code(401).send({ error: 'Unauthorized', statusCode: 401 });
      }
    }
  );

  fastify.decorate(
    'requireOwner',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!request.session.authenticated) {
        await reply.code(401).send({ error: 'Unauthorized', statusCode: 401 });
        return;
      }
      const userId = request.session.userId;
      const user = userId ? await repo.findUserById(userId) : null;
      const via = request.session.via;
      const legacyExpired = via === 'legacy' && !legacyLoginState(config, new Date()).enabled;
      if (legacyExpired || !ownerCanAdminister(user, via)) {
        await reply.code(403).send({ code: 'forbidden' });
        return;
      }
      request.authUser = user;
    }
  );

  if (config.nodeEnv !== 'test') {
    reportLegacyLoginState(config, fastify.log);
    if (!config.authEmailFrom) {
      const level = config.nodeEnv === 'production' ? 'error' : 'warn';
      fastify.log[level](
        'AUTH_EMAIL_FROM ausente: nenhum e-mail de acesso (convite, redefinição de senha, aviso de nova solicitação) será enviado — ' +
          'as ações respondem mail: "not_configured". Defina AUTH_EMAIL_FROM com um remetente de domínio verificado no Resend ' +
          '(ex.: "BlackShop <acesso@authenlondon.com>").',
      );
    }
  }
};

export default fp(authPlugin, { name: 'auth-plugin' });
