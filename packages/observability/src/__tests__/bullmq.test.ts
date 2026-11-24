// AC5–AC8 · Transporte do id na fila (opts.telemetry.metadata) e withCorrelation no worker.
import pino from 'pino';
import { describe, expect, it } from 'vitest';

import {
  correlationIdOfJob,
  correlationJobOptions,
  parseJobCorrelationId,
  WORKER_ID_PREFIX,
  withCorrelation,
} from '../bullmq.js';
import { getCorrelationId, runWithCorrelation } from '../correlation.js';
import { createContextLogger } from '../logger.js';
import { REDACTED } from '../sanitize.js';
import { createLogCapture } from '../testing.js';

describe('correlationJobOptions', () => {
  it('fila comum dentro de uma requisição → metadata cid:<id>, opts originais preservadas', () => {
    const opts = { jobId: 'relink:1:2', attempts: 3 };
    const out = runWithCorrelation({ correlationId: 'ABCDEFGH-1' }, () => correlationJobOptions('relink-colors-queue', opts));
    expect(out).toEqual({ jobId: 'relink:1:2', attempts: 3, telemetry: { metadata: 'cid:ABCDEFGH-1' } });
    expect(opts).toEqual({ jobId: 'relink:1:2', attempts: 3 });
  });

  it('sem opts → só o metadata', () => {
    expect(correlationJobOptions('publish-queue', undefined, { correlationId: 'ABCDEFGH-1' })).toEqual({
      telemetry: { metadata: 'cid:ABCDEFGH-1' },
    });
  });

  it.each(['email-queue', 'inbound-classify-queue', 'tracker-capi-queue'])('%s (protegida) → mesma referência', (queue) => {
    const opts = { jobId: 'x' };
    const out = runWithCorrelation({ correlationId: 'ABCDEFGH-1' }, () => correlationJobOptions(queue, opts));
    expect(out).toBe(opts);
    expect(runWithCorrelation({ correlationId: 'ABCDEFGH-1' }, () => correlationJobOptions(queue, undefined))).toBeUndefined();
  });

  it('sem contexto (boot/cron) → mesma referência', () => {
    const opts = { jobId: 'x' };
    expect(correlationJobOptions('publish-queue', opts)).toBe(opts);
  });

  it('telemetry definido pelo chamador não é sobrescrito', () => {
    const opts = { telemetry: { metadata: 'outro' } };
    expect(correlationJobOptions('publish-queue', opts, { correlationId: 'ABCDEFGH-1' })).toBe(opts);
  });
});

describe('parseJobCorrelationId (AC6)', () => {
  it.each([
    [{ opts: { telemetry: { metadata: 'cid:ABCDEFGH-1' } } }, 'ABCDEFGH-1'],
    [{ opts: { telemetry: { metadata: 'cid:bad id' } } }, null],
    [{ opts: { telemetry: { metadata: 'qualquer coisa' } } }, null],
    [{ opts: { telemetry: { metadata: 123 } } }, null],
    [{ opts: {} }, null],
    [{}, null],
    [null, null],
  ])('%j → %s', (job, expected) => {
    expect(parseJobCorrelationId(job as never)).toBe(expected);
  });
});

describe('withCorrelation', () => {
  it('fila protegida → o MESMO processor (sem wrapper)', () => {
    const processor = async () => 'ok';
    for (const queue of ['email-queue', 'inbound-classify-queue', 'tracker-capi-queue']) {
      expect(withCorrelation(processor, { queue })).toBe(processor);
    }
  });

  it('AC5: job com metadata → processor roda no contexto e loga com correlationId', async () => {
    const capture = createLogCapture();
    const root = pino({ base: { service: 'worker' } }, capture.stream);
    const logger = createContextLogger(root);
    const job = { id: '7', name: 'RelinkColorsJob', data: { productId: 'p1' }, opts: { telemetry: { metadata: 'cid:ABCDEFGH-1' } } };
    const wrapped = withCorrelation(
      async (j: typeof job, token?: string) => {
        logger.info({ token: 'S3CR3T', productId: j.data.productId }, 'processing');
        return { id: getCorrelationId(), token };
      },
      { queue: 'relink-colors-queue', logger: root },
    );
    const result = await wrapped(job, 'lock-token');
    expect(result).toEqual({ id: 'ABCDEFGH-1', token: 'lock-token' });
    expect(capture.lines[0]).toMatchObject({ service: 'worker', correlationId: 'ABCDEFGH-1', token: REDACTED, productId: 'p1' });
    expect(correlationIdOfJob(job)).toBe('ABCDEFGH-1');
    expect(job.data).toEqual({ productId: 'p1' });
  });

  it('AC6: job sem metadata (ou malformado) roda normalmente com wk-<uuid>', async () => {
    const jobs = [{ id: '1' }, { id: '2', opts: { telemetry: { metadata: 'lixo' } } }];
    for (const job of jobs) {
      const wrapped = withCorrelation(async () => getCorrelationId(), { queue: 'publish-queue' });
      const id = await wrapped(job);
      expect(id).toMatch(new RegExp(`^${WORKER_ID_PREFIX}[0-9a-f-]{36}$`));
      expect(correlationIdOfJob(job)).toBe(id);
    }
  });

  it('erro do processor propaga sem alteração', async () => {
    const boom = new Error('x');
    const wrapped = withCorrelation(async () => {
      throw boom;
    }, { queue: 'publish-queue' });
    await expect(wrapped({ id: '1' })).rejects.toBe(boom);
  });

  it('correlationIdOfJob sem job', () => {
    expect(correlationIdOfJob(undefined)).toBeNull();
    expect(correlationIdOfJob({ opts: { telemetry: { metadata: 'cid:ABCDEFGH-3' } } })).toBe('ABCDEFGH-3');
  });
});
