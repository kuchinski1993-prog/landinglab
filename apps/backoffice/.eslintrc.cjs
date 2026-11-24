/* eslint-env node */
// Backoffice — complementa o .eslintrc.cjs da raiz (sem `root`, as regras se somam).
module.exports = {
  overrides: [
    {
      // Story 18.1b (ARCH-001): o painel só usa o núcleo de @blackshop/errors (sem Fastify/Node).
      files: ['src/**/*.ts', 'src/**/*.tsx'],
      excludedFiles: ['src/__tests__/**', 'src/**/__tests__/**', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: '@blackshop/errors/fastify',
                message: 'Handler Fastify é só da API. No painel use `@blackshop/errors` (núcleo) ou `@/lib/errors`.',
              },
              {
                name: '@blackshop/errors/testing',
                message: 'Utilitários de teste do catálogo só em arquivos de teste.',
              },
            ],
          },
        ],
      },
    },
  ],
};
