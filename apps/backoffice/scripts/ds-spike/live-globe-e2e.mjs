/* eslint-env browser, node */
/* eslint-disable no-console */
// Story 21.2a-v3 (AC1–AC9, AC14) — globo do canto (CornerGlobe) no navegador
// real (Chromium/Playwright), padrão 20.5f / 21.2a: backoffice em `next start`,
// API em mock HTTP local, sessão = cookie `blackshop.sid`. Grava prints,
// `comparacao-globo.png` (recorte da Shopify × nossos recortes, gerado aqui) e
// `depois-medicoes.json`.
//
// Medições de pixel (AC1–AC4) num fundo BRANCO controlado pelo harness (C-1
// do @po): só nesta sessão, um estilo injetado põe `background: #fff` no
// Início/login e esconde o conteúdo por cima do globo. Os prints "como está"
// (fundo atual #f1f1f1) são gravados antes, sem estilo injetado.
// Login escuro (22.1b): estilo injetado com o fundo do login da Shopify
// (shopify-login-1440.png) + variante `dark` do CornerGlobe, só para os prints.
//
// Navegadores: com WebGL (SwiftShader) e sem WebGL (`--disable-gpu
// --disable-webgl --disable-webgl2`) — o v3 desenha em canvas 2D, então sem
// WebGL o globo continua igual; o fallback estático (sem canvas 2D) é forçado
// por script e medido à parte.
//
// Uso: BASE_URL=http://localhost:3047 node apps/backoffice/scripts/ds-spike/live-globe-e2e.mjs docs/prints/21.2a-v3

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const { chromium } = createRequire(join(repo, 'package.json'))('@playwright/test');

const BASE = process.env.BASE_URL ?? 'http://localhost:3047';
const OUT = resolve(process.argv[2] ?? 'docs/prints/21.2a-v3');
mkdirSync(join(OUT, 'frames'), { recursive: true });
mkdirSync(join(OUT, 'recortes'), { recursive: true });

const REF = join(repo, 'docs/prints/onda-16/recorte-globo-shopify.png');
// No recorte da Shopify (509 × 441) o painel começa em y = 6 e a borda direita fica em x = 503.
const REF_CORNER = { right: 503, top: 6 };
const REF_GEOMETRY = { cx: 486, cy: 81, r: 275, box: { l: 0, t: 7, r: 497, b: 441 }, skip: { l: 250, t: 0, r: 509, b: 55 } };
const ROTATION_SPEED = 0.0001; // LiveGlobeCanvas.tsx (rad/ms)

const WEBGL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const NO_WEBGL_ARGS = ['--disable-gpu', '--disable-webgl', '--disable-webgl2'];
const WHITE_CSS =
  '.ds-live-home, .ds-shell-main, .ds-shell-main__content, .ds-live-login { background: #fff !important; }' +
  ' .ds-live-home__content, .ds-shell-notice, .ds-live-login__card { visibility: hidden !important; }';
const DARK_LOGIN_CSS =
  '.ds-live-login { background: radial-gradient(ellipse 60% 70% at 50% 50%, #1c2425 0%, #0b1415 50%, #03090a 100%) !important; }';

const failures = [];
const report = { base: BASE, geradoEm: new Date().toISOString(), navegador: null, referenciaShopify: null };
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  return ok;
};

// Conta chamadas de requestAnimationFrame (o globo é o único laço contínuo nestas telas).
const RAF_COUNTER = () => {
  window.__raf = 0;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => {
    window.__raf += 1;
    return raf(cb);
  };
};

// Login escuro: fundo do login da Shopify + variante escura (antes de o canvas ler os tokens).
const DARK_LOGIN = (css) => {
  new MutationObserver(() => {
    if (!document.getElementById('e2e-dark') && document.head) {
      const st = document.createElement('style');
      st.id = 'e2e-dark';
      st.textContent = css;
      document.head.appendChild(st);
    }
    const g = document.querySelector('.ds-corner-globe--light');
    if (g) {
      g.classList.replace('ds-corner-globe--light', 'ds-corner-globe--dark');
      g.setAttribute('data-variant', 'dark');
    }
  }).observe(document, { childList: true, subtree: true });
};

// Sem canvas 2D: força o fallback estático.
const NO_CANVAS = () => {
  delete window.CanvasRenderingContext2D;
  HTMLCanvasElement.prototype.getContext = () => null;
};

async function newPage(browser, { width, height = 900, reducedMotion = 'no-preference', scale = 1, dark = false, noCanvas = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion, deviceScaleFactor: scale });
  await ctx.addCookies([{ name: 'blackshop.sid', value: 'e2e', url: BASE }]);
  await ctx.addInitScript(RAF_COUNTER);
  if (dark) await ctx.addInitScript(DARK_LOGIN, DARK_LOGIN_CSS);
  if (noCanvas) await ctx.addInitScript(NO_CANVAS);
  const page = await ctx.newPage();
  // SwiftShader compõe o canvas animado devagar: prints podem levar vários segundos (ambiente, não o globo —
  // o laço gasta ~0,5 ms por quadro; sem as flags de GL o print leva ~50 ms).
  page.setDefaultTimeout(120000);
  const errors = [];
  const chunks = new Map();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
  page.on('response', async (r) => {
    const url = r.url();
    if (!url.includes('/_next/static/chunks/')) return;
    const body = await r.body().catch(() => null);
    if (body && body.includes('ds-live-globe__canvas')) chunks.set(url.split('/_next/static/chunks/')[1], { bytes: body.length, gzip: gzipSync(body, { level: 9 }).length });
  });
  return { ctx, page, errors, chunks };
}

