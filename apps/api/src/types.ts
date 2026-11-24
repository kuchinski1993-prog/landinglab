// Fastify decorators / module augmentation for typed plugins.
import type { Database } from '@blackshop/db';
import type { Queue, JobsOptions } from 'bullmq';
import type { preHandlerHookHandler } from 'fastify';
import type { Redis } from 'ioredis';
import type { Sql } from 'postgres';

import type { AppConfig } from './config.js';
import type { AuthMailer } from './lib/auth/mailer.js';
import type { AuthRepo } from './lib/auth/users.repo.js';

export type QueueName =
  | 'vsl-video-reconcile'
  | 'vsl-import'
  | 'import-queue'
  | 'import-group-queue'
  | 'image-queue'
  | 'publish-queue'
  | 'factory-queue'
  | 'email-queue'
  | 'inbound-classify-queue'
  // Fase 2 Bloco 3.1 — sync automático de preço multi-moeda.
  | 'price-sync-queue'
  | 'refresh-fx-queue'
  // Jul/2026 — backfill de ligação variante↔imagem (relink-colors.processor).
  | 'relink-colors-queue'
  // Jul/2026 — corrige mirror_variant_id embaralhado (rewire-mirror.processor).
  | 'rewire-mirror-queue'
  // Jul/2026 — corrige variante ↔ imagem no Shopify (rewire-variant-media.processor).
  | 'rewire-variant-media-queue'
  // Set/2026 — Tracker.06 · envio server-side de conversões pra Meta CAPI.
  | 'tracker-capi-queue'
  // Story 18.8 — envio de eventos do Marketing à Meta (marketing-capi.processor, job durável).
  | 'marketing-capi-queue'
  // Story 24.4 — envio dos catálogos Meta pela Catalog API (meta-catalog-push.processor, job durável).
  | 'meta-catalog-push-queue';

export interface QueueProducer {
  /**
   * Enfileira um job. `queueName` escolhe a fila BullMQ; `jobName` é o nome
   * do job (lido por dispatchers como `factoryDispatcher` via `job.name`).
   * Antes esta assinatura usava `queueName` como `jobName` por engano,
   * o que quebrava o roteamento da `factory-queue` (que faz switch por
   * job.name).
   */
  enqueue: <T = unknown>(
    queueName: QueueName,
    jobName: string,
    data: T,
    opts?: JobsOptions,
  ) => Promise<string>;
  queues: Record<QueueName, Queue>;
  close: () => Promise<void>;
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: preHandlerHookHandler;
    /** Story 22.1a-2 · relê o usuário no banco: só owner utilizável passa (403 para member). */
    requireOwner: preHandlerHookHandler;
    /** Story 22.1a-2 · repositório de contas (Drizzle em produção; memória nos testes). */
    authRepo: AuthRepo;
    /** Story 22.1a-2 · remetente dos e-mails de acesso (Resend; mock só em NODE_ENV=test). */
    authMailer: AuthMailer;
    db: Database;
    /** Pool postgres-js único das rotas VSL (SQL cru); separado do Drizzle. */
    pg: Sql;
    redis: Redis;
    queue: QueueProducer;
    config: AppConfig;
  }

  interface FastifyRequest {
    storeId: string;
  }

  // @fastify/session merges its data into Fastify.Session — augment that interface.
  interface Session {
    authenticated?: boolean;
    loginAt?: string;
    /** Story 22.1a-2 · usuário da sessão (sempre presente nas sessões novas, inclusive a de emergência). */
    userId?: string;
    role?: 'owner' | 'member';
    /** `password` = e-mail + senha (ou link usado); `legacy` = acesso de emergência (D10). */
    via?: 'password' | 'legacy';
    /** IP/UA truncados (≤ 200) — vão para as colunas de `auth_sessions`. */
    clientIp?: string;
    userAgent?: string;
  }
}
