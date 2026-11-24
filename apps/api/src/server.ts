// Fastify server factory. Importing this module has no side effects so tests can
// build isolated instances via buildServer(overrides).
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySession from '@fastify/session';
import { observabilityPlugin } from '@blackshop/observability/fastify';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';

import { loadConfig, type AppConfig } from './config.js';
import { clientIpKeyGenerator, reportMissingProxySecret } from './lib/client-ip.js';
import { corsEffectiveMethod, isStorefrontPublicCorsPath, storeOriginAllowed } from './lib/store-cors.js';
import { createStoreHostResolver, isStoreHostResolutionEnabled } from './lib/store-host-resolver.js';
import { createDrizzleSessionStore, type SessionStoreLike } from './lib/auth/session-store.js';
import type { AuthMailer } from './lib/auth/mailer.js';
import type { AuthRepo } from './lib/auth/users.repo.js';
import authPlugin from './plugins/auth.plugin.js';
// NOTE (2026-09-15): removido import cors-allowlist.plugin.js — arquivo nunca
// foi commitado no main mas server.ts fazia referência, causando crash em
// runtime (Cannot find module). Restaurado CORS estático via env vars.
import dbPlugin from './plugins/db.plugin.js';
import queuePlugin from './plugins/queue.plugin.js';
import redisPlugin from './plugins/redis.plugin.js';
import storePlugin from './plugins/store.plugin.js';
// NOTE (2026-09-15): removido import admin-cache.routes.js — arquivo nunca
// foi commitado no main. Endpoint de invalidação de cache CORS não existe
// mais (sem story — redesign incompleto, ver MAPA-DO-SISTEMA; antes citada como "14.3").
import authRoutes, { type AuthRoutesOptions } from './routes/auth.routes.js';
import healthRoute from './routes/health.route.js';
import landinglabQueuesRoutes from './routes/landinglab-queues.routes.js';
import landingDomainsRoutes from './routes/landing-domains.routes.js';
import storesRoutes from './routes/stores.routes.js';
import storeModulesRoutes from './routes/store-modules.routes.js';

// Side-effect import: registers Fastify type augmentations.
import './types.js';

export interface BuildServerOptions {
  config?: Partial<AppConfig>;
  fastifyOptions?: FastifyServerOptions;
  registerDb?: boolean;
  registerRedis?: boolean;
  registerQueue?: boolean;
  /**
   * Story 22.1a-2 · contas. Padrão: repositório Drizzle + loja de sessão `auth_sessions` (com DB
   * registrado) e mailer Resend (mock só com NODE_ENV=test). Os testes injetam memória/PGlite.
   */
  auth?: {
    repo?: AuthRepo;
    mailer?: AuthMailer;
    sessionStore?: SessionStoreLike;
  } & AuthRoutesOptions;
}