const SCOPE = { login: '.ds-live-login', inicio: '.ds-live-home' };

async function open(page, where) {
  await page.goto(`${BASE}${where === 'login' ? '/login' : '/'}`, { waitUntil: 'networkidle' }).catch(() => undefined);
}

async function waitGlobe(page, where, states = ['ready']) {
  await page
    .waitForFunction(
      ([sel, ok]) => ok.includes(document.querySelector(`${sel} [data-testid="live-globe"]`)?.getAttribute('data-globe-state')),
      [SCOPE[where], states],
      { timeout: 20000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(900); // fade-in do canvas
}

/** Geometria (px CSS da viewport): contêiner do canto, esfera, canvas, estado. */
async function geometry(page, where) {
  return page.evaluate((sel) => {
    const wrap = document.querySelector(`${sel} [data-testid="corner-globe"]`);
    if (!wrap) return null;
    const root = wrap.querySelector('[data-testid="live-globe"]');
    const sphere = wrap.querySelector('.ds-live-globe__sphere');
    const w = wrap.getBoundingClientRect();
    const s = sphere.getBoundingClientRect();
    const rr = (r) => ({ l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) });
    const se = document.scrollingElement;
    const header = document.querySelector('.ds-shell-topbar')?.getBoundingClientRect();
    const main = document.querySelector('.ds-shell-main__content')?.getBoundingClientRect();
    const cs = getComputedStyle(wrap);
    const sx = s.left + s.width / 2;
    const sy = s.top + s.height / 2;
    return {
      display: cs.display,
      overflow: cs.overflow,
      transform: cs.transform,
      state: root.getAttribute('data-globe-state'),
      motion: root.querySelector('.ds-live-globe__host')?.getAttribute('data-globe-motion') ?? null,
      canvas: !!root.querySelector('canvas'),
      variant: wrap.getAttribute('data-variant'),
      container: rr(w),
      sphere: rr(s),
      diametro: +s.width.toFixed(1),
      centroDaDireita: +(w.right - sx).toFixed(1),
      centroDoTopo: +(sy - w.top).toFixed(1),
      cortadaEmCimaEDireita: s.top < w.top && s.right > w.right,
      rolagemHorizontal: se.scrollWidth > window.innerWidth,
      rolagemVertical: se.scrollHeight > window.innerHeight,
      larguraViewport: window.innerWidth,
      baseHeader: header ? Math.round(header.bottom) : null,
      direitaConteudo: main ? Math.round(main.right) : null,
    };
  }, SCOPE[where]);
}

/** Clique no globo atinge o conteúdo; Tab nunca passa por ele. */
async function inertChecks(page, where, geo) {
  const sel = `${SCOPE[where]} [data-testid="corner-globe"]`;
  const out = {};
  const x = geo.container.r - 60;
  const y = geo.container.t + 120;
  out.elementFromPoint = await page.evaluate(
    ([px, py, s]) => {
      const el = document.elementFromPoint(px, py);
      return el ? (el.closest(s) ? 'globo' : `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`) : null;
    },
    [x, y, sel],
  );
  out.pointerEvents = await page.evaluate((s) => getComputedStyle(document.querySelector(s)).pointerEvents, sel);
  out.ariaHidden = await page.evaluate((s) => document.querySelector(s).getAttribute('aria-hidden'), sel);
  const tabStops = [];
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab');
    tabStops.push(await page.evaluate((s) => (document.activeElement?.closest(s) ? 'globo' : document.activeElement?.tagName), sel));
  }
  out.tabStops = tabStops;
  return out;
}

/** Conteúdo coberto pelo globo? (texto e botões do Início/login acima dele) */
async function contentOnTop(page, where) {
  return page.evaluate((sel) => {
    const wrap = document.querySelector(`${sel} [data-testid="corner-globe"]`).getBoundingClientRect();
    const items = [...document.querySelectorAll(`${sel} button, ${sel} a, ${sel} h1, ${sel} input`)].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > wrap.left && r.left < wrap.right && r.bottom > wrap.top && r.top < wrap.bottom;
    });
    const covered = items.filter((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit && hit.closest('[data-testid="corner-globe"]');
    });
    return { naAreaDoGlobo: items.length, cobertos: covered.length };
  }, SCOPE[where]);
}

async function loginCard(page) {
  return page.evaluate(() => {
    const g = document.querySelector('.ds-live-login [data-testid="corner-globe"]')?.getBoundingClientRect();
    const card = document.querySelector('.ds-live-login__card form')?.getBoundingClientRect();
    const inter = (a, b) =>
      a && b ? Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) : null;
    return {
      cartao: card && { x: Math.round(card.x), y: Math.round(card.y), w: Math.round(card.width), h: Math.round(card.height) },
      intersecaoGloboCartao: g && g.width > 0 ? Math.round(inter(g, card)) : 0,
      focoInicialNaSenha: document.activeElement?.id === 'password',
    };
  });
}

async function rafDelta(page, ms) {
  const a = await page.evaluate(() => window.__raf);
  await page.waitForTimeout(ms);
  const b = await page.evaluate(() => window.__raf);
  return b - a;
}

