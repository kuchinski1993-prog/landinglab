// Story 18.3 · durableProcessor com job simulado (regra de retry do BullMQ 5) + store em memória.
// AC3 (determinístico), AC4 (transitório 2×/3×), AC7 (incerto), AC8 (ledger fora), AC9 (nunca
// lança sem registrar), filas protegidas recusadas.
import { UpstreamTimeoutError } from '@blackshop/shared/http';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { DeterministicJobError, UNCLASSIFIED_CODE, type JobRunState } from '../index.js';
import { createMemoryJobRunStore, type JobRunStore } from '../store.js';
import {
  DurableJobFailure,
  durableProcessor,
  isFinalFailureEvent,
  isProtectedQueue,
  PROTECTED_QUEUES,
  type DurableJob,
} from '../worker.js';

import { runLikeBullMQ, silentLogger } from './helpers.js';

const QUEUE = 'relink-colors-queue';
const KEY = { queue: QUEUE, jobKey: 'job-1' };

/** Store que registra cada estado gravado (para provar "nunca failed no meio"). */
function recordingStore() {
  const store = createMemoryJobRunStore();
  const states: JobRunState[] = [];
  const fail = store.fail.bind(store);
  store.fail = async (lease, input) => {
    states.push(input.state);
    return fail(lease, input);
  };
  const succeed = store.succeed.bind(store);
  store.succeed = async (lease, result) => {
    states.push('succeeded');
    return succeed(lease, result);
  };
  return { store, states };
}

describe('durableProcessor — erro determinístico (AC3)', () => {
  it('1 execução, failed/deterministic, attempts=1, relança UnrecoverableError com o code', async () => {
    const { store, states } = recordingStore();
    const handler = vi.fn(async () => {
      throw new DeterministicJobError('loja.relink_product_not_found', 'produto não existe');
    });
    const run = await runLikeBullMQ(durableProcessor(handler, { queue: QUEUE, store }), {}, { attempts: 3 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(run.outcome).toBe('failed');
    expect(run.error).toBeInstanceOf(UnrecoverableError);
    expect(run.error).toMatchObject({ code: 'loja.relink_product_not_found' });
    expect(states).toEqual(['failed']);
    expect(await store.get(KEY)).toMatchObject({
      state: 'failed',
      errorKind: 'deterministic',
      errorCode: 'loja.relink_product_not_found',
      attempts: 1,
      maxAttempts: 3,
      leaseToken: null,
    });
  });
});

describe('durableProcessor — erro transitório (AC4)', () => {
  it('falha 2× e funciona na 3ª: retrying, retrying, succeeded (attempts=3), nunca failed', async () => {
    const { store, states } = recordingStore();
    let calls = 0;
    const handler = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return { ok: true };
    });
    const run = await runLikeBullMQ(durableProcessor(handler, { queue: QUEUE, store }), {}, { attempts: 3 });
    expect(run.outcome).toBe('completed');
    expect(handler).toHaveBeenCalledTimes(3);
    expect(states).toEqual(['retrying', 'retrying', 'succeeded']);
    expect(await store.get(KEY)).toMatchObject({
      state: 'succeeded',
      attempts: 3,
      errorCode: null,
      lastError: null,
      result: { ok: true },
    });
  });

  it('retrying grava error_code/last_error e mantém o job vivo', async () => {
    const store = createMemoryJobRunStore();
    const processor = durableProcessor(
      async () => {
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      },
      { queue: QUEUE, store },
    );
    const job: DurableJob = { id: 'job-1', name: 'T', data: {}, attemptsMade: 0, opts: { attempts: 3 } };
    const err = await processor(job).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toBe('socket hang up');
    expect(await store.get(KEY)).toMatchObject({
      state: 'retrying',
      errorKind: 'transient',
      errorCode: 'ECONNRESET',
      lastError: 'socket hang up',
      finishedAt: null,
    });
  });

  it('falha 3× (attempts=3): retrying, retrying e failed SÓ na 3ª (transient)', async () => {
    const { store, states } = recordingStore();
    const handler = vi.fn(async () => {
      throw new UpstreamTimeoutError('origem', 25_000, false);
    });
    const run = await runLikeBullMQ(durableProcessor(handler, { queue: QUEUE, store }), {}, { attempts: 3 });
    expect(run.outcome).toBe('failed');
    expect(handler).toHaveBeenCalledTimes(3);
    expect(states).toEqual(['retrying', 'retrying', 'failed']);
    expect(await store.get(KEY)).toMatchObject({ state: 'failed', errorKind: 'transient', errorCode: 'UPSTREAM_TIMEOUT', attempts: 3 });
    // Última tentativa transitória relança o erro original (o BullMQ já não repete).
    expect(run.error).toBeInstanceOf(UpstreamTimeoutError);
  });

  it('erro desconhecido: transitório até a última, com plataforma.job_unclassified', async () => {
    const { store, states } = recordingStore();
    const run = await runLikeBullMQ(
      durableProcessor(
        async () => {
          throw new Error('???');
        },
        { queue: QUEUE, store },
      ),
      {},
      { attempts: 2 },
    );
    expect(run.executions).toBe(2);
    expect(states).toEqual(['retrying', 'failed']);
    expect(await store.get(KEY)).toMatchObject({ errorCode: UNCLASSIFIED_CODE, errorKind: 'transient' });
  });
});

