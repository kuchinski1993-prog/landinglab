/* eslint-env browser, node */
/* eslint-disable no-console */
// Story 20.14a (AC12) — menu no preto do cabeçalho + painel claro de cantos
// arredondados, no navegador real (Chromium/Playwright do repo), padrão 20.5f:
// backoffice em `next start`, API em mock HTTP local, sessão = cookie
// `blackshop.sid`. Complementa `shell-e2e.mjs` (convivência/gaveta da 20.2,
// que continua valendo e deve ser rodado junto). Grava prints, a comparação
// lado a lado com o print da Shopify e `depois-medicoes.json`.
//
// Uso: BASE_URL=http://localhost:3094 node apps/backoffice/scripts/ds-spike/shell-frame-e2e.mjs docs/prints/20.14a

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const req = createRequire(join(repo, 'package.json'));
const { chromium } = req('@playwright/test');
const sharp = createRequire(join(repo, 'packages/landinglab-cloner/package.json'))('sharp');

const BASE = process.env.BASE_URL ?? 'http://localhost:3094';
const OUT = resolve(process.argv[2] ?? 'docs/prints/20.14a');
mkdirSync(OUT, { recursive: true });

const SHOPIFY = join(repo, 'docs/prints/onda-16/referencia-shopify-inicio.png');
const PAGES = [
  ['inicio', '/'],
  ['produtos', '/products'],
  ['pedidos', '/orders'],
  ['configuracoes-conta', '/settings'],
  ['atendimento', '/trustshield/inbox'],
  ['tracker', '/tracker/campaigns'],
];
// O editor de landing (/landing-pages/[id]/editor e o EditWorkspace) lê o banco direto (Drizzle) —
// sem DATABASE_URL a rota cai no erro do servidor. A barra `sticky bottom: 0` do LandingPageForm e a
// pré-visualização `sticky top: 16px` do EditWorkspace são reproduzidas com o MESMO estilo inline
// dentro do conteúdo real do shell (seção 4).
const SIZES = [
  [1280, 800],
  [1440, 900],
  [1920, 1080],
];

const failures = [];
const report = { base: BASE, geradoEm: new Date().toISOString() };
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  return ok;
};

const parseRgb = (s) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
const lum = ([r, g, b]) => {
  const f = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
};
const same = (a, b, tol = 2) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function pixels(buffer) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { at: (x, y) => [0, 1, 2].map((k) => data[(y * info.width + x) * 3 + k]), info, data };
}

async function newPage(browser, { width, height, scale = 1 }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: 'no-preference' });
  await ctx.addCookies([{ name: 'blackshop.sid', value: 'e2e', url: BASE }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  return { ctx, page, errors };
}

async function open(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }).catch(() => undefined);
  await page.waitForSelector('[data-testid="shell-frame"]', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(700);
}

const hideContent = (page, hide) =>
  page.evaluate((h) => {
    const el = document.querySelector('.ds-shell-main__content');
    if (el) el.style.visibility = h ? 'hidden' : '';
  }, hide);

