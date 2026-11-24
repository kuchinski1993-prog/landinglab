// Pino logger shared across worker modules. Silenced in tests via LOG_LEVEL=silent.
import { createContextLogger } from '@blackshop/observability';
import pino from 'pino';

import { loadConfig } from './config.js';

const config = loadConfig();

/** Logger raiz (opções inalteradas). Base dos filhos sanitizados de `withCorrelation`. */
export const rootLogger = pino({
  level: config.logLevel,
  base: { service: 'worker' },
});

/**
 * Story 18.4 · dentro de um processor envolvido por `withCorrelation` (filas não protegidas) as
 * linhas saem com `correlationId` e sanitizadas; fora desse contexto (filas protegidas, boot,
 * heartbeat) a saída é idêntica à do `rootLogger`.
 */
export const logger = createContextLogger(rootLogger);

export type Logger = typeof rootLogger;