describe('durableProcessor — resultado incerto (AC7)', () => {
  it('UpstreamTimeoutError uncertain → estado uncertain, UnrecoverableError, sem retry', async () => {
    const { store, states } = recordingStore();
    const handler = vi.fn(async () => {
      throw new UpstreamTimeoutError('shopify-admin', 15_000, true);
    });
    const run = await runLikeBullMQ(durableProcessor(handler, { queue: QUEUE, store }), {}, { attempts: 3 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(run.error).toBeInstanceOf(DurableJobFailure);
    expect(run.error).toBeInstanceOf(UnrecoverableError);
    expect(run.error).toMatchObject({ code: 'UPSTREAM_TIMEOUT', errorKind: 'uncertain' });
    expect((run.error as Error & { cause?: unknown }).cause).toBeInstanceOf(UpstreamTimeoutError);
    expect(states).toEqual(['uncertain']);
    expect(await store.get(KEY)).toMatchObject({ state: 'uncertain', errorKind: 'uncertain', errorCode: 'UPSTREAM_TIMEOUT' });
  });

  it('retry do dono com o mesmo jobKey passa pela reconciliação do processor', async () => {
    const store = createMemoryJobRunStore();
    const reconcile = vi.fn(async () => 'achou-na-shopify');
    let first = true;
    const processor = durableProcessor(
      async () => {
        if (first) {
          first = false;
          throw new UpstreamTimeoutError('shopify-admin', 15_000, true);
        }
        return reconcile();
      },
      { queue: QUEUE, store },
    );
    await runLikeBullMQ(processor, {}, { attempts: 3 });
    expect((await store.get(KEY))?.state).toBe('uncertain');
    // Dono reenfileira: nova execução (begin depois de um desfecho recomeça attempts em 1).
    const second = await runLikeBullMQ(processor, {}, { attempts: 3 });
    expect(second.result).toBe('achou-na-shopify');
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(await store.get(KEY)).toMatchObject({ state: 'succeeded', attempts: 1 });
  });
});

function brokenStore(failOn: Array<'begin' | 'succeed' | 'fail'>): JobRunStore {
  const store = createMemoryJobRunStore();
  const boom = async (): Promise<never> => {
    throw new Error('connect ECONNREFUSED 10.0.0.1:5432 senha=SEGREDO');
  };
  for (const op of failOn) (store as unknown as Record<string, unknown>)[op] = boom;
  return store;
}

describe('durableProcessor — ledger indisponível (AC8)', () => {
  it('begin falha: o handler roda, sucesso continua sucesso e o log não vaza payload', async () => {
    const logger = silentLogger();
    const handler = vi.fn(async (job: DurableJob<{ email: string }>) => ({ ok: true, who: job.data.email.length }));
    const processor = durableProcessor(handler, { queue: QUEUE, store: brokenStore(['begin']), logger });
    const run = await runLikeBullMQ(processor, { email: 'cliente@exemplo.com' });
    expect(run).toMatchObject({ outcome: 'completed', result: { ok: true, who: 19 } });
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({ level: 'error', msg: 'job_ledger_write_failed', obj: { queue: QUEUE, jobKey: 'job-1', op: 'begin' } });
    expect(JSON.stringify(logger.entries)).not.toContain('cliente@exemplo.com');
  });

  it('succeed falha: o resultado do handler é devolvido igual', async () => {
    const logger = silentLogger();
    const processor = durableProcessor(async () => 42, { queue: QUEUE, store: brokenStore(['succeed']), logger });
    expect((await runLikeBullMQ(processor, {})).result).toBe(42);
    expect(logger.entries.map((e) => e.obj['op'])).toEqual(['succeed']);
  });

  it('fail falha: a classificação para o BullMQ continua certa', async () => {
    const logger = silentLogger();
    const determ = durableProcessor(
      async () => {
        throw new DeterministicJobError('loja.x', 'não');
      },
      { queue: QUEUE, store: brokenStore(['fail']), logger },
    );
    const run = await runLikeBullMQ(determ, {});
    expect(run.executions).toBe(1);
    expect(run.error).toBeInstanceOf(UnrecoverableError);

    const transient = durableProcessor(
      async () => {
        throw Object.assign(new Error('x'), { code: 'ECONNRESET' });
      },
      { queue: QUEUE, store: brokenStore(['fail']), logger },
    );
    const run2 = await runLikeBullMQ(transient, {}, { attempts: 3 });
    expect(run2.executions).toBe(3);
    expect(run2.error).not.toBeInstanceOf(UnrecoverableError);
    expect(logger.entries.every((e) => e.msg === 'job_ledger_write_failed')).toBe(true);
  });

  it('store como fábrica que lança: o job roda sem ledger', async () => {
    const logger = silentLogger();
    const processor = durableProcessor(async () => 'ok', {
      queue: QUEUE,
      store: () => {
        throw new Error('DATABASE_URL ausente');
      },
      logger,
    });
    expect((await runLikeBullMQ(processor, {})).result).toBe('ok');
    expect(logger.entries[0]?.obj['op']).toBe('begin');
  });
});

describe('durableProcessor — nunca lança sem registrar (AC9)', () => {
  const THROWN: unknown[] = [
    'string',
    undefined,
    null,
    42,
    { semMessage: true },
    new Error(''),
    new UnrecoverableError('u'),
    new UpstreamTimeoutError('s', 1, true),
    new UpstreamTimeoutError('s', 1, false),
    Object.assign(new Error('rede'), { code: 'EAI_AGAIN' }),
    new DeterministicJobError('loja.y', 'y'),
    Symbol('estranho'),
  ];

  it.each(THROWN.map((v, i) => [i, v]))('valor lançado #%s: grava estado e relança um Error', async (_i, value) => {
    const store = createMemoryJobRunStore();
    const processor = durableProcessor(
      async () => {
        throw value;
      },
      { queue: QUEUE, store },
    );
    for (const attemptsMade of [0, 2]) {
      const job: DurableJob = { id: `k-${attemptsMade}`, name: 'T', data: {}, attemptsMade, opts: { attempts: 3 } };
      const err = await processor(job).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      const row = await store.get({ queue: QUEUE, jobKey: `k-${attemptsMade}` });
      expect(['failed', 'retrying', 'uncertain']).toContain(row?.state);
      expect(row?.errorCode).toBeTruthy();
      expect(row?.errorKind).toBeTruthy();
      if (attemptsMade === 2) expect(row?.state).not.toBe('retrying');
    }
  });
});

describe('durableProcessor — opções', () => {
  it('keyOf, resultOf, storeIdOf, heartbeat e attempt no contexto', async () => {
    const store = createMemoryJobRunStore();
    const processor = durableProcessor(
      async (_job: DurableJob<{ productId: string }>, ctx) => {
        expect(ctx.attempt).toBe(1);
        expect(await ctx.heartbeat()).toBe(true);
        return { big: 'x'.repeat(10), status: 'linked' };
      },
      {
        queue: QUEUE,
        store,
        keyOf: (job) => `relink:${job.data.productId}`,
        resultOf: (r) => ({ status: r.status }),
        storeIdOf: () => 'loja-2',
        leaseMs: 5_000,
      },
    );
    await runLikeBullMQ(processor, { productId: 'p1' });
    expect(await store.get({ queue: QUEUE, jobKey: 'relink:p1' })).toMatchObject({
      result: { status: 'linked' },
      storeId: 'loja-2',
      jobName: 'TestJob',
    });
  });

  it('heartbeat com lease perdido devolve false; com ledger fora devolve true (não para o job)', async () => {
    const store = createMemoryJobRunStore();
    const results: boolean[] = [];
    const processor = durableProcessor(
      async (_job, ctx) => {
        // Outro worker assume a mesma chave no meio.
        await store.begin({ ...KEY, leaseMs: 1_000, maxAttempts: 3 });
        results.push(await ctx.heartbeat());
        return 'feito';
      },
      { queue: QUEUE, store, logger: silentLogger() },
    );
    await runLikeBullMQ(processor, {});
    expect(results).toEqual([false]);
    // O succeed do worker antigo é recusado pelo fencing (log job_ledger_lease_lost).
    expect((await store.get(KEY))?.state).toBe('running');

    const broken = createMemoryJobRunStore();
    broken.heartbeat = async () => {
      throw new Error('db fora');
    };
    const logger = silentLogger();
    const p2 = durableProcessor(async (_job, ctx) => ctx.heartbeat(), { queue: QUEUE, store: broken, logger });
    expect((await runLikeBullMQ(p2, {})).result).toBe(true);
    expect(logger.entries[0]?.obj['op']).toBe('heartbeat');
  });

  it('fencing no fail: lease perdido loga job_ledger_lease_lost e não sobrescreve', async () => {
    const store = createMemoryJobRunStore();
    const logger = silentLogger();
    const processor = durableProcessor(
      async () => {
        await store.begin({ ...KEY, leaseMs: 1_000, maxAttempts: 3 });
        throw new DeterministicJobError('loja.z', 'z');
      },
      { queue: QUEUE, store, logger },
    );
    await runLikeBullMQ(processor, {});
    expect(logger.entries).toEqual([expect.objectContaining({ level: 'warn', msg: 'job_ledger_lease_lost' })]);
    expect((await store.get(KEY))?.state).toBe('running');
  });

  it('logger padrão (console) é usado quando nenhum é passado', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const processor = durableProcessor(async () => 1, { queue: QUEUE, store: brokenStore(['begin']) });
    await runLikeBullMQ(processor, {});
    expect(spy).toHaveBeenCalledWith('job_ledger_write_failed', expect.objectContaining({ op: 'begin' }));
    spy.mockRestore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = createMemoryJobRunStore();
    await runLikeBullMQ(
      durableProcessor(
        async () => {
          await store.begin({ ...KEY, leaseMs: 1, maxAttempts: 1 });
          return 1;
        },
        { queue: QUEUE, store },
      ),
      {},
    );
    expect(warn).toHaveBeenCalledWith('job_ledger_lease_lost', expect.objectContaining({ op: 'succeed' }));
    warn.mockRestore();
  });

  it('job sem id usa "unknown" como chave', async () => {
    const store = createMemoryJobRunStore();
    const processor = durableProcessor(async () => 1, { queue: QUEUE, store });
    await processor({ name: 'T', data: {}, attemptsMade: 0 });
    expect(await store.get({ queue: QUEUE, jobKey: 'unknown' })).not.toBeNull();
  });
});

describe('filas protegidas', () => {
  it.each(PROTECTED_QUEUES)('%s recusa o wrapper', (queue) => {
    expect(isProtectedQueue(queue)).toBe(true);
    expect(() => durableProcessor(async () => 1, { queue, store: createMemoryJobRunStore() })).toThrow(/protegida/);
  });

  it('lista exata das protegidas', () => {
    expect([...PROTECTED_QUEUES]).toEqual(['email-queue', 'inbound-classify-queue', 'tracker-capi-queue']);
    expect(isProtectedQueue('publish-queue')).toBe(false);
  });
});

describe('isFinalFailureEvent (regra do job-logger finalStateOnly)', () => {
  it('evento failed: attemptsMade já inclui a tentativa que falhou', () => {
    expect(isFinalFailureEvent({ attemptsMade: 1, opts: { attempts: 3 } }, new Error('x'))).toBe(false);
    expect(isFinalFailureEvent({ attemptsMade: 3, opts: { attempts: 3 } }, new Error('x'))).toBe(true);
    expect(isFinalFailureEvent({ attemptsMade: 1, opts: { attempts: 3 } }, new UnrecoverableError('x'))).toBe(true);
    expect(isFinalFailureEvent({ attemptsMade: 1, opts: { attempts: 3 } }, Object.assign(new Error('x'), { name: 'UnrecoverableError' }))).toBe(true);
    expect(isFinalFailureEvent(undefined, new Error('x'))).toBe(true);
    expect(isFinalFailureEvent({ opts: { attempts: 3 } } as never, new Error('x'))).toBe(true);
  });
});

describe('renovação automática do lease (QA REL-001)', () => {
  it('chama heartbeat periodicamente durante o handler e para ao terminar', async () => {
    const store = createMemoryJobRunStore();
    const beats = vi.fn(store.heartbeat.bind(store));
    store.heartbeat = beats;
    const processor = durableProcessor(async () => new Promise((r) => setTimeout(() => r('ok'), 120)), {
      queue: QUEUE,
      store,
      leaseMs: 40,
    });
    await runLikeBullMQ(processor, {});
    const during = beats.mock.calls.length;
    expect(during).toBeGreaterThanOrEqual(3);
    await new Promise((r) => setTimeout(r, 100));
    expect(beats.mock.calls.length).toBe(during);
  });

  it('para também quando o handler falha', async () => {
    const store = createMemoryJobRunStore();
    const beats = vi.fn(store.heartbeat.bind(store));
    store.heartbeat = beats;
    const processor = durableProcessor(
      async () => {
        await new Promise((r) => setTimeout(r, 60));
        throw new DeterministicJobError('loja.x', 'x');
      },
      { queue: QUEUE, store, leaseMs: 40 },
    );
    await runLikeBullMQ(processor, {});
    const during = beats.mock.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(beats.mock.calls.length).toBe(during);
  });

  it('fencing: outro worker assume → a renovação para e loga job_ledger_lease_lost', async () => {
    const store = createMemoryJobRunStore();
    const beats = vi.fn(store.heartbeat.bind(store));
    store.heartbeat = beats;
    const logger = silentLogger();
    const processor = durableProcessor(
      async () => {
        await store.begin({ ...KEY, leaseMs: 1_000, maxAttempts: 3 });
        await new Promise((r) => setTimeout(r, 150));
        return 'zumbi';
      },
      { queue: QUEUE, store, leaseMs: 40, logger },
    );
    await runLikeBullMQ(processor, {});
    // Primeira renovação recusada (token trocado) → para; não tenta de novo a cada 20 ms.
    expect(beats.mock.calls.length).toBe(1);
    expect(logger.entries.some((e) => e.msg === 'job_ledger_lease_lost' && e.obj['op'] === 'heartbeat')).toBe(true);
    expect((await store.get(KEY))?.state).toBe('running');
  });
});


describe('stop da renovação aguarda a que está em andamento (QA TEST-001)', () => {
  it('succeed só roda depois que o heartbeat em voo termina', async () => {
    const store = createMemoryJobRunStore();
    const order: string[] = [];
    const realHeartbeat = store.heartbeat.bind(store);
    store.heartbeat = async (lease, ms) => {
      order.push('hb:start');
      await new Promise((r) => setTimeout(r, 60));
      order.push('hb:end');
      return realHeartbeat(lease, ms);
    };
    const realSucceed = store.succeed.bind(store);
    store.succeed = async (lease, result) => {
      order.push('succeed');
      return realSucceed(lease, result);
    };
    // Handler termina enquanto a 1ª renovação (disparada em 10 ms) ainda está em voo.
    const processor = durableProcessor(async () => new Promise((r) => setTimeout(() => r('ok'), 25)), {
      queue: QUEUE,
      store,
      leaseMs: 20,
    });
    await runLikeBullMQ(processor, {});
    expect(order).toEqual(['hb:start', 'hb:end', 'succeed']);
  });

  it('fail também espera a renovação em voo', async () => {
    const store = createMemoryJobRunStore();
    const order: string[] = [];
    const realHeartbeat = store.heartbeat.bind(store);
    store.heartbeat = async (lease, ms) => {
      order.push('hb:start');
      await new Promise((r) => setTimeout(r, 60));
      order.push('hb:end');
      return realHeartbeat(lease, ms);
    };
    const realFail = store.fail.bind(store);
    store.fail = async (lease, input) => {
      order.push('fail');
      return realFail(lease, input);
    };
    const processor = durableProcessor(
      async () => {
        await new Promise((r) => setTimeout(r, 25));
        throw new DeterministicJobError('loja.x', 'x');
      },
      { queue: QUEUE, store, leaseMs: 20 },
    );
    await runLikeBullMQ(processor, {});
    expect(order).toEqual(['hb:start', 'hb:end', 'fail']);
  });
});
