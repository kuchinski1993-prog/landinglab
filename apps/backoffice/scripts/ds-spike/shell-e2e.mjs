/* eslint-env browser, node */
/* eslint-disable no-console */
// Story 20.2 — verificação do shell novo no navegador real (Chromium/Playwright)
// contra o backoffice rodando, sem API (as telas mostram os próprios erros, mas
// a moldura precisa ficar de pé):
//   1. Convivência: telas em Polaris React renderizam DENTRO do shell (sem
//      sobrepor topo/menu), sem erros de página.
//   2. Celular (375 px): botão abre/fecha o menu; Esc, clique fora e escolher
//      item fecham; o foco volta para o botão.
//   3. Ctrl+K foca a busca; CDN do Polaris 2 bloqueado → aviso, menu continua.
//
// Uso: (backoffice rodando) BASE_URL=http://localhost:3041 node apps/backoffice/scripts/ds-spike/shell-e2e.mjs [pasta-capturas]

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const { chromium } = createRequire(join(repo, 'package.json'))('@playwright/test');

const BASE = process.env.BASE_URL ?? 'http://localhost:3041';
const CDN = 'https://cdn.shopify.com/shopifycloud/polaris-2.js';
const SHOTS = process.argv[2] ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const PAGES = ['/', '/products', '/orders', '/trustshield/inbox', '/landing-pages', '/vsl', '/tracker/campaigns', '/settings', '/lojas'];
const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};

