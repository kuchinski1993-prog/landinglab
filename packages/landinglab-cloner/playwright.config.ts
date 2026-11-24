// Playwright config LOCAL — clone-fidelity E2E.
//
// Isolado do root config (que boota backoffice + tests em ./tests/e2e).
// Este suite serve fixtures sintéticos via http.createServer no próprio
// beforeAll — zero webServer external, zero side-effects fora do processo.
//
// Rodar:
//   npx playwright test -c packages/landinglab-cloner/playwright.config.ts

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './src/__e2e__',
  testMatch: /.*\.e2e\.ts$/,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false, // shared in-process HTTP server per suite
  forbidOnly: !!process.env['CI'],
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // No webServer — cada teste sobe seu próprio http.createServer no beforeAll.
});