const browser = await chromium.launch();
try {
  report.navegador = browser.version();

  // 1) Prints das telas em 1280/1440/1920 + títulos 26px/700 + sem rolagem horizontal
  report.telas = {};
  for (const [w, h] of SIZES) {
    const { ctx, page } = await newPage(browser, { width: w, height: h });
    for (const [name, path] of PAGES) {
      await open(page, path);
      const info = await page.evaluate(() => {
        const title = document.querySelector('.ds-shell-main__content h1');
        const cs = title ? getComputedStyle(title) : null;
        const frame = document.querySelector('[data-testid="shell-frame"]').getBoundingClientRect();
        return {
          titulo: title ? { texto: title.textContent.trim().slice(0, 40), fontSize: cs.fontSize, fontWeight: cs.fontWeight } : null,
          rolagemHorizontal: document.documentElement.scrollWidth > window.innerWidth,
          moldura: { top: frame.top, left: frame.left, right: frame.right, bottom: frame.bottom },
        };
      });
      report.telas[`${w}-${name}`] = info;
      check(!info.rolagemHorizontal, `${w} ${name}: sem rolagem horizontal`);
      check(info.moldura.top === 56 && info.moldura.left === 240 && info.moldura.right === w - 8 && info.moldura.bottom === h, `${w} ${name}: moldura em 56/240/${w - 8}/${h} (${JSON.stringify(info.moldura)})`);
      if (info.titulo && name !== 'atendimento') {
        check(info.titulo.fontSize === '26px' && info.titulo.fontWeight === '700', `${w} ${name}: título "${info.titulo.texto}" ${info.titulo.fontSize}/${info.titulo.fontWeight}`);
      }
      await page.screenshot({ path: join(OUT, `depois-${w}-${name}.png`) });
    }
    await ctx.close();
  }

  // 2) Menu: cores, contraste, ícones claros, ativo, hover, foco, expandido (1440)
  {
    const { ctx, page } = await newPage(browser, { width: 1440, height: 900 });
    await open(page, '/products');
    const colors = await page.evaluate(() => {
      const css = (sel, prop = 'color') => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el)[prop] : null;
      };
      const active = document.querySelector('#ds-shell-nav .ds-shell-nav__link--active');
      const activeSub = document.querySelector('#ds-shell-nav .ds-shell-nav__sublink--active');
      return {
        topbar: css('[data-testid="shell-topbar"]', 'backgroundColor'),
        menu: css('#ds-shell-nav', 'backgroundColor'),
        texto: css('#ds-shell-nav .ds-shell-nav__link:not(.ds-shell-nav__link--active)'),
        titulo: css('#ds-shell-nav .ds-shell-nav__heading'),
        subitem: css('#ds-shell-nav .ds-shell-nav__sublink:not(.ds-shell-nav__sublink--active)'),
        contador: css('#ds-shell-nav .ds-shell-nav__badge'),
        contadorFundo: css('#ds-shell-nav .ds-shell-nav__badge', 'backgroundColor'),
        ativo: active
          ? { texto: active.textContent.trim(), fundo: getComputedStyle(active).backgroundColor, cor: getComputedStyle(active).color, peso: getComputedStyle(active).fontWeight, classe: active.className }
          : null,
        subitemAtivo: activeSub
          ? { texto: activeSub.textContent.trim(), cor: getComputedStyle(activeSub).color, peso: getComputedStyle(activeSub).fontWeight, ariaCurrent: activeSub.getAttribute('aria-current') }
          : null,
        ariaCurrent: [...document.querySelectorAll('#ds-shell-nav [aria-current="page"]')].map((n) => n.textContent.trim()),
        expandido: [...document.querySelectorAll('#ds-shell-nav .ds-shell-nav__sublist')].length,
        painel: getComputedStyle(document.querySelector('.ds-shell')).backgroundColor,
      };
    });
    report.menu = { cores: colors };
    const bg = parseRgb(colors.menu);
    check(colors.menu === colors.topbar, `(a) fundo do menu ${colors.menu} = cabeçalho ${colors.topbar}`);
    check(colors.painel === 'rgb(241, 241, 241)', `painel continua ${colors.painel}`);
    const contrastes = {
      texto: ratio(parseRgb(colors.texto), bg),
      tituloSecao: ratio(parseRgb(colors.titulo), bg),
      subitem: colors.subitem ? ratio(parseRgb(colors.subitem), bg) : null,
      contadorTexto: colors.contador ? ratio(parseRgb(colors.contador), parseRgb(colors.contadorFundo)) : null,
      ativoTexto: ratio(parseRgb(colors.ativo.cor), parseRgb(colors.ativo.fundo)),
    };
    check(contrastes.texto >= 4.5, `(b) texto dos itens ${contrastes.texto}:1`);
    check(contrastes.tituloSecao >= 4.5, `(b) títulos de seção ${contrastes.tituloSecao}:1`);
    if (contrastes.subitem !== null) check(contrastes.subitem >= 4.5, `(b) subitens ${contrastes.subitem}:1`);
    if (contrastes.contadorTexto !== null) check(contrastes.contadorTexto >= 4.5, `(b) texto do contador ${contrastes.contadorTexto}:1`);
    check(contrastes.ativoTexto >= 4.5, `(b) texto do item ativo ${contrastes.ativoTexto}:1`);
    check(colors.ativo.fundo === 'rgb(48, 48, 48)' && Number(colors.ativo.peso) >= 650, `item ativo "${colors.ativo.texto}" fundo ${colors.ativo.fundo} peso ${colors.ativo.peso}`);
    check(colors.expandido >= 1 && colors.subitemAtivo && colors.subitemAtivo.cor === 'rgb(227, 227, 227)' && Number(colors.subitemAtivo.peso) >= 650 && colors.subitemAtivo.ariaCurrent === 'page', `item expandido: subitem ativo "${colors.subitemAtivo?.texto}" ${colors.subitemAtivo?.cor} peso ${colors.subitemAtivo?.peso}, aria-current=${colors.subitemAtivo?.ariaCurrent}`);

    // Ícones: amostragem de pixel (a cor computada do s-icon não basta — K2)
    await page.waitForFunction(() => customElements.get('s-icon') !== undefined, null, { timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    const iconBoxes = await page.evaluate(() =>
      [...document.querySelectorAll('#ds-shell-nav .ds-shell-nav__icon')].map((el) => {
        const r = el.getBoundingClientRect();
        const link = el.closest('a');
        return { x: r.x, y: r.y, w: r.width, h: r.height, item: link?.textContent.trim(), ativo: link?.getAttribute('aria-current') === 'page' };
      }),
    );
    const shot = await pixels(await page.screenshot());
    const icones = [];
    for (const b of iconBoxes) {
      let best = [0, 0, 0];
      for (let y = Math.round(b.y); y < b.y + b.h; y += 1) {
        for (let x = Math.round(b.x); x < b.x + b.w; x += 1) {
          const p = shot.at(x, y);
          if (lum(p) > lum(best)) best = p;
        }
      }
      const fundo = shot.at(Math.round(b.x) - 4, Math.round(b.y + b.h / 2));
      icones.push({ item: b.item, ativo: b.ativo, maisClaro: best, luma: Math.round(0.299 * best[0] + 0.587 * best[1] + 0.114 * best[2]), fundo, contraste: ratio(best, fundo) });
    }
    report.menu.icones = icones;
    report.menu.contrastes = { ...contrastes, iconeMinimo: Math.min(...icones.map((i) => i.contraste)) };
    check(icones.length >= 10, `(c) ${icones.length} ícones amostrados`);
    check(icones.every((i) => i.luma > 180 && i.contraste >= 3), `(c) todos os ícones claros (luma mín ${Math.min(...icones.map((i) => i.luma))}, contraste mín ${report.menu.contrastes.iconeMinimo}:1, ativo incluso)`);
    await page.screenshot({ path: join(OUT, 'depois-1440-menu-expandido.png'), clip: { x: 0, y: 0, width: 520, height: 900 } });

    // Hover
    const hoverTarget = page.locator('#ds-shell-nav .ds-shell-nav__link:not(.ds-shell-nav__link--active)').nth(2);
    await hoverTarget.hover();
    await page.waitForTimeout(200);
    const hover = await hoverTarget.evaluate((el) => ({ item: el.textContent.trim(), fundo: getComputedStyle(el).backgroundColor, cor: getComputedStyle(el).color }));
    check(hover.fundo === 'rgb(38, 38, 38)' && hover.fundo !== colors.ativo.fundo, `hover "${hover.item}" fundo ${hover.fundo} (≠ ativo ${colors.ativo.fundo})`);
    hover.contraste = ratio(parseRgb(hover.cor), parseRgb(hover.fundo));
    check(hover.contraste >= 4.5, `(b) texto no hover ${hover.contraste}:1`);
    const hoverIcon = await hoverTarget.locator('.ds-shell-nav__icon').boundingBox();
    const hs = await pixels(await page.screenshot({ clip: hoverIcon }));
    let hb = [0, 0, 0];
    for (let y = 0; y < hs.info.height; y += 1) for (let x = 0; x < hs.info.width; x += 1) if (lum(hs.at(x, y)) > lum(hb)) hb = hs.at(x, y);
    hover.icone = { maisClaro: hb, contraste: ratio(hb, parseRgb(hover.fundo)) };
    check(hover.icone.contraste >= 3, `(c) ícone no hover ${hover.icone.contraste}:1`);
    report.menu.hover = hover;
    await page.screenshot({ path: join(OUT, 'depois-1440-menu-hover.png'), clip: { x: 0, y: 0, width: 520, height: 500 } });
    await page.mouse.move(900, 500);

    // Foco por teclado: Tab até um item do menu
    await page.locator('#ds-shell-nav a').first().focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);
    const focus = await page.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      return { item: el.textContent.trim(), dentroDoMenu: !!el.closest('#ds-shell-nav'), focusVisible: el.matches(':focus-visible'), outline: `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}`, cor: cs.outlineColor, fundo: getComputedStyle(el).backgroundColor };
    });
    const focusBg = focus.fundo === 'rgba(0, 0, 0, 0)' ? colors.menu : focus.fundo;
    focus.contraste = ratio(parseRgb(focus.cor), parseRgb(focusBg));
    check(focus.dentroDoMenu && focus.focusVisible && focus.outline.startsWith('2px solid') && focus.cor === 'rgb(255, 255, 255)' && focus.contraste >= 3, `(b) foco no menu "${focus.item}": ${focus.outline} (${focus.contraste}:1)`);
    report.menu.foco = focus;
    await page.screenshot({ path: join(OUT, 'depois-1440-menu-foco.png'), clip: { x: 0, y: 0, width: 520, height: 500 } });
    // Foco no painel claro continua azul
    const panelFocus = await page.evaluate(() => {
      const b = document.querySelector('.ds-shell-main__content button, .ds-shell-main__content a[href]');
      if (!b) return null;
      b.focus();
      return getComputedStyle(b).outlineColor;
    });
    report.menu.focoNoPainel = panelFocus;
    await ctx.close();
  }

  // 2b) Cabeçalho: ícones (lupa, loja) claros pelo tema escuro parcial; NADA mais muda.
  //     "Antes" = mesma página com a classe do tema removida do <header> em tempo de execução.
  {
    const { ctx, page } = await newPage(browser, { width: 1440, height: 900 });
    await open(page, '/products');
    await page.waitForFunction(() => customElements.get('s-icon') !== undefined, null, { timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    const THEME = 'p-partial-theme-admin-next-dark';
    const setTheme = (on) =>
      page.evaluate(([t, o]) => document.querySelector('[data-testid="shell-topbar"]').classList.toggle(t, o), [THEME, on]);
    const PROPS = ['color', 'backgroundColor', 'borderTopColor', 'borderBottomColor', 'boxShadow', 'outlineColor', 'fontFamily', 'fontSize', 'fontWeight', 'colorScheme', 'opacity', 'width', 'height'];
    // estilos computados de tudo no cabeçalho (inclui popovers/diálogo abertos), exceto o interior dos s-icon
    const snapshot = () =>
      page.evaluate((props) => {
        const out = {};
        const root = document.querySelector('[data-testid="shell-topbar"]');
        [root, ...root.querySelectorAll('*')].forEach((el, i) => {
          const cs = getComputedStyle(el);
          const cls = [...el.classList].filter((c) => c !== 'p-partial-theme-admin-next-dark').join('.');
          out[`${i}:${el.tagName.toLowerCase()}.${cls}`] = props.map((k) => cs[k]).join('|');
        });
        return out;
      }, PROPS);
    const diff = (a, b) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);
    const headerShot = (clip) => page.screenshot({ clip });
    const pxDiff = async (a, b, ignore = []) => {
      const A = await pixels(a);
      const B = await pixels(b);
      let n = 0;
      for (let y = 0; y < A.info.height; y += 1) {
        for (let x = 0; x < A.info.width; x += 1) {
          if (ignore.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) continue;
          if (!same(A.at(x, y), B.at(x, y), 0)) n += 1;
        }
      }
      return n;
    };
    const iconRects = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="shell-topbar"] s-icon')].map((el) => {
          const r = el.getBoundingClientRect();
          return { tipo: el.getAttribute('type'), x: Math.floor(r.x) - 1, y: Math.floor(r.y) - 1, w: Math.ceil(r.width) + 2, h: Math.ceil(r.height) + 2 };
        }),
      );
    const measureIcons = async () => {
      const shot = await pixels(await page.screenshot());
      const res = [];
      for (const b of await iconRects()) {
        const fundo = shot.at(b.x + 1, b.y + 1);
        let best = fundo;
        for (let y = b.y + 1; y < b.y + b.h - 1; y += 1) for (let x = b.x + 1; x < b.x + b.w - 1; x += 1) if (ratio(shot.at(x, y), fundo) > ratio(best, fundo)) best = shot.at(x, y);
        res.push({ tipo: b.tipo, pixelDoIcone: best, fundo, contraste: ratio(best, fundo) });
      }
      return res;
    };
    const hdr = { x: 0, y: 0, width: 1440, height: 56 };
    report.cabecalho = { estados: {} };
    await setTheme(false);
    const iconsBefore = await measureIcons();
    const shotBefore = await headerShot(hdr);
    await setTheme(true);
    const iconsAfter = await measureIcons();
    const shotAfter = await headerShot(hdr);
    report.cabecalho.icones = { antes: iconsBefore, depois: iconsAfter };
    for (const i of iconsAfter) check(i.contraste >= 3 && lum(i.pixelDoIcone) > lum([180, 180, 180]), `cabeçalho: ícone "${i.tipo}" claro ${JSON.stringify(i.pixelDoIcone)} sobre ${JSON.stringify(i.fundo)} = ${i.contraste}:1 (antes ${iconsBefore.find((b) => b.tipo === i.tipo)?.contraste}:1)`);
    check(iconsAfter.length >= 2, `cabeçalho: ${iconsAfter.length} ícones medidos (${iconsAfter.map((i) => i.tipo).join(', ')})`);
    const rects = await iconRects();
    const changedOutsideIcons = await pxDiff(shotBefore, shotAfter, rects);
    report.cabecalho.pixelsDiferentesForaDosIcones = changedOutsideIcons;
    check(changedOutsideIcons === 0, `cabeçalho: 0 pixels diferentes fora dos ícones (${changedOutsideIcons})`);
    await page.screenshot({ path: join(OUT, 'depois-1440-cabecalho.png'), clip: hdr });

    // Busca em foco: o campo fica branco e a lupa volta ao tom escuro de antes
    await page.getByTestId('shell-search-input').focus();
    await page.waitForTimeout(250);
    const focoDepois = (await measureIcons()).find((i) => i.tipo === 'search');
    await setTheme(false);
    await page.waitForTimeout(100);
    const focoAntes = (await measureIcons()).find((i) => i.tipo === 'search');
    await setTheme(true);
    report.cabecalho.lupaComBuscaEmFoco = { antes: focoAntes, depois: focoDepois };
    check(focoDepois.contraste >= 3 && same(focoDepois.pixelDoIcone, focoAntes.pixelDoIcone, 3), `cabeçalho: lupa com a busca em foco ${JSON.stringify(focoDepois.pixelDoIcone)} sobre ${JSON.stringify(focoDepois.fundo)} = ${focoDepois.contraste}:1 (antes ${JSON.stringify(focoAntes.pixelDoIcone)}, ${focoAntes.contraste}:1)`);
    await page.screenshot({ path: join(OUT, 'depois-1440-cabecalho-busca-foco.png'), clip: hdr });
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(200);

    // Estados abertos: seletor de loja, busca com resultados, menu do usuário, diálogo de nova loja.
    const states = [
      ['popover-loja', async () => page.locator('.ds-shell-store__trigger').click(), async () => page.keyboard.press('Escape'), { x: 0, y: 0, width: 640, height: 320 }],
      ['busca', async () => { await page.getByTestId('shell-search-input').fill('Pro'); await page.waitForTimeout(900); }, async () => { await page.getByTestId('shell-search-input').fill(''); await page.keyboard.press('Escape'); }, { x: 400, y: 0, width: 760, height: 420 }],
      ['menu-usuario', async () => page.locator('.ds-shell-user__trigger').click(), async () => page.keyboard.press('Escape'), { x: 1100, y: 0, width: 340, height: 200 }],
      ['dialogo-nova-loja', async () => { await page.locator('.ds-shell-store__trigger').click(); await page.locator('.ds-shell-popover__footer button.ds-shell-menu-item').first().click(); await page.locator('.ds-shell-dialog').waitFor({ timeout: 5000 }); await page.waitForTimeout(300); }, async () => page.keyboard.press('Escape'), { x: 420, y: 200, width: 600, height: 500 }],
    ];
    for (const [name, openIt, closeIt, clip] of states) {
      await openIt();
      await page.waitForTimeout(400);
      await setTheme(false);
      const a = await snapshot();
      const sa = await headerShot(clip);
      await setTheme(true);
      const b = await snapshot();
      const sb = await headerShot(clip);
      const d = diff(a, b);
      const ignore = (await iconRects()).map((r) => ({ ...r, x: r.x - clip.x, y: r.y - clip.y }));
      const px = await pxDiff(sa, sb, ignore);
      report.cabecalho.estados[name] = { elementos: Object.keys(b).length, estilosDiferentes: d.map((k) => ({ el: k, antes: a[k], depois: b[k] })), pixelsDiferentesForaDosIcones: px };
      if (d.length) console.log(JSON.stringify(report.cabecalho.estados[name].estilosDiferentes.slice(0, 4)));
      check(d.length === 0 && px === 0, `cabeçalho/${name}: ${Object.keys(b).length} elementos, 0 estilos e 0 pixels diferentes fora dos ícones (estilos ${d.length}, pixels ${px})`);
      await page.screenshot({ path: join(OUT, `depois-1440-cabecalho-${name}.png`), clip });
      await closeIt();
      await page.waitForTimeout(300);
    }
    await ctx.close();
  }

  // 3) Cantos, faixa direita, rodapé, elementFromPoint (1440, 1280, 1920)
  report.cantos = {};
  for (const [w, h] of SIZES) {
    const { ctx, page } = await newPage(browser, { width: w, height: h });
    await open(page, '/products');
    await hideContent(page, true);
    const px = await pixels(await page.screenshot());
    const L = 240;
    const T = 56;
    const R = w - 8; // primeira coluna da faixa direita
    const B = h;
    const corners = {
      supEsq: { canto: px.at(L, T), dentro: px.at(L + 13, T + 13) },
      supDir: { canto: px.at(R - 1, T), dentro: px.at(R - 14, T + 13) },
      infEsq: { canto: px.at(L, B - 1), dentro: px.at(L + 13, B - 14) },
      infDir: { canto: px.at(R - 1, B - 1), dentro: px.at(R - 14, B - 14) },
    };
    const black = [26, 26, 26];
    const panel = [241, 241, 241];
    const radius = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="shell-frame"]')).borderRadius);
    const faixa = { x: w - 4, cor: px.at(w - 4, 400), largura: 8 };
    // canto reto antigo: o pixel colado no encontro cabeçalho/menu agora é preto
    const ok = Object.values(corners).every((c) => same(c.canto, black) && same(c.dentro, panel));
    report.cantos[w] = { raio: radius, ...corners, faixaDireita: faixa };
    check(ok && radius === '12px', `(d) ${w}: 4 cantos com raio ${radius} (canto = preto, 13 px para dentro = painel) ${JSON.stringify(corners)}`);
    check(same(faixa.cor, black), `(e) ${w}: faixa direita de 8 px preta (${faixa.cor})`);
    await hideContent(page, false);
    if (w === 1440) {
      const z = await pixels(await page.screenshot({ clip: { x: 0, y: 0, width: 400, height: 220 }, scale: 'device' }));
      report.cantos.amostraCantoSupEsq = { x240y56: z.at(240, 56), x245y58: z.at(245, 58), x252y68: z.at(252, 68) };
    }
    // (g) clique nos cantos atravessa a moldura
    const efp = await page.evaluate(
      ([pts]) =>
        pts.map(([x, y]) => {
          const el = document.elementFromPoint(x, y);
          return { x, y, el: el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${[...el.classList].slice(0, 2).join('.')}` : null, moldura: !!el?.closest('[data-testid="shell-frame"]') };
        }),
      [[[241, 57], [w - 10, 57], [241, h - 2], [w - 10, h - 2], [Math.round(w / 2), Math.round(h / 2)]]],
    );
    report.cantos[w].elementFromPoint = efp;
    check(efp.every((e) => !e.moldura && e.el), `(g) ${w}: elementFromPoint nos cantos nunca é a moldura (${efp.map((e) => e.el).join(' | ')})`);
    await ctx.close();
  }

  // 4) Rolagem, sticky e barra do rodapé (antes × depois = moldura desligada × ligada)
  {
    const { ctx, page } = await newPage(browser, { width: 1440, height: 900 });
    const frameOff = (off) =>
      page.evaluate((o) => {
        let s = document.getElementById('e2e-frame-off');
        if (o && !s) {
          s = document.createElement('style');
          s.id = 'e2e-frame-off';
          // "antes" = sem moldura e sem a margem direita nova (CSS de origin/main)
          s.textContent = '.ds-shell-frame{display:none!important}.ds-shell-main{padding-right:0!important}';
          document.head.appendChild(s);
        }
        if (!o && s) s.remove();
      }, off);
    report.rolagem = {};
    for (const path of ['/', '/products', '/orders']) {
      await open(page, path);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.mouse.move(800, 500);
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(400);
      const y1 = await page.evaluate(() => window.scrollY);
      await page.keyboard.press('PageDown');
      await page.waitForTimeout(400);
      const y2 = await page.evaluate(() => window.scrollY);
      await page.keyboard.press('Control+End');
      await page.waitForTimeout(400);
      const y3 = await page.evaluate(() => ({ y: window.scrollY, max: document.documentElement.scrollHeight - window.innerHeight }));
      report.rolagem[path] = { roda: y1, pageDown: y2, ctrlEnd: y3 };
      const scrollable = y3.max > 0;
      check(!scrollable || (y1 > 0 && y2 >= y1 && Math.abs(y3.y - y3.max) <= 1), `(f) ${path}: janela rola (roda ${y1}, PageDown ${y2}, Ctrl+End ${y3.y}/${y3.max})`);
    }
    // Next volta ao topo ao trocar de rota
    await open(page, '/products');
    await page.evaluate(() => window.scrollTo(0, 800));
    await page.locator('#ds-shell-nav').getByRole('link', { name: 'Pedidos', exact: true }).click();
    await page.waitForURL('**/orders');
    await page.waitForTimeout(600);
    report.rolagem.trocaDeRota = await page.evaluate(() => window.scrollY);
    check(report.rolagem.trocaDeRota === 0, `(f) trocar de rota volta ao topo (scrollY ${report.rolagem.trocaDeRota})`);

    // Barra do TrustShield (sticky top: 0) — real
    await open(page, '/trustshield/inbox');
    const measureSticky = () =>
      page.evaluate(() => {
        const el = [...document.querySelectorAll('.ds-shell-main__content *')].find((n) => getComputedStyle(n).position === 'sticky');
        return el ? { top: Math.round(el.getBoundingClientRect().top * 10) / 10, scrollY: window.scrollY, max: document.documentElement.scrollHeight - innerHeight } : null;
      });
    await frameOff(true);
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(200);
    const tsBefore = await measureSticky();
    await frameOff(false);
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(200);
    const tsAfter = await measureSticky();
    report.rolagem.trustshieldSticky = { antes: tsBefore, depois: tsAfter };
    check(tsBefore && tsAfter && Math.abs(tsBefore.top - tsAfter.top) <= 1, `(f) barra sticky do TrustShield: top antes ${tsBefore?.top} × depois ${tsAfter?.top}`);
    await page.screenshot({ path: join(OUT, 'depois-1440-atendimento-rolado.png') });

    // Pré-visualização do EditWorkspace (sticky top: 16px) e barra do LandingPageForm (sticky bottom: 0):
    // as duas telas dependem do banco (server actions/Drizzle), ausente neste ambiente — reproduz o
    // MESMO estilo inline delas dentro do conteúdo real do shell (Produtos) para medir a geometria.
    for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await open(page, '/products');
    await page.evaluate(() => {
      const host = document.querySelector('.ds-shell-main__content');
      const wrap = document.createElement('div');
      wrap.id = 'e2e-landing';
      wrap.style.cssText = 'display:flex;gap:16px;padding:0 24px';
      wrap.innerHTML = `
        <div style="flex:1">
          <div style="height:1600px;background:#fff;border-radius:12px;padding:16px">Formulário (LandingPageForm embedded)</div>
          <div id="e2e-bottom-bar" style="position:sticky;bottom:0;margin-top:16px;padding:12px;background:#fff;border-top:1px solid #e1e3e5;display:flex;justify-content:space-between">
            <span><button id="e2e-bar-first">Duplicar</button> <button>Arquivar</button></span>
            <span><button>Cancelar</button> <button id="e2e-bar-last">Salvar</button></span>
          </div>
        </div>
        <div style="width:360px"><div id="e2e-preview" style="position:sticky;top:16px;height:400px;background:#fff;border-radius:12px">Preview</div></div>`;
      host.appendChild(wrap);
    });
    const measureLanding = () =>
      page.evaluate(() => {
        document.getElementById('e2e-landing').scrollIntoView({ block: 'start' });
        window.scrollBy(0, 500);
        const r = (id) => document.getElementById(id).getBoundingClientRect();
        const bar = r('e2e-bottom-bar');
        const first = r('e2e-bar-first');
        const last = r('e2e-bar-last');
        const hit = (b) => document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.id ?? null;
        return {
          preview: { top: Math.round(r('e2e-preview').top * 10) / 10 },
          barra: { top: Math.round(bar.top), bottom: Math.round(bar.bottom), left: Math.round(bar.left), right: Math.round(bar.right) },
          primeiroBotao: { left: Math.round(first.left), bottom: Math.round(first.bottom), clique: hit(first) },
          ultimoBotao: { right: Math.round(last.right), bottom: Math.round(last.bottom), clique: hit(last) },
          innerHeight: innerHeight,
          innerWidth: innerWidth,
        };
      });
    await frameOff(true);
    await page.waitForTimeout(100);
    const lpBefore = await measureLanding();
    await frameOff(false);
    await page.waitForTimeout(100);
    const lpAfter = await measureLanding();
    report.rolagem[`landing-${w}`] = { antes: lpBefore, depois: lpAfter, nota: 'reprodução do estilo inline de EditWorkspace.tsx:634 e LandingPageForm.tsx:827-830 (telas dependem do banco)' };
    check(Math.abs(lpBefore.preview.top - lpAfter.preview.top) <= 1, `(f) ${w}: pré-visualização sticky top:16px: antes ${lpBefore.preview.top} × depois ${lpAfter.preview.top}`);
    check(lpAfter.barra.bottom === lpAfter.innerHeight, `(e) ${w}: barra do rodapé encosta no fim da janela (bottom ${lpAfter.barra.bottom} = ${lpAfter.innerHeight}) — nada da moldura embaixo`);
    // distância dos botões ao arco de 12 px dos cantos inferiores (≥ 4 px)
    const arcGap = (bx, by, cx, cy) => Math.round((12 - Math.hypot(Math.max(0, cx - bx), Math.max(0, by - cy))) * -1 * 10) / 10;
    const gapFirst = lpAfter.primeiroBotao.left - 240 >= 16 || lpAfter.innerHeight - lpAfter.primeiroBotao.bottom >= 16 ? 'fora do quadrado do arco' : arcGap(lpAfter.primeiroBotao.left, lpAfter.primeiroBotao.bottom, 252, lpAfter.innerHeight - 12);
    report.rolagem[`landing-${w}`].botoesNoArco = { primeiro: gapFirst };
    check(lpAfter.primeiroBotao.clique === 'e2e-bar-first' && lpAfter.ultimoBotao.clique === 'e2e-bar-last', `(e) ${w}: botões das pontas da barra clicáveis (${lpAfter.primeiroBotao.clique}, ${lpAfter.ultimoBotao.clique}); primeiro botão ${gapFirst}`);
    await page.screenshot({ path: join(OUT, `depois-${w}-landing-barra-inferior.png`) });
    }
    await ctx.close();
  }

  // 5) Camadas: modal DS cobre a moldura; popover do cabeçalho por cima
  {
    const { ctx, page } = await newPage(browser, { width: 1440, height: 900 });
    await open(page, '/products');
    await page.waitForTimeout(800);
    let modal = null;
    try {
      // s-checkbox/s-button são Web Components: marca e clica pelas propriedades/eventos deles
      await page.evaluate(() => {
        const cb = document.querySelector('.ds-shell-main__content s-checkbox[label="Selecionar Produto de teste 1"]');
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('s-button')].find((b) => b.textContent.trim() === 'Excluir 1 selecionado');
        if (!btn) throw new Error('botão Excluir 1 selecionado não apareceu');
        btn.click();
      });
      await page.waitForTimeout(800);
      const px = await pixels(await page.screenshot());
      modal = await page.evaluate(() => {
        const d = document.querySelector('s-modal');
        const dlg = d?.shadowRoot?.querySelector('dialog') ?? document.querySelector('dialog[open]');
        const top = document.elementFromPoint(245, 60);
        return { aberto: !!(dlg?.open ?? d?.hasAttribute('open')), noCanto: top ? top.tagName.toLowerCase() : null, molduraNoCanto: !!top?.closest('[data-testid="shell-frame"]') };
      });
      modal.pixelCantoSupEsq = px.at(240, 56);
      modal.pixelPainelMeio = px.at(700, 120);
      await page.screenshot({ path: join(OUT, 'depois-1440-modal-excluir.png') });
    } catch (e) {
      modal = { erro: String(e).slice(0, 200) };
    }
    report.camadas = { modal };
    // painel escurecido pelo backdrop e o canto (preto) também escurecido = modal por cima da moldura
    check(modal && modal.aberto && lum(modal.pixelCantoSupEsq) < lum([26, 26, 26]) && lum(modal.pixelPainelMeio) < lum([241, 241, 241]), `(h) modal de excluir cobre a tela inteira, cantos inclusos (${JSON.stringify(modal)})`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await page.locator('[data-testid="shell-topbar"] button').filter({ hasText: 'Default Store' }).first().click().catch(() => undefined);
    await page.waitForTimeout(300);
    const pop = await page.evaluate(() => {
      const p = [...document.querySelectorAll('.ds-shell-popover')].find((n) => n.getBoundingClientRect().height > 0);
      if (!p) return null;
      const r = p.getBoundingClientRect();
      const el = document.elementFromPoint(r.x + 10, r.bottom - 6);
      return { z: getComputedStyle(p).zIndex, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], porCima: !!el && p.contains(el) };
    });
    report.camadas.popoverCabecalho = pop;
    check(pop && pop.porCima, `(9b) popover do seletor de loja por cima da moldura (${JSON.stringify(pop)})`);
    await page.screenshot({ path: join(OUT, 'depois-1440-popover-loja.png') });
    await ctx.close();
  }

  // 6) Celular 390 px: gaveta fechada/aberta, sem rolagem horizontal, cantos de cima
  {
    const { ctx, page } = await newPage(browser, { width: 390, height: 844 });
    await open(page, '/products');
    await hideContent(page, true);
    const px = await pixels(await page.screenshot());
    await hideContent(page, false);
    const m = await page.evaluate(() => {
      const f = document.querySelector('[data-testid="shell-frame"]');
      const r = f.getBoundingClientRect();
      return { moldura: [r.left, r.top, r.right, r.bottom], raio: getComputedStyle(f).borderRadius, rolagemHorizontal: document.documentElement.scrollWidth > innerWidth };
    });
    m.cantos = { supEsq: px.at(0, 56), supEsqDentro: px.at(13, 69), supDir: px.at(389, 56), infEsq: px.at(0, 843), infDir: px.at(389, 843) };
    report.celular = m;
    check(!m.rolagemHorizontal, '(i) 390: sem rolagem horizontal');
    check(m.raio === '12px 12px 0px 0px' && same(m.cantos.supEsq, [26, 26, 26]) && same(m.cantos.supEsqDentro, [241, 241, 241]) && same(m.cantos.infEsq, [241, 241, 241]), `390: só os 2 cantos de cima arredondados (${m.raio}, ${JSON.stringify(m.cantos)})`);
    await page.screenshot({ path: join(OUT, 'depois-390-gaveta-fechada.png') });
    await page.getByTestId('shell-nav-toggle').click();
    await page.waitForTimeout(400);
    const drawer = await page.evaluate(() => ({
      visivel: getComputedStyle(document.getElementById('ds-shell-nav')).visibility,
      fundo: getComputedStyle(document.getElementById('ds-shell-nav')).backgroundColor,
      rolagemHorizontal: document.documentElement.scrollWidth > innerWidth,
    }));
    report.celular.gaveta = drawer;
    check(drawer.visivel === 'visible' && drawer.fundo === 'rgb(26, 26, 26)' && !drawer.rolagemHorizontal, `390: gaveta aberta com fundo ${drawer.fundo}, sem rolagem horizontal`);
    await page.screenshot({ path: join(OUT, 'depois-390-gaveta-aberta.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const back = await page.evaluate(() => ({ foco: document.activeElement?.getAttribute('data-testid'), inert: document.getElementById('ds-shell-nav').hasAttribute('inert') || document.getElementById('ds-shell-nav').getAttribute('aria-hidden') }));
    report.celular.esc = back;
    check(back.foco === 'shell-nav-toggle', `390: Esc fecha e devolve o foco (${JSON.stringify(back)})`);
    await ctx.close();
  }

  // 7) Comparação lado a lado com o print da Shopify (mesma escala: largura da tela)
  {
    const ref = sharp(SHOPIFY);
    const meta = await ref.metadata();
    // O print da Shopify é de um monitor largo em densidade 1 (texto de 13 px e menu de ~215 px na
    // imagem): mesma escala = nosso print também em densidade 1; recorte do mesmo tamanho em px.
    const scale = 1;
    const { ctx, page } = await newPage(browser, { width: 1920, height: 1080, scale });
    await open(page, '/');
    const ours = await page.screenshot();
    await ctx.close();
    const cw = 560;
    const ch = 360;
    const left = await sharp(SHOPIFY).extract({ left: 0, top: 0, width: cw, height: Math.min(ch, meta.height) }).png().toBuffer();
    const right = await sharp(ours).extract({ left: 0, top: 0, width: cw, height: ch }).png().toBuffer();
    const gap = 24;
    await sharp({ create: { width: cw * 2 + gap, height: ch, channels: 3, background: '#ffffff' } })
      .composite([
        { input: left, left: 0, top: 0 },
        { input: right, left: cw + gap, top: 0 },
      ])
      .png()
      .toFile(join(OUT, 'comparacao-lado-a-lado.png'));
        report.comparacao = { referencia: 'docs/prints/onda-16/referencia-shopify-inicio.png', escala: scale, recortePx: [560, 360], nota: 'print da Shopify em densidade 1 (monitor largo); o nosso em 1920 css px, densidade 1', esquerda: 'Shopify', direita: 'BlackShop (20.14a)' };
    console.log('ok   comparacao-lado-a-lado.png (mesma escala, densidade 1)');
  }
} finally {
  await browser.close();
}

report.falhas = failures;
writeFileSync(join(OUT, 'depois-medicoes.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(failures.length === 0 ? '\nTUDO OK' : `\n${failures.length} falha(s)`);
process.exit(failures.length === 0 ? 0 : 1);
