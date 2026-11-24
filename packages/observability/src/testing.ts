// Story 18.4 · Utilitários de teste: stream de log em memória (pino real) e registro de métricas.
import { MetricsRegistry } from './metrics.js';

export interface LogCapture {
  /** Passe como `stream` do pino (`pino(opts, capture.stream)` ou `logger: { stream }` do Fastify). */
  stream: { write: (line: string) => void };
  lines: Array<Record<string, unknown>>;
  /** Linhas cruas (para provar que um valor não aparece em lugar nenhum). */
  raw: string[];
  clear(): void;
}

export function createLogCapture(): LogCapture {
  const capture: LogCapture = {
    lines: [],
    raw: [],
    stream: {
      write(line: string) {
        capture.raw.push(line);
        try {
          capture.lines.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          capture.lines.push({ unparsable: line });
        }
      },
    },
    clear() {
      capture.lines.length = 0;
      capture.raw.length = 0;
    },
  };
  return capture;
}

export function createTestMetrics(maxSeries?: number): MetricsRegistry {
  return new MetricsRegistry(maxSeries === undefined ? {} : { maxSeries });
}
