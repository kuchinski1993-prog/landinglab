import { availableParallelism, freemem } from 'node:os';

import { defineConfig } from 'vitest/config';

// Story CI-2 — teto de workers (CPU e memória). Sem este arquivo o vitest 1.6 sobe
// `availableParallelism() - 1` threads: 15 na máquina de 16 CPUs, pico de ~4,9 GB e `worker.test.ts`
// estourando os 5 s (reimporta o grafo do worker a cada caso). Medido: 4 threads = suíte verde e mais
// rápida (23 s contra 35–47 s), 2,1 GB, "creates exactly one Redis connection" em 2,3 s.
// Globs, `testTimeout` (5 s) e `hookTimeout` (10 s) continuam os padrões do vitest.
// A CI segue com `--no-file-parallelism` (1 worker).
const MAX_WORKERS = 4;
const GB_PER_WORKER = 1;
const workers = Math.max(
  1,
  Math.min(MAX_WORKERS, availableParallelism() - 1, Math.floor(freemem() / (GB_PER_WORKER * 2 ** 30))),
);

export default defineConfig({
  test: {
    maxWorkers: workers,
    minWorkers: 1,
  },
});
