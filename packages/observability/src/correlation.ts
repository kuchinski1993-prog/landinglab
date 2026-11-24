// Story 18.4 · Correlation id: formato, validação de id vindo de fora e contexto AsyncLocalStorage.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** Header HTTP (minúsculo, como o Node entrega em `request.headers`). */
export const CORRELATION_HEADER = 'x-correlation-id';

/** Id aceito de fora: 8–64 caracteres de `[A-Za-z0-9._-]` (rejeita espaço, CR/LF, unicode). */
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

/** Prefixo do metadata do job no BullMQ (`opts.telemetry.metadata = "cid:<id>"`). */
export const JOB_METADATA_PREFIX = 'cid:';

export function isValidCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && CORRELATION_ID_PATTERN.test(value);
}

/** Valida um id vindo de fora (header, metadata). Inválido/ausente → null; nunca lança. */
export function parseCorrelationId(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return isValidCorrelationId(candidate) ? candidate : null;
}

export function newCorrelationId(prefix = ''): string {
  return `${prefix}${randomUUID()}`;
}

/** Id de fora se válido; senão um UUID novo. */
export function resolveCorrelationId(value: unknown, prefix = ''): string {
  return parseCorrelationId(value) ?? newCorrelationId(prefix);
}

export interface CorrelationContext {
  correlationId: string;
  /** Logger já ligado ao id (worker: filho sanitizado; API: o `request.log` da rota). */
  logger?: unknown;
}

export const correlationStorage = new AsyncLocalStorage<CorrelationContext>();

export function getCorrelationContext(): CorrelationContext | undefined {
  return correlationStorage.getStore();
}

export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}

export function runWithCorrelation<T>(context: CorrelationContext, fn: () => T): T {
  return correlationStorage.run(context, fn);
}
