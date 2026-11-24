import { fileURLToPath } from 'node:url';
import { availableParallelism, freemem } from 'node:os';
import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

// Story CI-2 — no máximo 8 workers, 1 por CPU livre e ~0,5 GB de memória livre por worker
// (medido: 15 threads = pico de 2,3–2,5 GB, ~170 MB cada).
const MAX_WORKERS = 8;
const GB_PER_WORKER = 0.5;
const workers = Math.max(
  1,
  Math.min(MAX_WORKERS, availableParallelism() - 1, Math.floor(freemem() / (GB_PER_WORKER * 2 ** 30))),
);

// SM-DEPLOY: tests/ dir foi migrada de landinglab-backoffice — tests em node
// para API/lib e jsdom para hooks/components (mesmo padrão do source app).
export default defineConfig({
  test: {
    globals: false,
    environment: 'jsdom',
    include: [
      'src/__tests__/**/*.test.ts',
      'src/__tests__/**/*.test.tsx',
      'src/app/**/__tests__/**/*.test.ts',
      'src/app/**/__tests__/**/*.test.tsx',
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
    ],
    exclude: ['**/node_modules/**', '**/.next/**'],
    environmentMatchGlobs: [
      ['tests/api/**', 'node'],
      ['tests/lib/**', 'node'],
      ['tests/edit/**', 'node'],
      ['tests/hooks/**', 'jsdom'],
      ['tests/components/**', 'jsdom'],
    ],
    // src/__tests__/setup.ts: matchers + polyfills pra testes em src/__tests__/
    // tests/setup-dom.ts: SM-DEPLOY — polyfills adicionais (ResizeObserver,
    // window.scroll) usados por modais Polaris migrados de landinglab-backoffice.
    setupFiles: ['./tests/setup-dom.ts', './src/__tests__/setup.ts'],
    // Story CI-2 — teto de workers: jsdom em 15 threads (padrão na máquina de 16 CPUs) disputa CPU e
    // memória com o resto da máquina. Na CI (4 vCPU) continua 3 = o padrão de hoje.
    maxWorkers: workers,
    minWorkers: 1,
  },
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@blackshop/db': resolve(__dirname, '../../packages/db/src/index.ts'),
      '@blackshop/payments/markets': resolve(__dirname, '../../packages/payments/src/markets.ts'),
      '@blackshop/payments/checkout': resolve(__dirname, '../../packages/payments/src/checkout.ts'),
      '@blackshop/db/schema-landinglab-core': resolve(
        __dirname,
        '../../packages/db/src/schema-landinglab-core.ts',
      ),
      '@blackshop/landinglab-cloner': resolve(
        __dirname,
        '../../packages/landinglab-cloner/src/index.ts',
      ),
      '@blackshop/landinglab-build': resolve(
        __dirname,
        '../../packages/landinglab-build/src/index.ts',
      ),
      '@blackshop/landinglab-deploy': resolve(
        __dirname,
        '../../packages/landinglab-deploy/src/index.ts',
      ),
      '@blackshop/landinglab-domains': resolve(
        __dirname,
        '../../packages/landinglab-domains/src/index.ts',
      ),
      '@blackshop/landinglab-adapters': resolve(
        __dirname,
        '../../packages/landinglab-adapters/src/index.ts',
      ),
    },
  },
});