/** Pontos de terra (mesma grade de components/live/dot-globe.ts), para achar o ângulo de cada quadro. */
const LAND = (() => {
  const d = JSON.parse(readFileSync(join(here, '../../src/components/live/land-dots.json'), 'utf8'));
  const bin = Buffer.from(d.data, 'base64');
  const out = [];
  const count = Math.round(180 / d.step);
  let k = 0;
  for (let i = 0; i < count; i += 1) {
    const lat = ((-90 + (i + 0.5) * (180 / count)) * Math.PI) / 180;
    const n = Math.max(1, Math.round((360 * Math.cos(lat)) / d.step));
    const shift = i % 2 ? 0.5 : 0;
    for (let j = 0; j < n; j += 1, k += 1) {
      if (!((bin[k >> 3] >> (k & 7)) & 1)) continue;
      const lon = -Math.PI + ((j + 0.5 + shift) * 2 * Math.PI) / n;
      out.push(+(Math.cos(lat) * Math.sin(lon)).toFixed(5), +Math.sin(lat).toFixed(5), +(Math.cos(lat) * Math.cos(lon)).toFixed(5));
    }
  }
  return out;
})();

/**
 * Ângulo de rotação (φ) de um quadro: projeta a grade de terra (mesma conta do
 * dot-globe.ts) e escolhe o φ em que mais pontos caem sobre pixels escuros.
 */
async function fitPhi(b64, local) {
  return ana.evaluate(
    async ([png, g, dots]) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const x = c.getContext('2d');
      x.drawImage(bmp, 0, 0);
      const { data, width: W, height: H } = x.getImageData(0, 0, c.width, c.height);
      const dark = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i += 1) dark[i] = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3 < 200 ? 1 : 0;
      const ct = Math.cos(g.theta);
      const st = Math.sin(g.theta);
      const score = (phi) => {
        const cp = Math.cos(phi);
        const sp = Math.sin(phi);
        let hit = 0;
        let n = 0;
        for (let d = 0; d < dots.length; d += 3) {
          const x1 = dots[d] * cp + dots[d + 2] * sp;
          const z1 = dots[d + 2] * cp - dots[d] * sp;
          const y2 = dots[d + 1] * ct - z1 * st;
          if (dots[d + 1] * st + z1 * ct <= 0.25) continue;
          const px = Math.floor(g.cx + g.r * x1);
          const py = Math.floor(g.cy - g.r * y2);
          if (px < 1 || py < 1 || px >= W - 1 || py >= H - 1) continue;
          n += 1;
          if (dark[py * W + px] || dark[py * W + px + 1] || dark[(py + 1) * W + px] || dark[py * W + px - 1] || dark[(py - 1) * W + px]) hit += 1;
        }
        return n > 50 ? hit / n : 0;
      };
      let best = { phi: 0, s: -1 };
      for (let phi = 0; phi < Math.PI * 2; phi += 0.01) {
        const s = score(phi);
        if (s > best.s) best = { phi, s };
      }
      const c0 = best.phi;
      for (let phi = c0 - 0.012; phi <= c0 + 0.012; phi += 0.0005) {
        const s = score(phi);
        if (s > best.s) best = { phi, s };
      }
      return { phi: +best.phi.toFixed(4), acerto: +best.s.toFixed(3) };
    },
    [b64, local, LAND],
  );
}

/** 3 quadros em ~1,4 s (700 ms entre eles) + ângulo de cada um → graus por segundo medidos. */
async function frames(page, where, name, geo) {
  const clip = { x: geo.container.l, y: Math.max(0, geo.container.t), width: geo.container.w, height: geo.container.h };
  // conteúdo por cima escondido só durante os quadros (não se move e atrapalharia o ajuste do ângulo)
  const hide = await page.addStyleTag({ content: '.ds-live-home__content, .ds-shell-notice, .ds-live-login__card { visibility: hidden !important; }' });
  const theta = await page.evaluate((sel) => Number.parseFloat(getComputedStyle(document.querySelector(`${sel} .ds-live-globe`)).getPropertyValue('--ds-live-globe-theta')), SCOPE[where]);
  const shots = [];
  const times = [];
  for (let i = 0; i < 3; i += 1) {
    const t0 = Date.now();
    const png = await page.screenshot({ clip });
    times.push((t0 + Date.now()) / 2);
    writeFileSync(join(OUT, 'frames', `${name}-${i}.png`), png);
    shots.push(png.toString('base64'));
    if (i < 2) await page.waitForTimeout(700);
  }
  await hide.evaluate((el) => el.remove());
  const local = { cx: geo.sphere.l + geo.sphere.w / 2 - clip.x, cy: geo.sphere.t + geo.sphere.h / 2 - clip.y, r: geo.sphere.w / 2, theta };
  const fits = [];
  for (const b64 of shots) fits.push(await fitPhi(b64, local));
  const seconds = (times[2] - times[0]) / 1000;
  const grausPorSegundoMedido = +((((fits[2].phi - fits[0].phi) / seconds) * 180) / Math.PI).toFixed(2);
  return {
    framesDistintos: new Set(shots).size,
    total: 3,
    intervaloS: +seconds.toFixed(2),
    phiPorQuadro: fits,
    grausPorSegundoMedido,
    grausPorSegundoConstante: +((ROTATION_SPEED * 1000 * 180) / Math.PI).toFixed(2),
  };
}

/**
 * Medições de pixel (AC1–AC4) num PNG com a esfera em (cx, cy, r) e a área
 * visível `box` (coordenadas do PNG). Luminância = média RGB (0–255).
 */
