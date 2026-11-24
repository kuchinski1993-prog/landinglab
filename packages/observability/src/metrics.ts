// Story 18.4 · Métricas mínimas em memória (D-18.1: sem serviço novo). Contadores e histogramas
// por processo, com teto de séries: o excedente cai na série `__overflow__` da métrica, então a
// memória não cresce sem limite. Labels só de conjuntos fechados (código do catálogo, padrão de
// rota, fila, estado) — nunca e-mail, id de loja/cliente, URL com query ou texto livre.

export const DEFAULT_MAX_SERIES = 500;
export const OVERFLOW_LABEL = '__overflow__';
/** Limites (ms) dos buckets dos histogramas de duração. */
export const DEFAULT_BUCKETS_MS: readonly number[] = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 300_000];
const MAX_LABEL_LENGTH = 64;

export type Labels = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface CounterSample {
  labels: Record<string, string>;
  value: number;
}

export interface HistogramSample {
  labels: Record<string, string>;
  count: number;
  sum: number;
  max: number;
  /** Contagem por bucket (não acumulada): `"<=5"`, `"<=10"`, …, `"+Inf"`. */
  buckets: Record<string, number>;
}

export interface MetricsSnapshot {
  counters: Record<string, CounterSample[]>;
  /** Valor atual (ex.: jobs_by_state{queue,state} a partir do getJobCounts do BullMQ). */
  gauges: Record<string, CounterSample[]>;
  histograms: Record<string, HistogramSample[]>;
  series: number;
  maxSeries: number;
  /** Observações que caíram em `__overflow__` desde o início. */
  overflowed: number;
}

interface CounterSeries {
  labels: Record<string, string>;
  value: number;
}

interface HistogramSeries {
  labels: Record<string, string>;
  count: number;
  sum: number;
  max: number;
  buckets: number[];
}

export interface MetricsRegistryOptions {
  maxSeries?: number;
  bucketsMs?: readonly number[];
}

function normalizeLabels(labels: Labels): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(labels).sort()) {
    const raw = labels[key];
    const value = raw === undefined || raw === null ? '' : String(raw);
    out[key] = value.length > MAX_LABEL_LENGTH ? value.slice(0, MAX_LABEL_LENGTH) : value;
  }
  return out;
}

function seriesKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}

export class MetricsRegistry {
  readonly maxSeries: number;
  private readonly bucketsMs: readonly number[];
  private readonly counters = new Map<string, Map<string, CounterSeries>>();
  private readonly gauges = new Map<string, Map<string, CounterSeries>>();
  private readonly histograms = new Map<string, Map<string, HistogramSeries>>();
  private seriesCount = 0;
  private overflowed = 0;

  constructor(options: MetricsRegistryOptions = {}) {
    this.maxSeries = options.maxSeries ?? DEFAULT_MAX_SERIES;
    this.bucketsMs = options.bucketsMs ?? DEFAULT_BUCKETS_MS;
  }

  /** Série existente, nova (se couber no teto) ou a `__overflow__` da métrica. */
  private slot<S>(store: Map<string, Map<string, S>>, name: string, labels: Labels, create: (l: Record<string, string>) => S): S {
    let metric = store.get(name);
    if (!metric) {
      metric = new Map();
      store.set(name, metric);
    }
    const normalized = normalizeLabels(labels);
    const key = seriesKey(normalized);
    const existing = metric.get(key);
    if (existing) return existing;
    if (this.seriesCount < this.maxSeries) {
      const series = create(normalized);
      metric.set(key, series);
      this.seriesCount += 1;
      return series;
    }
    this.overflowed += 1;
    const overflowKey = `${OVERFLOW_LABEL}=true`;
    let overflow = metric.get(overflowKey);
    if (!overflow) {
      overflow = create({ [OVERFLOW_LABEL]: 'true' });
      metric.set(overflowKey, overflow);
    }
    return overflow;
  }

  inc(name: string, labels: Labels = {}, by = 1): void {
    const series = this.slot(this.counters, name, labels, (l) => ({ labels: l, value: 0 }));
    series.value += by;
  }

