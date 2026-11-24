/* eslint-env browser, node */
/* eslint-disable no-console */
// Story 20.1 — verificação no navegador real (Chromium/Playwright) contra o
// backoffice rodando (Next 14 + React do App Router), sem API:
//   1. /ds-lab: um único bundle Polaris, zero avisos de hidratação, campo
//      controlado, select, modal (estado + commandFor, Esc, foco), booleanos.
//   2. /trustshield/config (piloto): cartões, links e testids; erro da API não
//      bloqueia os cartões.
//   3. CDN bloqueado: mensagem em português + "Tentar de novo" (nunca branco).
//   4. Convivência (AC3): telas em Polaris React com o bundle bloqueado × liberado
//      → diferença de pixels (precisa ser 0).
//
// Uso: (backoffice rodando) BASE_URL=http://localhost:3031 node apps/backoffice/scripts/ds-spike/ds-lab-e2e.mjs [pasta-capturas]

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const { chromium } = createRequire(join(repo, 'package.json'))('@playwright/test');
const sharp = createRequire(join(repo, 'packages/landinglab-cloner/package.json'))('sharp');

const BASE = process.env.BASE_URL ?? 'http://localhost:3031';
const CDN = 'https://cdn.shopify.com/shopifycloud/polaris-2.js';
const SHOTS = process.argv[2] ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const out = { base: BASE, measuredAt: new Date().toISOString() };
const HYDRATION = /hydrat|did not match|server rendered html|text content does not match/i;

async function newPage(browser, { blockCdn = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name: 'blackshop.sid', value: 'e2e', url: BASE }]);
  if (blockCdn) await ctx.route(CDN, (route) => route.abort());
  const page = await ctx.newPage();
  const messages = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') messages.push(m.text().slice(0, 240));
  });
  page.on('pageerror', (e) => messages.push(`pageerror: ${String(e).slice(0, 240)}`));
  return { ctx, page, messages };
}

