import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Orchestrator tests podem exercitar retry paths com sleeps; 30s conforta.
    testTimeout: 30_000,
  },
});