async function newPage(browser, { width = 1280, height = 900, blockCdn = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addCookies([{ name: 'blackshop.sid', value: 'e2e', url: BASE }]);
  if (blockCdn) await ctx.route(CDN, (route) => route.abort());
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
  return { ctx, page, pageErrors };
}

const browser = await chromium.launch();
try {
  // 1) Convivência no desktop
  {
    const { ctx, page, pageErrors } = await newPage(browser);
    for (const path of PAGES) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }).catch(() => undefined);
      await page.waitForTimeout(500);
      const info = await page.evaluate(() => {
        const main = document.querySelector('#ds-shell-content .ds-shell-main__content');
        const first = main?.querySelector('.Polaris-Page, s-page, .ds-screen, [class*="Polaris-"]');
        const box = first?.getBoundingClientRect();
        const nav = document.querySelector('#ds-shell-nav')?.getBoundingClientRect();
        return {
          topbar: !!document.querySelector('[data-testid="shell-topbar"]'),
          navWidth: nav ? Math.round(nav.width) : 0,
          contentLeft: box ? Math.round(box.left) : null,
          contentTop: box ? Math.round(box.top) : null,
          contentText: (main?.textContent ?? '').trim().length,
          oldFrameNav: !!document.querySelector('.Polaris-Navigation'),
          oldTopBar: !!document.querySelector('.Polaris-TopBar'),
          active: document.querySelector('#ds-shell-nav [aria-current="page"]')?.textContent?.trim() ?? null,
        };
      });
      check(
        info.topbar && info.navWidth >= 200 && info.contentLeft !== null && info.contentLeft >= info.navWidth - 1 && info.contentTop >= 55 && info.contentText > 0 && !info.oldFrameNav && !info.oldTopBar,
        `${path}: dentro do shell (nav ${info.navWidth}px, conteúdo em x=${info.contentLeft} y=${info.contentTop}, ativo: ${info.active})`,
      );
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `desktop${path.replace(/\//g, '_') || '_'}.png`) });
    }
    // Sem API/banco, telas com server actions (ex.: /landing-pages → DATABASE_URL) falham no
    // servidor — isso é do ambiente, não da moldura. Só os demais erros contam.
    const shellErrors = pageErrors.filter((e) => !/Server Components render/.test(e));
    check(shellErrors.length === 0, `desktop sem erros de página da moldura (${shellErrors.length}) ${shellErrors.slice(0, 3).join(' | ')}`);

    await page.goto(`${BASE}/products`, { waitUntil: 'domcontentloaded' });
    await page.keyboard.press('Control+k');
    check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'shell-search-input'), 'Ctrl+K foca a busca');
    await ctx.close();
  }

  // 2) Celular 375 px
  {
    const { ctx, page, pageErrors } = await newPage(browser, { width: 375, height: 800 });
    await page.goto(`${BASE}/products`, { waitUntil: 'networkidle' }).catch(() => undefined);
    const navVisible = () =>
      page.evaluate(() => getComputedStyle(document.getElementById('ds-shell-nav')).visibility === 'visible');
    const toggleFocused = () =>
      page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'shell-nav-toggle');
    check(!(await navVisible()), '375px: menu começa fechado');
    const contentLeft = await page.evaluate(
      () => document.querySelector('#ds-shell-content .ds-shell-main__content')?.getBoundingClientRect().left ?? -1,
    );
    check(contentLeft >= 0 && contentLeft < 5, `375px: conteúdo ocupa a largura (x=${Math.round(contentLeft)})`);
    const toggle = page.getByTestId('shell-nav-toggle');
    await toggle.click();
    await page.waitForTimeout(300);
    check(await navVisible(), '375px: botão abre o menu');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'mobile_menu_aberto.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check(!(await navVisible()) && (await toggleFocused()), '375px: Esc fecha e devolve o foco ao botão');
    await toggle.click();
    await page.waitForTimeout(300);
    await page.mouse.click(360, 400);
    await page.waitForTimeout(300);
    check(!(await navVisible()), '375px: clique fora fecha');
    await toggle.click();
    await page.waitForTimeout(300);
    await toggle.click();
    await page.waitForTimeout(300);
    check(!(await navVisible()) && (await toggleFocused()), '375px: botão fecha e mantém o foco');
    await toggle.click();
    await page.waitForTimeout(300);
    await page.locator('#ds-shell-nav').getByRole('link', { name: 'Pedidos', exact: true }).click();
    await page.waitForURL('**/orders');
    await page.waitForTimeout(400);
    check(!(await navVisible()) && (await toggleFocused()), '375px: escolher item navega, fecha e devolve o foco');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'mobile_orders.png') });
    check(pageErrors.length === 0, `375px sem erros de página (${pageErrors.length}) ${pageErrors.slice(0, 3).join(' | ')}`);
    await ctx.close();
  }

  // 3) CDN bloqueado
  {
    const { ctx, page } = await newPage(browser, { blockCdn: true });
    await page.goto(`${BASE}/products`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('shell-wc-error').waitFor({ timeout: 8000 }).catch(() => undefined);
    const state = await page.evaluate(() => ({
      notice: document.querySelector('[data-testid="shell-wc-error"]')?.textContent ?? null,
      links: document.querySelectorAll('#ds-shell-nav a').length,
    }));
    check(Boolean(state.notice) && state.links > 10, `CDN bloqueado: aviso "${state.notice?.slice(0, 50)}…" e menu com ${state.links} links`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'cdn_bloqueado.png') });
    await ctx.close();
  }

  // 4) CDN bloqueado no celular (375 px): o botão do menu continua visível e funciona
  {
    const { ctx, page } = await newPage(browser, { width: 375, height: 800, blockCdn: true });
    await page.goto(`${BASE}/products`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('shell-wc-error').waitFor({ timeout: 8000 }).catch(() => undefined);
    const btn = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="shell-nav-toggle"]');
      const svg = el?.querySelector('svg')?.getBoundingClientRect();
      return {
        w: svg ? Math.round(svg.width) : 0,
        h: svg ? Math.round(svg.height) : 0,
        label: el?.getAttribute('aria-label'),
        bg: el ? getComputedStyle(el).backgroundColor : null,
      };
    });
    check(btn.w >= 16 && btn.h >= 16 && btn.label === 'Abrir menu', `375px + CDN bloqueado: botão visível (ícone ${btn.w}x${btn.h}, fundo ${btn.bg}, rótulo "${btn.label}")`);
    await page.getByTestId('shell-nav-toggle').click();
    await page.waitForTimeout(300);
    const open = await page.evaluate(() => getComputedStyle(document.getElementById('ds-shell-nav')).visibility === 'visible');
    check(open, '375px + CDN bloqueado: o botão abre o menu');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'mobile_cdn_bloqueado.png') });
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(failures.length === 0 ? '\nTUDO OK' : `\n${failures.length} falha(s)`);
process.exit(failures.length === 0 ? 0 : 1);
