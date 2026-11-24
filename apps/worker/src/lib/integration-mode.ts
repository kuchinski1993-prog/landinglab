// Story 0.4 · modo das integrações no worker. Jobs que escreveriam na Shopify falham de
// forma determinística (sem retry inútil) quando o SHOPIFY_MODE não está configurado em
// produção; o boot loga o alerta e o heartbeat publica os modos para o /health da API.
import {
  buildModeAlertLines,
  describeIntegrationModes,
  isIntegrationModeError,
  resolveIntegrationMode,
  type IntegrationModeError,
  type IntegrationModeErrorCode,
  type RuntimeEnv,
} from '@blackshop/shared/runtime-mode';
import { UnrecoverableError } from 'bullmq';

import { logger } from '../logger.js';

export const SHOPIFY_MODE_NOT_CONFIGURED = 'SHOPIFY_MODE_NOT_CONFIGURED';
/** Mesma chave lida pelo GET /health da API. */
export const WORKER_MODES_KEY = 'worker:modes';

/**
 * Erro determinístico: o BullMQ move o job direto para `failed` (sem gastar tentativas),
 * já que repetir não muda a configuração. A mensagem começa pelo código estável.
 */
export class ShopifyModeNotConfiguredError extends UnrecoverableError {
  readonly code = SHOPIFY_MODE_NOT_CONFIGURED;
  readonly resolverCode: IntegrationModeErrorCode;
  readonly variable: string;

  constructor(cause: IntegrationModeError) {
    super(`${SHOPIFY_MODE_NOT_CONFIGURED}: ${cause.message}`);
    // O BullMQ também reconhece pelo nome; mantemos o nome da classe base.
    this.name = 'UnrecoverableError';
    this.resolverCode = cause.code;
    this.variable = cause.variable;
  }
}

/** Resolve o modo Shopify para um job; erro de modo vira `ShopifyModeNotConfiguredError`. */
export function resolveShopifyModeForJob(env: RuntimeEnv = process.env): 'real' | 'mock' {
  try {
    return resolveIntegrationMode('shopify', env).mode;
  } catch (err) {
    if (isIntegrationModeError(err)) throw new ShopifyModeNotConfiguredError(err);
    throw err;
  }
}

/** JSON publicado em `worker:modes` (sem segredos — só modo, origem e nome de variável). */
export function workerModesPayload(env: RuntimeEnv = process.env): string {
  const snap = describeIntegrationModes(env);
  return JSON.stringify({
    shopify: snap.shopify,
    metaCapi: snap.metaCapi,
    productionMock: snap.productionMock,
    productionModeError: snap.productionModeError,
  });
}

/** AC9 · uma linha por subsistema no boot do worker. */
export function logWorkerIntegrationModes(env: RuntimeEnv = process.env): void {
  for (const line of buildModeAlertLines('worker', env)) {
    const { level, message, ...fields } = line;
    logger[level](fields, message);
  }
}
