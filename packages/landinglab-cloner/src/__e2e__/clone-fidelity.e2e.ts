// E2E — Clone Fidelity Browser/Runtime Foundation
//
// Goals (production clone confidence):
//   1. Prove que HTML clonado carrega em browser real sem erros críticos
//   2. Prove que interações essenciais (accordion, FAQ) funcionam pós-clone
//   3. Prove que assessCloneFidelity retorna verdicts corretos por fixture
//   4. Prove que artefatos de captura (chrome-extension) são detectados
//
// Estratégia: HTTP server in-process (http.createServer) serve fixtures
// SINTÉTICOS (nenhuma URL real, zero rede pra origem externa). Playwright
// navega e assertions rodam sobre o browser + sobre a função pura.
//
// Zero dependência de tema real, zero flake por site origem mudando.

import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';

import { assessCloneFidelity } from '../orchestrator.js';

// ────────────────────────────────────────────────────────────────────────────
// Fixtures — inline HTML sintético, zero rede externa
// ────────────────────────────────────────────────────────────────────────────

const HEALTHY_DENIM_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Klensia Denim (E2E fixture)</title>
  <link rel="stylesheet" href="/static/theme.css">
  <style>body{font-family:sans-serif;margin:0}</style>
</head>
<body>
  <header-drawer id="header-drawer">
    <button aria-label="Menu">Menu</button>
    <menu-drawer id="menu-drawer">
      <ul><li>Item 1</li></ul>
    </menu-drawer>
  </header-drawer>
  <main>
    <h1>Klensia Denim</h1>
    <p>Cloned landing content.</p>
  </main>
  <script>
    // No chrome-extension, no analytics, no side effects.
    window.__clonedPage = true;
  </script>
</body>
</html>`;

const BLOCKED_EXTENSION_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Extension Artifact (E2E fixture)</title>
  <style>body{margin:0}</style>
</head>
<body>
  <script src="chrome-extension://abcdefghij/inject.js"></script>
  <main>Landing content</main>
</body>
</html>`;

const DEGRADED_PLACEHOLDER_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Degraded Placeholder (E2E fixture)</title>
  <style>body{margin:0}</style>
</head>
<body>
  <script src="/cloned/undefined/asset.js"></script>
  <main>Landing content</main>
</body>
</html>`;

const PSS_ACCORDION_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>PSS Accordion (E2E fixture)</title>
  <style>
    body{font-family:sans-serif;margin:0}
    .pss-panel{display:none}
    .pss-panel.pss-open{display:block}
  </style>
</head>
<body>
  <div class="pss-accordion">
    <button class="pss-accordion-trigger" aria-expanded="false" aria-controls="p1">
      Question 1
    </button>
    <div id="p1" class="pss-panel">Answer 1</div>
  </div>
  <script>
    document.querySelectorAll('.pss-accordion-trigger').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!expanded));
        var id = btn.getAttribute('aria-controls');
        var panel = document.getElementById(id);
        if (panel) panel.classList.toggle('pss-open');
      });
    });
  </script>
</body>
</html>`;

const FAQ_IMG_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>FAQ IMG (E2E fixture)</title>
  <style>
    body{font-family:sans-serif;margin:0}
    .faq-img-answer{display:none}
    .faq-img-answer.is-open{display:block}
  </style>
</head>
<body>
  <div class="faq-img">
    <div class="faq-img-question" data-target="a1">Question A</div>
    <div class="faq-img-answer" data-id="a1">Answer A</div>
  </div>
  <script>
    document.querySelectorAll('.faq-img-question').forEach(function (q) {
      q.addEventListener('click', function () {
        var id = q.getAttribute('data-target');
        var ans = document.querySelector('.faq-img-answer[data-id="' + id + '"]');
        if (ans) ans.classList.toggle('is-open');
      });
    });
  </script>
</body>
</html>`;

const HTML_OVERRIDE_GENERIC_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Generic htmlOverride (E2E fixture)</title>
  <link rel="stylesheet" href="/static/generic.css">
</head>
<body>
  <main><h2>Generic Landing</h2></main>
  <script src="/static/vendor.js"></script>
  <script src="/static/app.js"></script>
</body>
</html>`;

const BEPUREX_LIKE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Bepurex-like (E2E fixture)</title>
  <link rel="stylesheet" href="/static/bepurex.css">
</head>
<body>
  <section class="cc-timeline">
    <div class="swiper">
      <div class="swiper-slide">Phase 1</div>
      <div class="swiper-slide">Phase 2</div>
    </div>
  </section>
  <main>Bepurex landing content</main>