async function pixelStats(page, b64, g) {
  return page.evaluate(
    async ([png, geo]) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const { data, width: W, height: H } = ctx.getImageData(0, 0, c.width, c.height);
      const { cx, cy, r, box, skip } = geo;
      const inBox = (x, y) => x >= Math.max(0, box.l) && x < Math.min(W, box.r) && y >= Math.max(0, box.t) && y < Math.min(H, box.b) && !(skip && x >= skip.l && x < skip.r && y >= skip.t && y < skip.b);
      const L = (x, y) => {
        const i = (y * W + x) * 4;
        return (data[i] + data[i + 1] + data[i + 2]) / 3;
      };
      const rgb = (x, y) => {
        const i = (y * W + x) * 4;
        return [data[i], data[i + 1], data[i + 2]];
      };
      const dist = (x, y) => Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      // máscara de pontos (dentro da esfera) e vizinhança de 2 px
      const dot = new Uint8Array(W * H);
      for (let y = 0; y < H; y += 1)
        for (let x = 0; x < W; x += 1) if (inBox(x, y) && dist(x, y) < r && L(x, y) < 215) dot[y * W + x] = 1;
      const near = new Uint8Array(W * H);
      for (let y = 0; y < H; y += 1)
        for (let x = 0; x < W; x += 1) {
          if (!dot[y * W + x]) continue;
          for (let dy = -2; dy <= 2; dy += 1)
            for (let dx = -2; dx <= 2; dx += 1) {
              const xx = x + dx;
              const yy = y + dy;
              if (xx >= 0 && yy >= 0 && xx < W && yy < H) near[yy * W + xx] = 1;
            }
        }
      const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
      const interior = [];
      const edge = [];
      let satSum = 0;
      let satN = 0;
      const ringsOut = new Map();
      for (let y = 0; y < H; y += 1)
        for (let x = 0; x < W; x += 1) {
          if (!inBox(x, y)) continue;
          const d = dist(x, y);
          if (d < r) {
            const [R, G, B] = rgb(x, y);
            satSum += (Math.max(R, G, B) - Math.min(R, G, B)) / 255;
            satN += 1;
          }
          if (near[y * W + x]) continue;
          if (d < r * 0.9) interior.push(L(x, y));
          else if (d >= r - 5 && d < r - 1) edge.push(L(x, y));
          else if (d >= r + 8 && d <= r + 40) {
            const k = Math.floor((d - r - 8) / 4);
            if (!ringsOut.has(k)) ringsOut.set(k, []);
            ringsOut.get(k).push(L(x, y));
          }
        }
      // silhueta: linhas radiais (r−6 … r+6) longe dos pontos; maior salto entre vizinhos
      let maxJump = 0;
      let lines = 0;
      for (let a = 0; a < 360; a += 1) {
        const rad = (a * Math.PI) / 180;
        const pts = [];
        let ok = true;
        for (let d = r - 6; d <= r + 6; d += 1) {
          const x = Math.floor(cx + d * Math.cos(rad));
          const y = Math.floor(cy + d * Math.sin(rad));
          if (!inBox(x, y) || near[y * W + x]) {
            ok = false;
            break;
          }
          pts.push(L(x, y));
        }
        if (!ok) continue;
        lines += 1;
        for (let i = 1; i < pts.length; i += 1) maxJump = Math.max(maxJump, Math.abs(pts[i] - pts[i - 1]));
      }
      // pontos: componentes conexos
      const seen = new Uint8Array(W * H);
      const comps = [];
      let minDot = 255;
      let minRgb = null;
      for (let y = 0; y < H; y += 1)
        for (let x = 0; x < W; x += 1) {
          const i0 = y * W + x;
          if (!dot[i0] || seen[i0]) continue;
          const stack = [i0];
          seen[i0] = 1;
          let area = 0;
          let mn = 255;
          while (stack.length) {
            const i = stack.pop();
            const px = i % W;
            const py = (i - px) / W;
            area += 1;
            const l = L(px, py);
            if (l < mn) mn = l;
            if (l < minDot) {
              minDot = l;
              minRgb = rgb(px, py);
            }
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const xx = px + dx;
              const yy = py + dy;
              const j = yy * W + xx;
              if (xx >= 0 && yy >= 0 && xx < W && yy < H && dot[j] && !seen[j]) {
                seen[j] = 1;
                stack.push(j);
              }
            }
          }
          comps.push({ area, mn });
        }
      const med = (a) => {
        const s = [...a].sort((p, q) => p - q);
        return s.length ? s[Math.floor(s.length / 2)] : null;
      };
      // área de continente: blocos 6×6 dentro da esfera com pelo menos 1 pixel de ponto
      const cont = [];
      for (let by = 0; by + 6 <= H; by += 6)
        for (let bx = 0; bx + 6 <= W; bx += 6) {
          let has = false;
          let sum = 0;
          let n = 0;
          for (let y = by; y < by + 6; y += 1)
            for (let x = bx; x < bx + 6; x += 1) {
              if (!inBox(x, y) || dist(x, y) >= r * 0.95) continue;
              if (dot[y * W + x]) has = true;
              sum += L(x, y);
              n += 1;
            }
          if (has && n === 36) cont.push(sum / n);
        }
      const srgb = (v) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      const interiorMean = mean(interior);
      const dotCore = med(comps.map((p) => p.mn));
      const ringMeans = [...ringsOut.values()].map(mean);
      return {
        amostras: { interior: interior.length, borda: edge.length, foraAnel: ringMeans.length, linhasSilhueta: lines, pontos: comps.length },
        luminanciaInterior: interiorMean && +interiorMean.toFixed(1),
        luminanciaBorda: edge.length ? +mean(edge).toFixed(1) : null,
        luminanciaFora8a40Min: ringMeans.length ? +Math.min(...ringMeans).toFixed(1) : null,
        saltoMaxSilhueta: +maxJump.toFixed(1),
        saturacaoMedia: satN ? +(satSum / satN).toFixed(4) : null,
        pontoMin: +minDot.toFixed(1),
        pontoMinRgb: minRgb,
        pontoNucleoMediana: dotCore,
        pontoAreaMedianaPx: med(comps.map((p) => p.area)),
        pontoDiametroEquivPx: comps.length ? +(2 * Math.sqrt(med(comps.map((p) => p.area)) / Math.PI)).toFixed(2) : null,
        pontosPor100px2: null,
        areaContinenteMedia: cont.length ? +mean(cont).toFixed(1) : null,
        contrasteLocalPontos: dotCore !== null && interiorMean ? +((srgb(interiorMean) + 0.05) / (srgb(dotCore) + 0.05)).toFixed(2) : null,
      };
    },
    [b64, g],
  );
}

