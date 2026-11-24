import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.smoke.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/orchestrator.ts', 'src/agents/**/*.ts', 'src/schema/build-output.ts'],
      exclude: ['**/*.test.ts', '**/node_modules/**'],
    },
  },
});
