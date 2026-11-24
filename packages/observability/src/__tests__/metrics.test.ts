// AC13–AC15, AC17 · Registro de métricas, teto de séries e linha agregada.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMetricsRegistry, MetricsRegistry, OVERFLOW_LABEL, startSnapshotLog, summarizeSnapshot } from '../metrics.js';
import { createTestMetrics } from '../testing.js';

describe('MetricsRegistry', () => {
  it('contadores por label', () => {
    const m = createMetricsRegistry();
    for (let i = 0; i < 3; i++) m.inc('errors_total', { code: 'plataforma.job_not_found' });
    m.inc('errors_total', { code: 'validation_failed' });
    expect(m.counter('errors_total', { code: 'plataforma.job_not_found' })).toBe(3);
    expect(m.counter('errors_total', { code: 'validation_failed' })).toBe(1);
    expect(m.counter('errors_total', { code: 'outro' })).toBe(0);
    expect(m.snapshot().counters['errors_total']).toHaveLength(2);
  });

  it('ordem dos labels não cria série nova; valores longos são cortados', () => {
    const m = new MetricsRegistry();
    m.inc('x', { a: '1', b: '2' });
    m.inc('x', { b: '2', a: '1' });
    m.inc('x', { a: 'z'.repeat(100), b: null });
    const samples = m.snapshot().counters['x']!;
    expect(samples[0]!.value).toBe(2);
    expect(samples[1]!.labels['a']).toHaveLength(64);
    expect(samples[1]!.labels['b']).toBe('');
  });

  it('histograma: count, sum, max, buckets', () => {
    const m = new MetricsRegistry({ bucketsMs: [10, 100] });
    m.observe('d', { route: '/jobs/:id' }, 5);
    m.observe('d', { route: '/jobs/:id' }, 50);
    m.observe('d', { route: '/jobs/:id' }, 500);
    m.observe('d', { route: '/jobs/:id' }, Number.NaN);
    const [s] = m.snapshot().histograms['d']!;
    expect(s).toEqual({ labels: { route: '/jobs/:id' }, count: 3, sum: 555, max: 500, buckets: { '<=10': 1, '<=100': 1, '+Inf': 1 } });
  });

  it('AC15: 1000 valores distintos → ≤ 500 séries + __overflow__', () => {
    const m = createTestMetrics();
    for (let i = 0; i < 1000; i++) m.inc('errors_total', { code: `c${i}` });
    for (let i = 0; i < 1000; i++) m.observe('lat', { route: `/r${i}` }, 1);
    const snap = m.snapshot();
    expect(snap.series).toBe(500);
    expect(snap.counters['errors_total']).toHaveLength(501);
    const overflow = snap.counters['errors_total']!.find((s) => s.labels[OVERFLOW_LABEL] === 'true');
    expect(overflow?.value).toBe(500);
    expect(snap.histograms['lat']).toHaveLength(1);
    expect(snap.histograms['lat']![0]!.labels).toEqual({ [OVERFLOW_LABEL]: 'true' });
    expect(snap.overflowed).toBe(1500);
  });

  it('teto configurável e reset', () => {
    const m = createTestMetrics(2);
    m.inc('a', { x: 1 });
    m.inc('a', { x: 2 });
    m.inc('a', { x: 3 });
    expect(m.snapshot().series).toBe(2);
    m.reset();
    expect(m.snapshot()).toEqual({ counters: {}, gauges: {}, histograms: {}, series: 0, maxSeries: 2, overflowed: 0 });
  });

  it('gauge guarda o último valor (jobs_by_state)', () => {
    const m = new MetricsRegistry();
    m.set('jobs_by_state', { queue: 'publish-queue', state: 'waiting' }, 4);
    m.set('jobs_by_state', { queue: 'publish-queue', state: 'waiting' }, 2);
    m.set('jobs_by_state', { queue: 'publish-queue', state: 'failed' }, Number.NaN);
    expect(m.snapshot().gauges['jobs_by_state']).toEqual([{ labels: { queue: 'publish-queue', state: 'waiting' }, value: 2 }]);
  });

  it('summarizeSnapshot sem buckets', () => {
    const m = new MetricsRegistry();
    m.observe('d', {}, 10);
    m.observe('d', {}, 20);
    m.inc('c');
    expect(summarizeSnapshot(m.snapshot())).toEqual({
      counters: { c: [{ labels: {}, value: 1 }] },
      gauges: {},
      histograms: { d: [{ labels: {}, count: 2, avg: 15, max: 20 }] },
      series: 2,
      overflowed: 0,
    });
  });
});

describe('startSnapshotLog (AC17)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emite metrics_snapshot a cada intervalo e para no stop()', () => {
    vi.useFakeTimers();
    const m = new MetricsRegistry();
    m.inc('errors_total', { code: 'x' });
    const info = vi.fn();
    const handle = startSnapshotLog(m, { info }, { extra: () => ({ service: 'api' }) });
    vi.advanceTimersByTime(59_999);
    expect(info).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![1]).toBe('metrics_snapshot');
    expect(info.mock.calls[0]![0]).toMatchObject({ service: 'api', metrics: { series: 1 } });
    handle.stop();
    vi.advanceTimersByTime(600_000);
    expect(info).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logger que lança não derruba o timer', () => {
    vi.useFakeTimers();
    const info = vi.fn(() => {
      throw new Error('x');
    });
    const handle = startSnapshotLog(new MetricsRegistry(), { info }, { intervalMs: 10 });
    expect(() => vi.advanceTimersByTime(30)).not.toThrow();
    expect(info).toHaveBeenCalledTimes(3);
    handle.stop();
  });
});