/** Esfera e área visível no PNG da viewport (px CSS = px do PNG a 1x). */
function geoForShot(geo) {
  return {
    cx: geo.sphere.l + geo.sphere.w / 2,
    cy: geo.sphere.t + geo.sphere.h / 2,
    r: geo.sphere.w / 2,
    box: { l: geo.container.l, t: Math.max(0, geo.container.t), r: geo.container.r, b: geo.container.b },
  };
}

/** Recorte no mesmo enquadramento do recorte da Shopify (canto do painel em (503, 6)). */
async function cropLikeRef(page, png, geo, name) {
  const out = await page.evaluate(
    async ([b64, left, top]) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = document.createElement('canvas');
      c.width = 509;
      c.height = 441;
      const x = c.getContext('2d');
      // fora da tela (ex.: login começa em y = 0 e o recorte da Shopify em y = 6): cor do fundo (canto inferior esquerdo do recorte)
      const probe = document.createElement('canvas').getContext('2d');
      probe.drawImage(bmp, -Math.max(0, left + 2), -Math.min(bmp.height - 1, top + 438));
      const [pr, pg, pb] = probe.getImageData(0, 0, 1, 1).data;
      x.fillStyle = `rgb(${pr}, ${pg}, ${pb})`;
      x.fillRect(0, 0, 509, 441);
      x.drawImage(bmp, -left, -top);
      return c.toDataURL('image/png').split(',')[1];
    },
    [png.toString('base64'), Math.round(geo.container.r - REF_CORNER.right), Math.round(geo.container.t - REF_CORNER.top)],
  );
  const buf = Buffer.from(out, 'base64');
  writeFileSync(join(OUT, 'recortes', `${name}.png`), buf);
  return buf;
}

/** Medição completa num fundo branco forçado (C-1) + recorte para a comparação. */
async function whiteMeasure(page, where, name) {
  const style = await page.addStyleTag({ content: WHITE_CSS });
  await page.waitForTimeout(300);
  const geo = await geometry(page, where);
  const png = await page.screenshot();
  writeFileSync(join(OUT, `medicao-${name}-fundo-branco.png`), png);
  const stats = await pixelStats(ana, png.toString('base64'), geoForShot(geo));
  // Esfera sozinha (canvas dos pontos escondido): silhueta, borda, interior e fora sem pontos por perto.
  const hide = await page.addStyleTag({ content: '.ds-live-globe__host, .ds-live-globe__fallback { visibility: hidden !important; }' });
  await page.waitForTimeout(100);
  const sphere = await pixelStats(ana, (await page.screenshot()).toString('base64'), geoForShot(geo));
  await hide.evaluate((el) => el.remove());
  Object.assign(stats, {
    luminanciaInterior: sphere.luminanciaInterior,
    luminanciaBorda: sphere.luminanciaBorda,
    luminanciaFora8a40Min: sphere.luminanciaFora8a40Min,
    saltoMaxSilhueta: sphere.saltoMaxSilhueta,
    linhasSilhueta: sphere.amostras.linhasSilhueta,
    luminanciaInteriorComPontosLonge: stats.luminanciaInterior,
  });
  const crop = await cropLikeRef(ana, png, geo, name);
  await style.evaluate((el) => el.remove());
  return { geo, stats, crop };
}

function checkVisual(key, m) {
  const { geo, stats: s } = m;
  check(Math.abs(geo.diametro - 550) <= 550 * 0.05, `${key}: esfera Ø ${geo.diametro} (550 ±5 %)`);
  check(Math.abs(geo.centroDaDireita - 17) <= 12 && Math.abs(geo.centroDoTopo - 75) <= 12, `${key}: centro a ${geo.centroDaDireita} px da direita (17 ±12) e ${geo.centroDoTopo} px do topo (75 ±12)`);
  check(geo.cortadaEmCimaEDireita && geo.overflow === 'clip' && !geo.rolagemHorizontal, `${key}: cortada pelas bordas de cima e da direita (overflow ${geo.overflow}), sem rolagem horizontal`);
  check(s.saltoMaxSilhueta <= 4 && s.linhasSilhueta >= 20, `${key}: silhueta sem aro (maior salto ${s.saltoMaxSilhueta}/255 em ${s.amostras.linhasSilhueta} linhas)`);
  check(s.luminanciaFora8a40Min >= 253, `${key}: sem sombra externa (fundo a 8–40 px fora ≥ 253: ${s.luminanciaFora8a40Min})`);
  check(s.luminanciaInterior >= 240 && s.luminanciaInterior <= 250 && s.luminanciaBorda >= 253, `${key}: esfera interior ${s.luminanciaInterior} (240–250), junto à silhueta ${s.luminanciaBorda} (≥ 253)`);
  check(s.saturacaoMedia <= 0.02, `${key}: sem cor (saturação média ${s.saturacaoMedia})`);
  check(s.pontoMin <= 90 && s.areaContinenteMedia >= 225 && s.areaContinenteMedia <= 245, `${key}: pontos cinza-escuros (mín ${s.pontoMin} ≤ 90; continente ${s.areaContinenteMedia} em 225–245)`);
  check(s.pontoDiametroEquivPx >= 1 && s.pontoDiametroEquivPx <= 2.5 && s.contrasteLocalPontos >= 3, `${key}: pontos pequenos (Ø equiv. ${s.pontoDiametroEquivPx} px) e contraste local ${s.contrasteLocalPontos}:1 (≥ 3)`);
}