</body>
</html>`;

// ────────────────────────────────────────────────────────────────────────────
// Fixture registry — used by both the server router and the test matrix
// ────────────────────────────────────────────────────────────────────────────

interface Fixture {
  path: string;
  html: string;
  expectedVerdict: 'HEALTHY' | 'DEGRADED' | 'BLOCKED';
  keyCheck: string;
}

const FIXTURES: Fixture[] = [
  {
    path: '/healthy-denim',
    html: HEALTHY_DENIM_HTML,
    expectedVerdict: 'HEALTHY',
    keyCheck: 'header-drawer in DOM, CSS present',
  },
  {
    path: '/blocked-extension',
    html: BLOCKED_EXTENSION_HTML,
    expectedVerdict: 'BLOCKED',
    keyCheck: 'fidelity BLOCKED finding present',
  },
  {
    path: '/degraded-placeholder',
    html: DEGRADED_PLACEHOLDER_HTML,
    expectedVerdict: 'DEGRADED',
    keyCheck: 'unresolved-asset-placeholders finding',
  },
  {
    path: '/pss-accordion',
    html: PSS_ACCORDION_HTML,
    expectedVerdict: 'HEALTHY',
    keyCheck: 'accordion click works',
  },
  {
    path: '/faq-img',
    html: FAQ_IMG_HTML,
    expectedVerdict: 'HEALTHY',
    keyCheck: 'faq-img question toggles is-open',
  },
  {
    path: '/htmloverride-generic',
    html: HTML_OVERRIDE_GENERIC_HTML,
    expectedVerdict: 'HEALTHY',
    keyCheck: 'scripts intact, no placeholders',
  },
  {
    path: '/bepurex-like',
    html: BEPUREX_LIKE_HTML,
    expectedVerdict: 'HEALTHY',
    keyCheck: 'CSS present, no artifacts',
  },
];

// ────────────────────────────────────────────────────────────────────────────
// In-process HTTP server — serves fixtures + empty CSS/JS stubs
// ────────────────────────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    // Static asset stubs — empty body, correct content-type. Avoids console 404s.
    if (url.endsWith('.css')) {
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end('/* stub */');
      return;
    }
    if (url.endsWith('.js') && !url.startsWith('/cloned/undefined/')) {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end('/* stub */');
      return;
    }
    // /cloned/undefined/* is intentionally left 404 so the DEGRADED fixture
    // stays representative of the real bug (urlMap miss produces broken path).
    const fixture = FIXTURES.find((f) => f.path === url);
    if (fixture) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fixture.html);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Individual fixture tests — browser assertions per fixture
// ────────────────────────────────────────────────────────────────────────────

test.describe('healthy-denim: baseline healthy clone', () => {
  test('page loads with 200, CSS link present, no critical errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      // Ignore benign errors that show up in headless Chromium regardless of clone quality.
      if (text.includes('ResizeObserver')) return;
      if (text.includes('favicon')) return;
      consoleErrors.push(text);
    });
    const response = await page.goto(`${baseUrl}/healthy-denim`);
    expect(response?.status()).toBe(200);
    const linkCount = await page.locator('link[rel="stylesheet"]').count();
    expect(linkCount).toBeGreaterThan(0);
    // No chrome-extension or moz-extension URLs anywhere in the DOM.
    const scriptSrcs = await page.$$eval('script[src]', (nodes) =>
      nodes.map((n) => (n as HTMLScriptElement).src),
    );
    expect(scriptSrcs.some((s) => s.startsWith('chrome-extension://'))).toBe(false);
    expect(scriptSrcs.some((s) => s.startsWith('moz-extension://'))).toBe(false);
    // Custom element registered in DOM (proves DOM parse succeeded).
    const headerDrawerExists = await page.$('header-drawer');
    expect(headerDrawerExists).not.toBeNull();
    // No critical console errors.
    expect(consoleErrors).toEqual([]);
  });

  test('assessCloneFidelity on the served HTML returns HEALTHY', () => {
    const verdict = assessCloneFidelity(HEALTHY_DENIM_HTML).verdict;
    expect(verdict).toBe('HEALTHY');
  });
});

test.describe('blocked-extension: chrome-extension artifact', () => {
  test('assessCloneFidelity returns BLOCKED', () => {
    const result = assessCloneFidelity(BLOCKED_EXTENSION_HTML);
    expect(result.verdict).toBe('BLOCKED');
    expect(result.findings.some((f) => f.includes('browser-extension-artifact'))).toBe(true);
  });

  test('DOM exposes the blocked script src for observability', async ({ page }) => {
    await page.goto(`${baseUrl}/blocked-extension`);
    const scriptSrcs = await page.$$eval('script[src]', (nodes) =>
      nodes.map((n) => (n as HTMLScriptElement).src),
    );
    expect(scriptSrcs.some((s) => s.startsWith('chrome-extension://'))).toBe(true);
  });
});

test.describe('degraded-placeholder: /cloned/undefined/ path', () => {
  test('assessCloneFidelity returns DEGRADED with unresolved-asset-placeholders', () => {
    const result = assessCloneFidelity(DEGRADED_PLACEHOLDER_HTML);
    expect(result.verdict).toBe('DEGRADED');
    expect(result.findings.some((f) => f.includes('unresolved-asset-placeholders'))).toBe(true);
  });
});

test.describe('pss-accordion: interactive UX', () => {
  test('click trigger opens the panel', async ({ page }) => {
    await page.goto(`${baseUrl}/pss-accordion`);
    const trigger = page.locator('.pss-accordion-trigger');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const panel = page.locator('#p1');
    await expect(panel).toBeVisible();
  });
});

test.describe('faq-img: image FAQ toggle', () => {
  test('click question adds is-open to answer', async ({ page }) => {
    await page.goto(`${baseUrl}/faq-img`);
    const question = page.locator('.faq-img-question');
    const answer = page.locator('.faq-img-answer[data-id="a1"]');
    await expect(answer).not.toHaveClass(/is-open/);
    await question.click();
    await expect(answer).toHaveClass(/is-open/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// STEP 5 — Data-driven verdict matrix (all fixtures, parameterized)
// ────────────────────────────────────────────────────────────────────────────

test.describe('E2E regression matrix: fidelity verdict × fixture', () => {
  for (const fx of FIXTURES) {
    test(`${fx.path} → verdict ${fx.expectedVerdict} (${fx.keyCheck})`, async ({ page }) => {
      const response = await page.goto(`${baseUrl}${fx.path}`);
      expect(response?.status()).toBe(200);
      const verdict = assessCloneFidelity(fx.html).verdict;
      expect(verdict).toBe(fx.expectedVerdict);
    });
  }
});