const browser = await chromium.launch();
try {
  // 1) /ds-lab
  {
    const { ctx, page, messages } = await newPage(browser);
    const t0 = Date.now();
    await page.goto(`${BASE}/ds-lab`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('s-page')?.shadowRoot, null, { timeout: 30000 });
    const readyMs = Date.now() - t0;
    await page.waitForTimeout(800);
    const lab = await page.evaluate(() => ({
      polarisScripts: [...document.querySelectorAll('script[src]')].map((s) => s.src).filter((s) => /polaris/i.test(s)),
      inHead: !!document.head.querySelector('script#polaris-wc'),
      htmlClass: document.documentElement.className,
    }));
    // campo controlado: digitação real
    const nome = page.locator('#ds-lab-nome input');
    await nome.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Nova');
    const afterTyping = await page.locator('[data-testid="ds-lab-nome-estado"]').textContent();
    await page.getByText('Limpar', { exact: true }).click();
    await page.waitForTimeout(200);
    const afterReset = await page.evaluate(() => {
      const el = document.getElementById('ds-lab-nome');
      return { value: el.value, error: el.error, inner: el.shadowRoot?.querySelector('input')?.value };
    });
    await page.getByText('Restaurar exemplo', { exact: true }).click();
    await page.waitForTimeout(200);
    const afterRestore = await page.evaluate(() => document.getElementById('ds-lab-nome').value);
    // select
    let selectResult;
    const nativeSelect = page.locator('#ds-lab-plano select');
    if (await nativeSelect.count()) {
      await nativeSelect.selectOption('basico');
      await page.waitForTimeout(200);
      selectResult = { via: 'native-select', estado: await page.locator('[data-testid="ds-lab-plano-estado"]').textContent() };
    } else {
      selectResult = { via: 'no-native-select', shadow: await page.evaluate(() => document.getElementById('ds-lab-plano').shadowRoot?.innerHTML.slice(0, 200)) };
    }
    await page.getByText('Voltar para Básico', { exact: true }).click();
    const selectReset = await page.evaluate(() => document.getElementById('ds-lab-plano').value);
    // booleanos (React do App Router)
    const booleans = await page.evaluate(() => {
      const all = [...document.querySelectorAll('s-button')];
      const off = all.find((b) => b.textContent.includes('disabled=false'));
      const on = all.find((b) => b.textContent.trim() === 'Desabilitado');
      return {
        falseProp: { attr: off.getAttribute('disabled'), prop: off.disabled },
        trueProp: { attr: on.getAttribute('disabled'), prop: on.disabled },
      };
    });
    // modal pelo estado: botão primário da página → Esc → foco
    const modalOpen = () => page.evaluate((id) => !!document.getElementById(id)?.shadowRoot?.querySelector('dialog[open]'), 'ds-lab-info');
    const confirmOpen = () =>
      page.evaluate(() => {
        const m = [...document.querySelectorAll('s-modal')].find((x) => x.getAttribute('heading') === 'Excluir rascunho?');
        return !!m?.shadowRoot?.querySelector('dialog[open]');
      });
    await page.getByText('Excluir rascunho', { exact: true }).click();
    await page.waitForTimeout(600);
    const confirmOpened = await confirmOpen();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    const confirmClosedByEsc = !(await confirmOpen());
    const focusAfterEsc = await page.evaluate(() => document.activeElement?.getAttribute('slot') ?? document.activeElement?.localName);
    // modal por commandFor
    await page.locator('s-button[commandfor="ds-lab-info"]').filter({ visible: true }).first().click();
    await page.waitForTimeout(600);
    const infoOpened = await modalOpen();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    const infoClosed = !(await modalOpen());
    const log = await page.locator('s-section[heading="Registro"]').textContent();

    out.dsLab = {
      readyMs,
      ...lab,
      field: { afterTyping, afterReset, afterRestore },
      select: { ...selectResult, reset: selectReset },
      booleans,
      modal: { confirmOpened, confirmClosedByEsc, focusAfterEsc, infoOpened, infoClosed, log: log?.trim() },
      hydrationMessages: messages.filter((m) => HYDRATION.test(m)),
      consoleMessages: messages,
    };
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'ds-lab.png'), fullPage: true });
    await ctx.close();
  }

  // 2) piloto
  {
    const { ctx, page, messages } = await newPage(browser);
    await page.goto(`${BASE}/trustshield/config`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('s-page')?.shadowRoot, null, { timeout: 60000 });
    await page.waitForTimeout(2500);
    out.pilot = await page.evaluate(() => ({
      heading: document.querySelector('s-page')?.getAttribute('heading'),
      cards: [...document.querySelectorAll('[data-testid^="config-card-"]')].map((a) => [a.dataset.testid, a.getAttribute('href')]),
      banner: document.querySelector('s-banner')?.getAttribute('heading') ?? null,
      polarisScripts: [...document.querySelectorAll('script[src]')].filter((s) => /polaris/i.test(s.src)).length,
    }));
    out.pilot.hydrationMessages = messages.filter((m) => HYDRATION.test(m));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'trustshield-config.png'), fullPage: true });
    // navegação client-side para uma tela Polaris React e volta (o bundle continua um só)
    await page.locator('[data-testid="config-card-macros"]').click();
    await page.waitForURL('**/trustshield/config/macros', { timeout: 60000 });
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('[data-testid="config-card-automation"]'), null, { timeout: 60000 });
    out.pilot.afterNavigationPolarisScripts = await page.evaluate(
      () => [...document.querySelectorAll('script[src]')].filter((s) => /polaris/i.test(s.src)).length,
    );
    await ctx.close();
  }

  // 3) CDN bloqueado
  {
    const { ctx, page } = await newPage(browser, { blockCdn: true });
    await page.goto(`${BASE}/trustshield/config`, { waitUntil: 'domcontentloaded' });
    const t0 = Date.now();
    await page.waitForSelector('[data-testid="ds-gate-error"]', { timeout: 30000 });
    const errorAfterMs = Date.now() - t0;
    const text = await page.locator('[data-testid="ds-gate-error"]').textContent();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'cdn-bloqueado.png'), fullPage: true });
    await ctx.unroute(CDN);
    await page.getByText('Tentar de novo', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('s-page')?.shadowRoot, null, { timeout: 30000 });
    const scriptsAfterRetry = await page.evaluate(() => document.querySelectorAll('script#polaris-wc').length);
    out.cdnBlocked = { errorAfterMs, text: text?.trim(), recoveredAfterRetry: true, scriptsAfterRetry };
    await ctx.close();
  }

  // 4) Convivência: telas não migradas com o bundle bloqueado × liberado
  {
    const routes = ['/', '/products', '/orders', '/settings', '/trustshield', '/landing-pages'];
    out.coexistence = [];
    for (const route of routes) {
      const shots = [];
      // bloqueado (antes) ×2 para medir o ruído da própria tela; liberado (depois) ×1
      for (const [i, blockCdn] of [true, true, false].entries()) {
        const { ctx, page } = await newPage(browser, { blockCdn });
        await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 120000 }).catch(() => undefined);
        await page.waitForTimeout(2500);
        const buf = await page.screenshot({ fullPage: false, animations: 'disabled', caret: 'hide' });
        shots.push(buf);
        if (SHOTS && i !== 1) writeFileSync(join(SHOTS, `${route.replace(/\//g, '_') || '_home'}-${blockCdn ? 'antes' : 'depois'}.png`), buf);
        await ctx.close();
      }
      const raw = await Promise.all(shots.map((s) => sharp(s).raw().toBuffer({ resolveWithObject: true })));
      const countDiff = (a, b) => {
        let diff = 0;
        for (let i = 0; i < a.data.length; i += a.info.channels) {
          if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) diff++;
        }
        return diff;
      };
      out.coexistence.push({
        route,
        pixels: raw[0].info.width * raw[0].info.height,
        noiseDiffPixels: countDiff(raw[0], raw[1]),
        diffPixels: countDiff(raw[0], raw[2]),
      });
    }
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify(out, null, 2));