async function composeComparison(page, tiles, file) {
  const png = await page.evaluate(async (items) => {
    const cols = 3;
    const tw = 509;
    const th = 441;
    const pad = 12;
    const lh = 26;
    const rows = Math.ceil(items.length / cols);
    const c = document.createElement('canvas');
    c.width = cols * tw + (cols + 1) * pad;
    c.height = rows * (th + lh) + (rows + 1) * pad;
    const x = c.getContext('2d');
    x.fillStyle = '#8a8a8a';
    x.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < items.length; i += 1) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const px = pad + col * (tw + pad);
      const py = pad + row * (th + lh + pad);
      x.fillStyle = '#1a1a1a';
      x.fillRect(px, py, tw, lh);
      x.fillStyle = '#fff';
      x.font = '600 14px sans-serif';
      x.fillText(items[i].label, px + 8, py + 18);
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${items[i].b64}`)).blob());
      x.drawImage(bmp, px, py + lh, tw, th);
    }
    return c.toDataURL('image/png').split(',')[1];
  }, tiles.map((t) => ({ label: t.label, b64: t.png.toString('base64') })));
  writeFileSync(join(OUT, file), Buffer.from(png, 'base64'));
}

const crops = {};
const browser = await chromium.launch({ args: WEBGL_ARGS });
report.navegador = browser.version();
// Página só de análise (decodifica PNGs em canvas): as páginas testadas podem estar sem canvas (fallback).
let ana = await (await browser.newContext()).newPage();
await ana.goto('about:blank');
try {
  // Referência: mesmas medições no recorte da Shopify (para comparar os números).
  {
    report.referenciaShopify = { geometriaEstimada: REF_GEOMETRY, ...(await pixelStats(ana, readFileSync(REF).toString('base64'), REF_GEOMETRY)) };
  }

  // ── Normal (1920/1440/1280) e movimento reduzido (1440/1280) ──────────────
  for (const [width, modes] of [[1920, ['normal']], [1440, ['normal', 'reduced']], [1280, ['normal', 'reduced']]]) {
    for (const mode of modes) {
      const key = `${width}-${mode}`;
      const suffix = mode === 'normal' ? '' : '-reduced-motion';
      const { ctx, page, errors, chunks } = await newPage(browser, { width, reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference' });
      const r = (report[key] = {});

      for (const where of ['login', 'inicio']) {
        await open(page, where);
        await waitGlobe(page, where);
        const o = (r[where] = {});
        o.geo = await geometry(page, where);
        await page.screenshot({ path: join(OUT, `depois-${width}-${where}${suffix}.png`) });
        if (where === 'login') Object.assign(o, await loginCard(page));
        o.frames = await frames(page, where, `${width}-${where}${suffix}`, o.geo);
        o.rafEm2s = await rafDelta(page, 2000);
        o.motion = (await geometry(page, where)).motion;
        o.conteudo = await contentOnTop(page, where);
        Object.assign(o, await inertChecks(page, where, o.geo));

        check(o.geo.state === 'ready' && o.geo.canvas, `${key} ${where}: globo desenhado (${o.geo.state})`);
        check(o.pointerEvents === 'none' && o.ariaHidden === 'true' && o.elementFromPoint !== 'globo', `${key} ${where}: decorativo (pointer-events ${o.pointerEvents}, aria-hidden ${o.ariaHidden}, ponto no globo → ${o.elementFromPoint})`);
        check(!o.tabStops.includes('globo'), `${key} ${where}: Tab não passa pelo globo (${o.tabStops.join(' → ')})`);
        check(o.conteudo.cobertos === 0, `${key} ${where}: nada do conteúdo coberto (${o.conteudo.naAreaDoGlobo} itens na área do globo, ${o.conteudo.cobertos} cobertos)`);
        if (where === 'login') {
          check(o.intersecaoGloboCartao === 0, `${key} login: globo × cartão = ${o.intersecaoGloboCartao}`);
          check(o.focoInicialNaSenha, `${key} login: foco inicial continua na senha`);
          check(o.geo.container.t === 0 && o.geo.container.r === o.geo.larguraViewport, `${key} login: canto superior direito da viewport (${o.geo.container.t}, ${o.geo.container.r})`);
        } else {
          check(Math.abs(o.geo.container.r - o.geo.direitaConteudo) <= 1 && o.geo.container.t >= o.geo.baseHeader, `${key} início: canto superior direito do conteúdo, abaixo do cabeçalho (topo ${o.geo.container.t}, cabeçalho ${o.geo.baseHeader}; direita ${o.geo.container.r}/${o.geo.direitaConteudo})`);
        }
        if (mode === 'normal') {
          const f = o.frames;
          check(f.framesDistintos === 3 && o.motion === 'animating' && o.rafEm2s > 20, `${key} ${where}: gira (${f.framesDistintos}/3 quadros distintos em 1,4 s; rAF em 2 s = ${o.rafEm2s})`);
          // graus/s: medidos na sessão sem flags de GL (abaixo) — aqui os prints do SwiftShader levam segundos.
        } else {
          check(o.frames.framesDistintos === 1 && o.motion === 'static' && o.rafEm2s === 0, `${key} ${where}: reduzir movimento → 1 quadro, rAF em 2 s = ${o.rafEm2s}`);
        }
      }
      r.chunkDoGlobo = Object.fromEntries(chunks);
      r.erros = errors;
      check(chunks.size === 1, `${key}: globo num chunk à parte (${[...chunks.keys()].join(', ')})`);
      check(errors.length === 0, `${key}: 0 erros no console (${errors.slice(0, 2).join(' | ')})`);
      await ctx.close();
    }
  }

  // ── Medições de pixel e recortes (AC1–AC4, AC9): fundo branco forçado, no ângulo
  //    inicial (movimento reduzido → quadro parado, comparável ao print estático da Shopify) ──
  for (const width of [1920, 1440, 1280]) {
    const { ctx, page } = await newPage(browser, { width, reducedMotion: 'reduce' });
    for (const where of ['login', 'inicio']) {
      await open(page, where);
      await waitGlobe(page, where);
      const m = await whiteMeasure(page, where, `${width}-${where}`);
      report[`${width}-normal`][where].medicao = { geo: m.geo, ...m.stats };
      crops[`${width}-${where}`] = m.crop;
      checkVisual(`${width} ${where} (fundo branco)`, m);
    }
    await ctx.close();
  }

  // ── Login escuro (22.1b): fundo escuro + variante dark, só no harness ──────
  for (const width of [1440, 1280]) {
    const { ctx, page, errors } = await newPage(browser, { width, dark: true, reducedMotion: 'reduce' });
    await open(page, 'login');
    await waitGlobe(page, 'login');
    const geo = await geometry(page, 'login');
    const png = await page.screenshot({ path: join(OUT, `depois-${width}-login-escuro.png`) });
    crops[`${width}-login-escuro`] = await cropLikeRef(ana, png, geo, `${width}-login-escuro`);
    const r = (report[`${width}-login-escuro`] = { geo, ...(await loginCard(page)), erros: errors });
    check(geo.variant === 'dark' && geo.state === 'ready' && r.intersecaoGloboCartao === 0 && errors.length === 0, `${width} login escuro: variante dark desenhada, globo × cartão = ${r.intersecaoGloboCartao}, ${errors.length} erros`);
    await ctx.close();
  }

  // ── Aba oculta e rolagem para fora da tela (1440) + print 2x ──────────────
  {
    const { ctx, page } = await newPage(browser, { width: 1440, scale: 2 });
    const r = (report.interacao = {});
    await open(page, 'inicio');
    await waitGlobe(page, 'inicio');
    await page.locator('.ds-live-home [data-testid="corner-globe"]').screenshot({ path: join(OUT, 'depois-1440-inicio-globo-2x.png') });
    const setHidden = (hidden) =>
      page.evaluate((h) => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
        document.dispatchEvent(new Event('visibilitychange'));
      }, hidden);
    r.rafVisivel1s = await rafDelta(page, 1000);
    await setHidden(true);
    await page.waitForTimeout(100);
    r.motionOculta = (await geometry(page, 'inicio')).motion;
    r.rafOculta1s = await rafDelta(page, 1000);
    await setHidden(false);
    await page.waitForTimeout(100);
    r.motionVisivelDeNovo = (await geometry(page, 'inicio')).motion;
    r.rafVisivelDeNovo1s = await rafDelta(page, 1000);
    check(r.motionOculta === 'paused' && r.rafOculta1s === 0 && r.rafVisivel1s > 10, `aba oculta: laço pausado (rAF/s ${r.rafVisivel1s} → ${r.rafOculta1s})`);
    check(r.motionVisivelDeNovo === 'animating' && r.rafVisivelDeNovo1s > 10, `aba visível de novo: retoma (rAF/s ${r.rafVisivelDeNovo1s})`);
    await page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.style.height = '3000px';
      document.querySelector('.ds-live-home__content').appendChild(spacer);
      window.scrollTo(0, 2500);
    });
    await page.waitForTimeout(400);
    r.motionForaDaTela = (await geometry(page, 'inicio')).motion;
    r.rafForaDaTela1s = await rafDelta(page, 1000);
    check(r.motionForaDaTela === 'paused' && r.rafForaDaTela1s === 0, `fora da tela: laço pausado (motion ${r.motionForaDaTela}, rAF/s ${r.rafForaDaTela1s})`);
    await ctx.close();
  }

  // ── Fallback estático (sem canvas 2D forçado): mesmo tamanho e enquadramento ──
  {
    const { ctx, page, errors, chunks } = await newPage(browser, { width: 1440, noCanvas: true });
    const r = (report['1440-fallback'] = {});
    for (const where of ['login', 'inicio']) {
      await open(page, where);
      await waitGlobe(page, where, ['fallback']);
      r[where] = await geometry(page, where);
      await page.screenshot({ path: join(OUT, `depois-1440-${where}-fallback.png`) });
      const m = await whiteMeasure(page, where, `1440-${where}-fallback`);
      r[`${where}Medicao`] = m.stats;
      check(r[where].state === 'fallback' && !r[where].canvas && r[where].container.w === 340 && Math.abs(r[where].diametro - 532) < 1, `fallback ${where}: estático, mesmo contêiner (${r[where].container.w}×${r[where].container.h}) e esfera Ø ${r[where].diametro}`);
      check(m.stats.saltoMaxSilhueta <= 4 && m.stats.luminanciaFora8a40Min >= 253 && m.stats.luminanciaInterior >= 240, `fallback ${where}: claro, sem aro (salto ${m.stats.saltoMaxSilhueta}), sem sombra (${m.stats.luminanciaFora8a40Min})`);
    }
    r.erros = errors;
    check(errors.length === 0 && chunks.size === 0, `fallback: 0 erros no console (${errors.length}) e chunk do globo nem é baixado (${chunks.size})`);
    await ctx.close();
  }

  // ── Celular 390 px ─────────────────────────────────────────────────────────
  {
    const { ctx, page, errors } = await newPage(browser, { width: 390, height: 844 });
    const r = (report['390'] = {});
    for (const where of ['login', 'inicio']) {
      await open(page, where);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(OUT, `depois-390-${where}.png`) });
      r[where] = await geometry(page, where);
      check(r[where]?.display === 'none' && !r[where].rolagemHorizontal, `390 ${where}: globo não aparece (display ${r[where]?.display}), sem rolagem horizontal`);
    }
    r.erros = errors;
    await ctx.close();
  }

  // ── Comparação lado a lado (AC9) ──────────────────────────────────────────
  {
    const { ctx, page } = await newPage(browser, { width: 800 });
    await page.goto('about:blank');
    const ref = readFileSync(REF);
    await composeComparison(
      page,
      [
        { label: 'Shopify (recorte de referência)', png: ref },
        { label: 'BlackShop v3 — Início 1440 (fundo branco)', png: crops['1440-inicio'] },
        { label: 'BlackShop v3 — Login 1440 (fundo branco)', png: crops['1440-login'] },
        { label: 'BlackShop v3 — Início 1280', png: crops['1280-inicio'] },
        { label: 'BlackShop v3 — Início 1920', png: crops['1920-inicio'] },
        { label: 'BlackShop v3 — Login escuro 1440 (22.1b)', png: crops['1440-login-escuro'] },
      ],
      'comparacao-globo.png',
    );
    for (const width of [1920, 1440, 1280]) {
      await composeComparison(
        page,
        [
          { label: 'Shopify', png: ref },
          { label: `Início ${width}`, png: crops[`${width}-inicio`] },
          { label: `Login ${width}`, png: crops[`${width}-login`] },
        ],
        `comparacao-globo-${width}.png`,
      );
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}

// ── Navegador sem WebGL: o v3 é canvas 2D → globo igual, 0 erros ─────────────
{
  const noGl = await chromium.launch({ args: NO_WEBGL_ARGS });
  ana = await (await noGl.newContext()).newPage();
  await ana.goto('about:blank');
  try {
    for (const width of [1440, 1280]) {
      const key = `${width}-sem-webgl`;
      const { ctx, page, errors } = await newPage(noGl, { width });
      const r = (report[key] = {});
      r.webglDisponivel = await page.evaluate(() => {
        const c = document.createElement('canvas');
        return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
      });
      for (const where of ['login', 'inicio']) {
        await open(page, where);
        await waitGlobe(page, where, ['ready', 'fallback']);
        r[where] = await geometry(page, where);
        await page.screenshot({ path: join(OUT, `depois-${width}-${where}-sem-webgl.png`) });
        // giro (AC5): 3 quadros a ~700 ms (prints rápidos aqui) e o ângulo de cada um ajustado à grade de terra
        // (até 3 tentativas: se a máquina engasgar e o intervalo passar de 2 s, a amostra não vale para "1,4 s")
        let f = await frames(page, where, `${width}-${where}-sem-webgl`, r[where]);
        for (let attempt = 1; attempt < 3 && f.intervaloS > 2; attempt += 1) f = await frames(page, where, `${width}-${where}-sem-webgl`, r[where]);
        r[`${where}Giro`] = f;
        check(
          f.framesDistintos === 3 && f.intervaloS <= 2 && f.grausPorSegundoMedido > 0 && f.grausPorSegundoMedido <= 6 && f.phiPorQuadro.every((p) => p.acerto > 0.6),
          `${key} ${where}: gira devagar (${f.framesDistintos}/3 quadros distintos em ${f.intervaloS} s; ${f.grausPorSegundoMedido}°/s medido pelo ângulo dos quadros, ajuste ${f.phiPorQuadro.map((p) => p.acerto).join('/')}; constante ${f.grausPorSegundoConstante}°/s; ≤ 6)`,
        );
        check(['ready', 'fallback'].includes(r[where].state) && r[where].container.w === 340 && Math.abs(r[where].diametro - 532) < 1, `${key} ${where}: globo ${r[where].state}, mesmo enquadramento (${r[where].container.w}×${r[where].container.h}, Ø ${r[where].diametro})`);
      }
      r.erros = errors;
      check(!r.webglDisponivel, `${key}: navegador sem WebGL de fato`);
      check(errors.length === 0, `${key}: 0 erros no console (${errors.length}) ${errors.slice(0, 2).join(' | ')}`);
      await ctx.close();
    }
  } finally {
    await noGl.close();
  }
}

report.falhas = failures;
writeFileSync(join(OUT, 'depois-medicoes.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(failures.length === 0 ? '\nTUDO OK' : `\n${failures.length} falha(s)`);
process.exit(failures.length === 0 ? 0 : 1);
