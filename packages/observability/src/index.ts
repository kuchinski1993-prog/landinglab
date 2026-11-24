// @blackshop/observability (Story 18.4) — correlation id, logs sanitizados e métricas mínimas.
// Subcaminhos: `./fastify` (observabilityPlugin), `./bullmq` (opts da fila e withCorrelation),
// `./testing` (captura de log). Guia: docs/architecture/observabilidade.md.
export * from './correlation.js';
export * from './logger.js';
export * from './metrics.js';
export * from './protected.js';
export * from './sanitize.js';
