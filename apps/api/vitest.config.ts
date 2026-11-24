import { availableParallelism, freemem } from 'node:os';

import { defineConfig } from 'vitest/config';

// Story CI-2 — teto de workers (CPU e memória). Sem este arquivo o vitest 1.6 sobe
// `availableParallelism() - 1` threads: 15 na máquina de 16 CPUs, pico de 6,8–7,0 GB e OOM (exit 137)
// quando outra suíte roda junto. Medido: 8 threads = mesma duração (88 s) com 4,4 GB (~550 MB cada);
// reservamos ~1 GB de memória livre por worker. Globs, `testTimeout` (5 s) e `hookTimeout` (10 s)
// continuam os padrões do vitest. A CI segue com `--no-file-parallelism` (1 worker).
const MAX_WORKERS = 8;
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