const SESSION_COOKIE_MAX_AGE_MS = 86_400 * 1000; // 24h

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const baseConfig = loadConfig();
  const config: AppConfig = { ...baseConfig, ...options.config };

  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
    disableRequestLogging: config.nodeEnv === 'test',
    // Railway terminates TLS upstream; trust X-Forwarded-* so req.protocol
    // is correctly 'https' and the session cookie is marked Secure.
    // QA 15.4 SEC-001: só N hops (TRUST_PROXY_HOPS, padrão 1 em produção) —
    // `true` deixava o cliente escolher o IP pelo X-Forwarded-For.
    trustProxy: config.trustProxy,
    ...options.fastifyOptions,
  });

  app.decorate('config', config);

  // Story 18.4 · correlation id, logs sanitizados e métricas — só em rotas NÃO protegidas
  // (PROTECTED_ROUTE_PREFIXES); registrado antes de tudo para os hooks valerem para todas as rotas.
  await app.register(observabilityPlugin);

  // Plugin registration order: db → cors → cookie → session → rate-limit → redis → queue → auth → routes.
  if (options.registerDb !== false) {
    await app.register(dbPlugin);
  }

  // CORS via env vars.
  // Consumers permitidos:
  //   - config.corsOrigin — static allowlist (backoffice/AuthenLondon)
  //   - STOREFRONT_ORIGIN env — static allowlist
  //   - LANDING_DOMAIN_SUFFIXES env — suffix wildcard match (ex:
  //     ".cubipiccanti.online" permite qualquer subdomain, incluindo landings
  //     clonadas em subdomains dinâmicos como bepurex-it.cubipiccanti.online).
  //   - Dev localhost:3000-3013
  const allowedOrigins = new Set<string>();
  for (const o of config.corsOrigin.split(',')) {
    const trimmed = o.trim();
    if (trimmed) allowedOrigins.add(trimmed);
  }
  if (process.env['STOREFRONT_ORIGIN']) {
    for (const o of process.env['STOREFRONT_ORIGIN'].split(',')) {
      const trimmed = o.trim();
      if (trimmed) allowedOrigins.add(trimmed);
    }
  }
  if (config.nodeEnv !== 'production') {
    for (let port = 3000; port <= 3013; port++) {
      allowedOrigins.add(`http://localhost:${port}`);
    }
  }

  // Suffix allowlist for dynamic landing subdomains (multi-tenant).
  // Ex: LANDING_DOMAIN_SUFFIXES=".cubipiccanti.online,.landinglab.app"
  const landingDomainSuffixes: string[] = [];
  if (process.env['LANDING_DOMAIN_SUFFIXES']) {
    for (const s of process.env['LANDING_DOMAIN_SUFFIXES'].split(',')) {
      const trimmed = s.trim();
      // normalize to leading dot ("cubipiccanti.online" → ".cubipiccanti.online")
      if (trimmed) landingDomainSuffixes.push(trimmed.startsWith('.') ? trimmed : `.${trimmed}`);
    }
  }
  // Default: cubipiccanti.online (owned by BlackShop, safe to wildcard)
  if (landingDomainSuffixes.length === 0) {
    landingDomainSuffixes.push('.cubipiccanti.online', '.landinglab.app');
  }

  function originAllowed(origin: string): boolean {
    if (allowedOrigins.has(origin)) return true;
    try {
      const host = new URL(origin).hostname.toLowerCase();
      for (const suffix of landingDomainSuffixes) {
        // Aceita host exato (sem subdomain) ou qualquer subdomain do sufixo.
        // Ex: suffix=".cubipiccanti.online" → aceita "cubipiccanti.online" e
        // "bepurex-it.cubipiccanti.online" mas NÃO "malicious-cubipiccanti.online".
        if (host === suffix.slice(1) || host.endsWith(suffix)) return true;
      }
    } catch {
      // Invalid origin URL — reject
    }
    return false;
  }

  const corsBase = {
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Cookie',
      'X-Store-Id',
      'x-store-id',
      'X-Requested-With',
    ],
  };
  const rejectCors = (origin: string): void => {
    app.log.warn({ origin, allowlistSize: allowedOrigins.size, suffixes: landingDomainSuffixes }, 'CORS rejection');
  };

  // Story 23.1a · loja pelo domínio (ADR-004). Um resolvedor por processo (cache 30 s/10 s).
  app.decorate('storeHostResolver', createStoreHostResolver());

  if (isStoreHostResolutionEnabled()) {
    // Decisão 5 · CORS dinâmico por loja: a origem cujo host está em `stores.domain` (loja ativa,
    // ≠ default) vale SÓ para as rotas públicas da vitrine; o painel continua só com a lista estática.
    await app.register(fastifyCors, {
      delegator: (req: FastifyRequest, done: (err: Error | null, options: Record<string, unknown>) => void) => {
        done(null, {
          ...corsBase,
          origin: (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => {
            if (!origin) return cb(null, true);
            if (originAllowed(origin)) return cb(null, true);
            const method = corsEffectiveMethod(req.method, req.headers['access-control-request-method']);
            if (!isStorefrontPublicCorsPath(req.url, method)) {
              rejectCors(origin);
              return cb(null, false);
            }
            storeOriginAllowed(app, origin).then(
              (allowed) => {
                if (!allowed) rejectCors(origin);
                cb(null, allowed);
              },
              (err: unknown) => {
                app.log.error({ err, origin }, 'CORS store origin lookup failed');
                cb(null, false);
              },
            );
          },
        });
      },
    });
  } else {
    await app.register(fastifyCors, {
      origin: (origin, cb) => {
        // No origin header (server-to-server, curl, etc.) → allow.
        if (!origin) return cb(null, true);
        const allowed = originAllowed(origin);
        if (!allowed) rejectCors(origin);
        cb(null, allowed);
      },
      ...corsBase,
    });
  }

  await app.register(fastifyCookie);

  // Story 22.1a-2 · D5 — sessão em `auth_sessions` (sobrevive a deploy, revogável por usuário).
  // Sem DB registrado (testes) e sem loja injetada: loja em memória padrão do @fastify/session.
  const sessionStore =
    options.auth?.sessionStore ?? (options.registerDb !== false ? createDrizzleSessionStore(() => app.db) : undefined);

  await app.register(fastifySession, {
    secret: config.sessionSecret,
    ...(sessionStore ? { store: sessionStore as unknown as NonNullable<Parameters<typeof fastifySession>[1]>['store'] } : {}),
    cookieName: 'blackshop.sid',
    cookie: {
      httpOnly: true,
      // Backoffice talks to the API via a same-origin Next.js rewrite
      // (apps/backoffice/next.config.mjs), so the cookie is set/sent under
      // the backoffice domain — lax is the right balance (works on top-level
      // navigation, blocks third-party POST forms).
      sameSite: 'lax',
      secure: config.cookieSecure,
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
      path: '/',
    },
    saveUninitialized: false,
  });

  await app.register(fastifyRateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindow,
    // IP do cliente assinado pelo storefront (LANDINGLAB_PROXY_SECRET); sem
    // segredo/assinatura válida vale request.ip (trustProxy por hops).
    keyGenerator: clientIpKeyGenerator(config.landinglabProxySecret),
  });
  reportMissingProxySecret(config, app.log);

  // (sem story — redesign incompleto, ver MAPA-DO-SISTEMA; antes citada como "14.3") · dbPlugin registrado ANTES do cors (linhas ~90). Redundância
  // removida daqui.

  if (options.registerRedis !== false) {
    await app.register(redisPlugin);
  }

  if (options.registerQueue !== false) {
    await app.register(queuePlugin);
  }

  await app.register(storePlugin);
  await app.register(authPlugin, { repo: options.auth?.repo, mailer: options.auth?.mailer });
  // Contas: rotas públicas (login, convite, senha) + /auth/me.
  await app.register(authRoutes, { floorMs: options.auth?.floorMs, rateLimits: options.auth?.rateLimits });
  await app.register(healthRoute);
  // Fila do LandingLab: o backoffice enfileira clone/tradução/export/geração por aqui (nunca direto no Redis).
  await app.register(landinglabQueuesRoutes);
  // Sugestão/compra de domínio via Spaceship.
  await app.register(landingDomainsRoutes);
  // Lojas (seletor do topo) e módulos por loja.
  await app.register(storesRoutes, { prefix: '/stores' });
  await app.register(storeModulesRoutes);

  // Global error handler — never expose stack traces to the client.
  app.setErrorHandler((error, request, reply) => {
    // (sem story — redesign incompleto, ver MAPA-DO-SISTEMA; antes citada como "14.3") · Intercepta rejection do @fastify/cors pra retornar 403 (não 500)
    // com body customizado. @fastify/cors por padrão retorna 500 quando cb(null, false),
    // que confunde debug do operador. AC 5 pede formato específico.
    const errorCode = (error as { code?: string }).code;
    if (errorCode === 'FST_ERR_CORS_ORIGIN' || errorCode === 'FST_ERR_CORS_INVALID_ORIGIN') {
      void reply.code(403).send({
        error: 'CORS: origin not allowed',
        origin: request.headers.origin ?? null,
        statusCode: 403,
      });
      return;
    }

    // Story 0.8 · Shopify/Meta não responderam no prazo → 504 com code estável (a mensagem
    // do erro tem só o serviço e o prazo — nunca token, URL ou corpo).
    if (errorCode === 'UPSTREAM_TIMEOUT') {
      request.log.error({ err: error, url: request.url }, 'Upstream timeout');
      void reply.code(504).send({
        code: 'UPSTREAM_TIMEOUT',
        error: 'O serviço externo não respondeu a tempo. Tente novamente em instantes.',
        statusCode: 504,
      });
      return;
    }

    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 500) {
      request.log.error({ err: error, url: request.url }, 'Internal server error');
    } else {
      request.log.warn({ err: error.message, url: request.url, statusCode }, 'Request error');
    }

    const message = statusCode >= 500 ? 'Internal Server Error' : error.message;
    void reply.code(statusCode).send({ error: message, statusCode });
  });

  return app;
}