  set(name: string, labels: Labels, value: number): void {
    if (!Number.isFinite(value)) return;
    this.slot(this.gauges, name, labels, (l) => ({ labels: l, value: 0 })).value = value;
  }

  observe(name: string, labels: Labels, value: number): void {
    if (!Number.isFinite(value)) return;
    const series = this.slot(this.histograms, name, labels, (l) => ({
      labels: l,
      count: 0,
      sum: 0,
      max: 0,
      buckets: new Array<number>(this.bucketsMs.length + 1).fill(0),
    }));
    series.count += 1;
    series.sum += value;
    if (value > series.max) series.max = value;
    let index = this.bucketsMs.findIndex((limit) => value <= limit);
    if (index === -1) index = this.bucketsMs.length;
    series.buckets[index] = (series.buckets[index] ?? 0) + 1;
  }

  /** Valor atual de um contador (testes e resumo). */
  counter(name: string, labels: Labels = {}): number {
    return this.counters.get(name)?.get(seriesKey(normalizeLabels(labels)))?.value ?? 0;
  }

  snapshot(): MetricsSnapshot {
    const counters: Record<string, CounterSample[]> = {};
    for (const [name, metric] of this.counters) {
      counters[name] = [...metric.values()].map((s) => ({ labels: { ...s.labels }, value: s.value }));
    }
    const gauges: Record<string, CounterSample[]> = {};
    for (const [name, metric] of this.gauges) {
      gauges[name] = [...metric.values()].map((s) => ({ labels: { ...s.labels }, value: s.value }));
    }
    const histograms: Record<string, HistogramSample[]> = {};
    for (const [name, metric] of this.histograms) {
      histograms[name] = [...metric.values()].map((s) => {
        const buckets: Record<string, number> = {};
        this.bucketsMs.forEach((limit, i) => {
          buckets[`<=${limit}`] = s.buckets[i] ?? 0;
        });
        buckets['+Inf'] = s.buckets[this.bucketsMs.length] ?? 0;
        return { labels: { ...s.labels }, count: s.count, sum: Math.round(s.sum * 1000) / 1000, max: s.max, buckets };
      });
    }
    return { counters, gauges, histograms, series: this.seriesCount, maxSeries: this.maxSeries, overflowed: this.overflowed };
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.seriesCount = 0;
    this.overflowed = 0;
  }
}

export function createMetricsRegistry(options?: MetricsRegistryOptions): MetricsRegistry {
  return new MetricsRegistry(options);
}

/** Resumo enxuto para a linha `metrics_snapshot` (sem buckets). */
export function summarizeSnapshot(snapshot: MetricsSnapshot): Record<string, unknown> {
  const histograms: Record<string, unknown[]> = {};
  for (const [name, samples] of Object.entries(snapshot.histograms)) {
    histograms[name] = samples.map((s) => ({
      labels: s.labels,
      count: s.count,
      avg: s.count ? Math.round((s.sum / s.count) * 10) / 10 : 0,
      max: s.max,
    }));
  }
  return { counters: snapshot.counters, gauges: snapshot.gauges, histograms, series: snapshot.series, overflowed: snapshot.overflowed };
}

export interface SnapshotLogger {
  info(obj: Record<string, unknown>, msg: string): void;
}

export interface SnapshotLogHandle {
  stop(): void;
}

export const DEFAULT_SNAPSHOT_INTERVAL_MS = 60_000;

/**
 * A cada `intervalMs` emite `info { metrics, ...extra() } 'metrics_snapshot'`. O timer não segura
 * o processo (`unref`) e `stop()` o limpa (chamar no shutdown).
 */
export function startSnapshotLog(
  registry: MetricsRegistry,
  logger: SnapshotLogger,
  options: { intervalMs?: number; extra?: () => Record<string, unknown> } = {},
): SnapshotLogHandle {
  const timer = setInterval(() => {
    try {
      logger.info({ metrics: summarizeSnapshot(registry.snapshot()), ...(options.extra?.() ?? {}) }, 'metrics_snapshot');
    } catch {
      // Log de métricas nunca derruba o processo.
    }
  }, options.intervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
