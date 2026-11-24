import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Alias `@/` igual ao tsconfig (rotas/páginas do app importam `@/lib/...`).
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Story 15.7: testes renderizam componentes do checkout (JSX automático).
  esbuild: { jsx: 'automatic' },
  test: {
    globals: false,
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
  },
});
