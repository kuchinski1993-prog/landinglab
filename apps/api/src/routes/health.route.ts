// Health check route — no auth required. Reads worker heartbeat from Redis.
//
// Story 0.2/0.3: informa se o segredo do webhook Shopify está configurado
// (só o booleano — nunca valor, tamanho ou prefixo).
// Story 0.4: informa o modo das integrações (Shopify, Meta CAPI) da API e do worker
// (chave `worker:modes`). Mock em produção ou modo não configurado → degradado.
// Sem segredo ou integração degradada → `status: 'degraded'`, mas o HTTP continua 200:
// o healthcheck do Railway (`healthcheckPath: /health`) só olha o código HTTP e não pode
// derrubar o deploy por isso. Nenhum valor de segredo no corpo.
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import { WORKER_MODES_KEY, buildHealthIntegrations, type HealthIntegrations } from '../lib/integration-mode.js';
import { isShopifyWebhookSecretConfigured } from '../lib/shopify-webhook-secret.js';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  worker: 'alive' | 'offline';
  integrations: HealthIntegrations['integrations'];
  productionMock: boolean;
  shopifyWebhook: { secretConfigured: boolean };
  timestamp: string;
}

/** Story 21.1 — leitura do Redis usada pelo snapshot (a Saúde da operação passa um Redis com teto de tempo). */
export interface HealthSnapshotDeps {
  redis?: { get: (key: string) => Promise<string | null> };
}

/**
 * Corpo de GET /health. Story 21.1: extraído do handler para ser reusado por
 * GET /admin/health/overview — o contrato público do /health não muda.
 */
export async function readHealthSnapshot(fastify: FastifyInstance, deps: HealthSnapshotDeps = {}): Promise<HealthResponse> {
  const redis = deps.redis ?? fastify.redis;
  let worker: HealthResponse['worker'] = 'offline';
  try {
    const heartbeat = await redis.get('worker:heartbeat');
    if (heartbeat) {
      worker = 'alive';
    }
  } catch (err) {
    fastify.log.warn({ err }, 'Failed to read worker heartbeat from Redis');
  }

  let workerModesRaw: string | null = null;
  try {
    workerModesRaw = await redis.get(WORKER_MODES_KEY);
  } catch (err) {
    fastify.log.warn({ err }, 'Falha ao ler os modos do worker no Redis');
  }
  const modes = buildHealthIntegrations(workerModesRaw);

  let secretConfigured = false;
  try {
    secretConfigured = await isShopifyWebhookSecretConfigured(fastify);
  } catch (err) {
    fastify.log.warn({ err }, 'Falha ao verificar o segredo do webhook Shopify');
  }

  return {
    status: !secretConfigured || modes.degraded ? 'degraded' : 'ok',
    worker,
    integrations: modes.integrations,
    productionMock: modes.productionMock,
    shopifyWebhook: { secretConfigured },
    timestamp: new Date().toISOString(),
  };
}

const healthRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async (): Promise<HealthResponse> => readHealthSnapshot(fastify));
};

export default healthRoute;
