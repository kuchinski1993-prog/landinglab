/* eslint-env browser, node */
/* eslint-disable no-console */
// Story 21.2c · AC14 — "Ao vivo" do Início no navegador real (Chromium/Playwright do repo),
// padrão 20.5f / harness da 21.5: backoffice em `next start` desta branch (sem `.env*`), API em
// mock HTTP local com GET /admin/live/overview trocando de cenário, cookie `blackshop.sid`.
// Grava prints (1280/1440/1920: 0, poucos e muitos visitantes, venda nova, degradados, erro) e
// `depois-medicoes.json`.
//
// Uso:
//   1) cd apps/backoffice && NEXT_PUBLIC_API_URL=http://127.0.0.1:3071 npx next build && npx next start -p 3072
//   2) BASE_URL=http://localhost:3072 node apps/backoffice/scripts/ds-spike/live-e2e.mjs docs/prints/21.2c
// Sai 1 se alguma verificação falhar.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const { chromium } = createRequire(join(repo, 'package.json'))('@playwright/test');

const BASE = process.env.BASE_URL ?? 'http://localhost:3072';
const API_PORT = Number(process.env.MOCK_API_PORT ?? 3071);
const OUT = resolve(repo, process.argv[2] ?? 'docs/prints/21.2c');
mkdirSync(OUT, { recursive: true });
const WEBGL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

const results = {};
const failures = [];
const check = (key, ok, detail = {}) => {
  results[key] = { ok, ...detail };
  if (!ok) failures.push(key);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${key} ${JSON.stringify(detail).slice(0, 400)}`);
  return ok;
};

// ── Dados do "Ao vivo" ───────────────────────────────────────────────────────
const NOW = () => new Date().toISOString();
const STORES = [
  { id: 'loja-a', name: 'Voss Concept', domain: null, shopifyDomain: 'voss.myshopify.com', isActive: true },
  { id: 'loja-b', name: 'Loja Brasil', domain: null, shopifyDomain: 'brasil.myshopify.com', isActive: true },
];
const CITIES = [
  [38.5, -9, 'PT', 'Lisboa'], [41, -8.5, 'PT', 'Porto'], [40.5, -3.5, 'ES', 'Madrid'], [48.5, 2.5, 'FR', 'Paris'], [51.5, 0, 'GB', 'Londres'],
  [52.5, 13.5, 'DE', 'Berlim'], [45.5, 9, 'IT', 'Milão'], [-23.5, -46.5, 'BR', 'São Paulo'], [-22.5, -43, 'BR', 'Rio de Janeiro'], [-15.5, -48, 'BR', 'Brasília'],
  [-30, -51, 'BR', 'Porto Alegre'], [-8, -35, 'BR', 'Recife'], [-3.5, -38.5, 'BR', 'Fortaleza'], [19.5, -99, 'MX', 'Cidade do México'], [4.5, -74, 'CO', 'Bogotá'],
  [-12, -77, 'PE', 'Lima'], [-33.5, -70.5, 'CL', 'Santiago'], [-34.5, -58.5, 'AR', 'Buenos Aires'], [40.5, -74, 'US', 'Nova York'], [34, -118, 'US', 'Los Angeles'],
  [25.5, -80, 'US', 'Miami'], [43.5, -79.5, 'CA', 'Toronto'], [10.5, -67, 'VE', 'Caracas'], [9, -79.5, 'PA', 'Panamá'], [14.5, -90.5, 'GT', 'Guatemala'],
  [18.5, -70, 'DO', 'Santo Domingo'], [35.5, 139.5, 'JP', 'Tóquio'], [-34, 151, 'AU', 'Sydney'], [1.5, 104, 'SG', 'Singapura'], [19, 73, 'IN', 'Mumbai'],
  [30, 31, 'EG', 'Cairo'], [-26, 28, 'ZA', 'Joanesburgo'], [6.5, 3.5, 'NG', 'Lagos'], [55.5, 37.5, 'RU', 'Moscou'], [41, 29, 'TR', 'Istambul'],
];
const point = ([lat, lng, cc, city], count) => ({ lat, lng, cc, city, count });
const manyPoints = () => {
  const pts = [];
  for (let i = 0; i < 150; i++) {
    const [lat, lng, cc, city] = CITIES[i % CITIES.length];
    const k = Math.floor(i / CITIES.length);
    pts.push({ lat: lat + (k % 3) * 1.5 - 1.5, lng: lng + (k % 2) * 2 - 1, cc, city, count: 1 + ((i * 7) % 5) });
  }
  return pts;
};
const order = (id, minutesAgo, total, currency, city, country, lat, lng, source = 'shopify') => ({
  id, at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), total, currency, ...(city ? { city } : {}), country, ...(lat !== undefined ? { lat, lng } : {}), source,
});
const BASE_ORDERS = [
  order('o-5', 4, 69.95, 'EUR', 'Lisboa', 'PT', 38.5, -9),
  order('o-4', 18, 129.9, 'EUR', 'Madrid', 'ES', 40.5, -3.5),
  order('o-3', 41, 49.95, 'EUR', 'Porto', 'PT', 41, -8.5, 'landing'),
  order('o-2', 75, 321, 'BRL', 'São Paulo', 'BR', -23.5, -46.5, 'landing'),
  order('o-1', 130, 89.9, 'EUR', null, 'FR', 46.5, 2.5),
];
const salesBlock = (orders = BASE_ORDERS) => ({
  timezoneLabel: 'horário de Lisboa',
  today: [
    { source: 'shopify', currency: 'EUR', total: 544.6, orders: 5 },
    { source: 'landing', currency: 'EUR', total: 99.9, orders: 2 },
    { source: 'landing', currency: 'BRL', total: 321, orders: 1 },
  ],
  recentOrders: orders,
});
const SOURCES = [
  { id: 'instagram', label: 'Instagram', count: 38 }, { id: 'facebook', label: 'Facebook', count: 27 }, { id: 'google', label: 'Google', count: 19 },
  { id: 'direct', label: 'Direto', count: 12 }, { id: 'tiktok', label: 'TikTok', count: 7 }, { id: 'email', label: 'E-mail', count: 3 }, { id: 'other', label: 'Outros', count: 2 },
];
const TOP = [
  { productId: 'p-serum', title: 'Sérum Vitamina C 30 ml', viewers: 14 }, { productId: 'p-creme', title: 'Creme Noturno Retinol', viewers: 9 },
  { productId: 'p-kit', title: 'Kit Rotina Completa', viewers: 6 }, { productId: 'p-tonico', title: null, viewers: 3 }, { productId: 'p-oleo', title: 'Óleo Facial Rosa Mosqueta', viewers: 2 },
];
const overview = (storeId, over = {}) => ({
  storeId, generatedAt: NOW(), windowMinutes: 5, geo: { available: true }, degraded: [],
  visitors: { now: 108, points: manyPoints() }, sales: salesBlock(), topProducts: TOP, sources: SOURCES, ...over,
});
const LIVE = {
  muitos: (s) => overview(s),
  poucos: (s) => overview(s, {
    visitors: { now: 5, points: [point(CITIES[0], 2), point(CITIES[7], 1), point(CITIES[13], 1), point(CITIES[14], 1)] },
    topProducts: TOP.slice(0, 2).map((p) => ({ ...p, viewers: 1 })), sources: [{ id: 'instagram', label: 'Instagram', count: 3 }, { id: 'direct', label: 'Direto', count: 2 }],
  }),
  zero: (s) => overview(s, { visitors: { now: 0, points: [] }, topProducts: [], sources: [], sales: { timezoneLabel: 'horário de Lisboa', today: [], recentOrders: [] } }),
  redis: (s) => overview(s, { degraded: ['redis'], visitors: { now: null, points: [] }, topProducts: [], sources: [] }),
  db: (s) => overview(s, { degraded: ['db'], sales: null, topProducts: [] }),
  geo: (s) => overview(s, { geo: { available: false }, visitors: { now: 108, points: [] } }),
  lojaB: (s) => overview(s, {
    visitors: { now: 23, points: [point(CITIES[7], 12), point(CITIES[8], 6), point(CITIES[9], 5)] },
    sales: { timezoneLabel: 'horário de Brasília', today: [{ source: 'shopify', currency: 'BRL', total: 1789.5, orders: 11 }], recentOrders: [order('b-1', 3, 159.9, 'BRL', 'Recife', 'BR', -8, -35)] },
    topProducts: [{ productId: 'pb-1', title: 'Camiseta Básica Algodão', viewers: 8 }], sources: [{ id: 'google', label: 'Google', count: 15 }, { id: 'direct', label: 'Direto', count: 8 }],
  }),
};

let live = { kind: 'muitos', status: 200, newOrders: [] };
const liveRequests = [];

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const api = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${API_PORT}`);
  const p = url.pathname;
  const store = String(req.headers['x-store-id'] ?? 'loja-a');
  if (p === '/admin/live/overview') {
    liveRequests.push({ at: Date.now(), store });
    if (live.status !== 200) return reply(res, live.status, { code: 'INTERNAL', message: 'erro' });
    const body = store === 'loja-b' ? LIVE.lojaB(store) : LIVE[live.kind](store);
    if (live.newOrders.length && body.sales) body.sales = { ...body.sales, recentOrders: [...live.newOrders, ...body.sales.recentOrders] };
    return reply(res, 200, body);
  }
  if (p === '/auth/me') return reply(res, 200, { authenticated: true, user: { id: 'u-owner', email: 'will@example.com', name: 'Will Kuchinski', role: 'owner' } });
  if (p === '/stores') return reply(res, 200, { items: STORES });
  const mod = /^\/stores\/([^/]+)\/modules$/.exec(p);
  if (mod) {
    const ids = ['catalogo', 'pedidos', 'loja-online', 'atendimento', 'marketing', 'landinglab', 'vsl', 'tracker'];
    return reply(res, 200, { storeId: decodeURIComponent(mod[1]), modules: ids.map((id) => ({ id, enabled: true })) });
  }
  if (p === '/assistant/status') return reply(res, 200, { enabled: true });
  const cur = (list) => list.map(([currency, total, orders]) => ({ currency, total, orders, averageTicket: total / orders, previousTotal: 0, previousOrders: 0, changePct: null }));
  if (p === '/home/store/sales') {
    const b = store === 'loja-b';
    return reply(res, 200, {
      storeId: store, range: 'today', timezoneLabel: 'x', baseCurrency: b ? 'BRL' : 'EUR', updatedAt: NOW(),
      sources: [
        { source: 'shopify', label: 'Shopify', currencies: cur(b ? [['BRL', 1789.5, 11]] : [['EUR', 544.6, 5]]), withoutValue: { orders: 0, previousOrders: 0 }, series: [] },
        { source: 'landing', label: 'Landings', currencies: cur(b ? [] : [['EUR', 99.9, 2], ['BRL', 321, 1]]), withoutValue: { orders: 0, previousOrders: 0 }, series: [] },
      ],
    });
  }
  if (p === '/home/store/traffic') return reply(res, 200, { storeId: store, range: 'today', timezoneLabel: 'x', sessions: store === 'loja-b' ? 77 : 846, previousSessions: 700, changePct: 20.9, paidOrders: store === 'loja-b' ? 11 : 8, conversionPct: 0.9, minSessions: 30, updatedAt: NOW() });
  if (p === '/home/store/attention') return reply(res, 200, { items: [{ id: 'shopify-to-ship', module: 'pedidos', severity: 'warning', label: '5 a enviar', description: 'x', count: 5, href: '/orders', oldest: null }], unavailable: [], updatedAt: NOW() });
  if (p === '/home/account/summary') return reply(res, 200, { updatedAt: NOW(), stores: [] });
  if (p === '/home/account/landinglab') return reply(res, 200, { tenantId: 'l0i', publishedLandings: 5, openSupportThreads: 2, last7Days: [], attention: { items: [], unavailable: [] }, updatedAt: NOW() });
  if (p === '/home/account/vsl') return reply(res, 200, { published: 1, draft: 2, updatedAt: NOW() });
  if (p === '/home/account/tracker') return reply(res, 200, { enabled: true, activeCampaigns: 6, clicksLast7Days: 84, updatedAt: NOW() });
  if (p.startsWith('/admin/landing-support/threads')) return reply(res, 200, { unread: 0, items: [] });
  if (p.startsWith('/notifications')) return reply(res, 200, { unreadCount: 0, items: [] });
  return reply(res, 404, { code: 'NOT_FOUND', message: 'not found' });
});
await new Promise((r) => api.listen(API_PORT, '127.0.0.1', r));

// ── Navegador ───────────────────────────────────────────────────────────────
const browser = await chromium.launch({ args: WEBGL_ARGS });

async function newPage({ width = 1440, height = 900, store = 'loja-a', reducedMotion = 'no-preference' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion });
  await ctx.addCookies([
    { name: 'blackshop.sid', value: 'e2e', url: BASE },
    { name: 'bs:activeStoreId', value: store, url: BASE },
  ]);
  // Aba "oculta" controlável (o headless não oculta abas): window.__setHidden(true|false).
  await ctx.addInitScript(() => {
    let hidden = false;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    window.__setHidden = (v) => {
      hidden = v;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on('console', (m) => {
    const where = m.location()?.url ?? '';
    // /api/admin/users/pending-count (22.1c, rota do próprio Next) responde 404 sem a API real — fora desta story.
    if (m.type() === 'error' && !/\/api\/admin\/users\/pending-count/.test(where)) errors.push(`${m.text().slice(0, 160)} ${where}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
  if (process.env.DEBUG_LIVE) page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 200)));
  if (process.env.DEBUG_LIVE) page.on('requestfailed', (r) => console.log('[reqfail]', r.url()));
  return { ctx, page, errors };
}

async function openHome(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="home-greeting"]', { timeout: 30000 }).catch(async (err) => {
    console.log('openHome falhou em', page.url(), (await page.evaluate(() => document.body?.innerText ?? '')).slice(0, 300));
    throw err;
  });
  await page.waitForSelector('[data-testid="home-live"]:not([data-state="loading"])', { timeout: 20000 }).catch(() => undefined);
  await page.waitForSelector('[data-testid="live-globe"][data-globe-state="ready"]', { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(900);
}

async function shot(page, name, fullPage = true) {
  if (!fullPage) {
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    return;
  }
  // Moldura da 20.14a é `position: fixed`: cresce a viewport até a altura do documento.
  const vp = page.viewportSize();
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, h) });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await page.setViewportSize(vp);
  await page.waitForTimeout(200);
}

const state = (page) =>
  page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const canvas = q('[data-testid="corner-globe"] canvas');
    let markerPx = 0;
    let inkPx = 0;
    if (canvas) {
      const c = canvas.getContext('2d');
      const d = c.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 40) continue;
        inkPx++;
        // verde do marcador (#4cc38a): G alto, R e B bem menores
        if (d[i + 1] > 150 && d[i + 1] - d[i] > 60 && d[i + 1] - d[i + 2] > 30) markerPx++;
      }
    }
    return {
      globos: document.querySelectorAll('[data-testid="live-globe"]').length,
      canvases: document.querySelectorAll('canvas').length,
      globeState: q('[data-testid="live-globe"]')?.getAttribute('data-globe-state') ?? null,
      motion: q('.ds-live-globe__host')?.getAttribute('data-globe-motion') ?? null,
      slot: q('[data-testid="home-visitors-now"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      secao: q('[data-testid="home-live"]')?.getAttribute('data-state') ?? null,
      titulo: q('#home-live-title')?.textContent ?? null,
      status: q('[data-testid="home-live-status"]')?.textContent ?? null,
      novas: [...document.querySelectorAll('[data-new="true"]')].map((n) => n.getAttribute('data-order-id')),
      banners: ['redis', 'db'].filter((k) => q(`[data-testid="home-live-degraded-${k}"]`)).concat(q('[data-testid="home-live-geo-off"]') ? ['geo'] : []),
      hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
      markerPx,
      inkPx,
    };
  });

const report = { nota: 'Story 21.2c · AC14 — navegador real (Chromium do repo, SwiftShader), next start desta branch, API em mock HTTP local.', medicoes: {} };

try {
  // ── Cenários × larguras ────────────────────────────────────────────────────
  const scenarios = [
    ['muitos', 108], ['poucos', 5], ['zero', 0],
  ];
  for (const width of [1280, 1440, 1920]) {
    for (const [kind, n] of scenarios) {
      live = { kind, status: 200, newOrders: [] };
      const { ctx, page, errors } = await newPage({ width });
      await openHome(page);
      const s = await state(page);
      await shot(page, `depois-${width}-${kind}-visitantes`);
      await page.screenshot({ path: join(OUT, `depois-${width}-${kind}-canto.png`), clip: { x: width - 520, y: 0, width: 520, height: 520 } });
      const slotOk = n === 0 ? /Visitantes agora 0/.test(s.slot ?? '') : new RegExp(`Visitantes agora ${n}`).test(s.slot ?? '');
      const markersOk = kind === 'zero' ? s.markerPx === 0 : kind === 'muitos' ? s.markerPx > 0 : true;
      check(`${kind}_${width}`, s.globos === 1 && s.canvases <= 1 && slotOk && s.secao === 'ready' && !s.hScroll && markersOk && errors.length === 0, { ...s, erros: errors });
      await ctx.close();
    }
  }

  // ── Degradados e erro (1440 e 1280) ────────────────────────────────────────
  for (const width of [1440, 1280]) {
    for (const [kind, status] of [['redis', 200], ['db', 200], ['geo', 200], ['erro', 500]]) {
      live = { kind: status === 200 ? kind : 'muitos', status, newOrders: [] };
      const { ctx, page, errors } = await newPage({ width });
      await openHome(page);
      const s = await state(page);
      await shot(page, `depois-${width}-degradado-${kind}`);
      let ok = s.globos === 1 && !s.hScroll;
      if (kind === 'redis') ok &&= s.banners.includes('redis') && /—/.test(s.slot ?? '') && !/\b0\b/.test(s.slot ?? '');
      if (kind === 'db') ok &&= s.banners.includes('db') && /108/.test(s.slot ?? '');
      if (kind === 'geo') ok &&= s.banners.includes('geo') && s.markerPx === 0 && /108/.test(s.slot ?? '');
      if (kind === 'erro') ok &&= s.secao === 'error' && /—/.test(s.slot ?? '') && !/\b0\b/.test(s.slot ?? '') && s.markerPx === 0;
      // Erro total: o 500 do mock vira 1 linha de console do navegador (recurso falhou) — esperado.
      const errs = errors.filter((e) => !/Failed to load resource/.test(e));
      check(`degradado_${kind}_${width}`, ok && errs.length === 0, { ...s, erros: errs });
      await ctx.close();
    }
  }

  // ── Venda nova: linha em destaque ~6 s + role="status"; pulso no globo ─────
  {
    live = { kind: 'poucos', status: 200, newOrders: [] };
    const { ctx, page, errors } = await newPage({ width: 1440 });
    await openHome(page);
    const first = await state(page);
    check('e_primeira_carga_sem_destaque', first.novas.length === 0 && first.status === '', first);
    // 8 vendas em longitudes a cada 45°: com o globo girando, ao menos uma cai na parte visível.
    live.newOrders = Array.from({ length: 8 }, (_, i) => order(`n-${i}`, 0, 59.9 + i, 'EUR', 'Cidade', 'BR', 5, -180 + i * 45));
    await page.waitForFunction(() => document.querySelectorAll('[data-new="true"]').length > 0, null, { timeout: 15000 });
    await page.waitForTimeout(500);
    const during = await state(page);
    // Lista e canto primeiro (o destaque dura ~6 s; o print da página inteira é lento no SwiftShader).
    await page.screenshot({ path: join(OUT, 'depois-1440-venda-nova-canto.png'), clip: { x: 1440 - 520, y: 0, width: 520, height: 520 } });
    await page.locator('[data-testid="home-live-recent"]').screenshot({ path: join(OUT, 'depois-1440-venda-nova-lista.png') });
    await shot(page, 'depois-1440-venda-nova');
    // AX tree: role=status com o texto e o globo do canto fora da árvore (decorativo).
    const cdp = await ctx.newCDPSession(page);
    const ax = await cdp.send('Accessibility.getFullAXTree');
    const statusNode = ax.nodes.find((n) => n.role?.value === 'status');
    const statusName = statusNode ? (await page.evaluate(() => document.querySelector('[role="status"]').textContent)) : null;
    await page.waitForTimeout(6800);
    const after = await state(page);
    // A lista mostra as 6 mais recentes: todas as 6 visíveis são novas.
    check('e_venda_nova_destaque_6s', during.novas.length === 6 && after.novas.length === 0, { durante: during.novas, depois: after.novas });
    check('f_role_status_mesmo_fora_do_globo', /^8 novas vendas/.test(during.status ?? '') && Boolean(statusNode) && during.markerPx > 0, { status: during.status, axStatus: Boolean(statusNode), axTexto: statusName, markerPx: during.markerPx, erros: errors });
    await ctx.close();
  }
  {
    // Movimento reduzido: globo parado, venda nova em destaque estático (Bogotá, na parte visível) + aviso.
    live = { kind: 'poucos', status: 200, newOrders: [] };
    const { ctx, page } = await newPage({ width: 1440, reducedMotion: 'reduce' });
    await openHome(page);
    const before = await state(page);
    live.newOrders = [order('n-bog', 0, 74.5, 'EUR', 'Bogotá', 'CO', 4.5, -74)];
    await page.waitForFunction(() => document.querySelectorAll('[data-new="true"]').length > 0, null, { timeout: 15000 });
    await page.waitForTimeout(400);
    const a = await state(page);
    await page.waitForTimeout(700);
    const b = await state(page);
    await shot(page, 'depois-1440-venda-nova-movimento-reduzido');
    await page.screenshot({ path: join(OUT, 'depois-1440-venda-nova-movimento-reduzido-canto.png'), clip: { x: 1440 - 520, y: 0, width: 520, height: 520 } });
    check('h_movimento_reduzido', a.motion === 'static' && /^Nova venda: .*Bogotá, Colômbia$/.test(a.status ?? '') && a.markerPx === b.markerPx && a.markerPx > before.markerPx, { antes: before.markerPx, a: a.markerPx, b: b.markerPx, motion: a.motion, status: a.status });
    await ctx.close();
  }

  // ── Requisições: ≈6/min visível, 0 com a aba oculta, +1 ao voltar ──────────
  {
    live = { kind: 'poucos', status: 200, newOrders: [] };
    const { ctx, page } = await newPage({ width: 1440 });
    await openHome(page);
    const t0 = Date.now();
    const c0 = liveRequests.length;
    await page.waitForTimeout(60_000);
    const visiveis = liveRequests.filter((r) => r.at >= t0).length;
    await page.evaluate(() => window.__setHidden(true));
    const t1 = Date.now();
    await page.waitForTimeout(30_000);
    const ocultas = liveRequests.filter((r) => r.at >= t1).length;
    const t2 = Date.now();
    await page.evaluate(() => window.__setHidden(false));
    await page.waitForTimeout(1500);
    const aoVoltar = liveRequests.filter((r) => r.at >= t2).length;
    // Início desmontado: navega para outra tela do painel.
    await page.goto(`${BASE}/lojas`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const t3 = Date.now();
    await page.waitForTimeout(25_000);
    const foraDoInicio = liveRequests.filter((r) => r.at >= t3).length;
    check('d_requisicoes', visiveis >= 5 && visiveis <= 7 && ocultas === 0 && aoVoltar === 1 && foraDoInicio === 0, { visiveisEm60s: visiveis, ocultaEm30s: ocultas, aoVoltar, foraDoInicioEm25s: foraDoInicio, antes: c0 });
    await ctx.close();
  }

  // ── Cursor e Ctrl-clique na linha do produto; um só globo; título ─────────
  {
    live = { kind: 'muitos', status: 200, newOrders: [] };
    const { ctx, page } = await newPage({ width: 1440 });
    await openHome(page);
    const pts = await page.evaluate(() => {
      const row = document.querySelector('[data-testid="home-live-product-row"]');
      // A linha é `display: contents` (scrollIntoView não age nela): rola o cartão.
      document.querySelector('[data-testid="home-live-products"]').scrollIntoView({ block: 'center' });
      // Método da 20.5f/22.1c: no texto, o cursor do elemento (ou do slot) que contém o texto;
      // fora de texto, o elemento mais fundo (atravessando Shadow DOM).
      function effectiveCursor(x, y) {
        const node = document.caretRangeFromPoint(x, y)?.startContainer;
        if (node && node.nodeType === 3) {
          const target = node.assignedSlot ?? node.parentElement?.assignedSlot ?? node.parentElement;
          const hit = document.elementFromPoint(x, y);
          if (target && hit && (hit === node.parentElement || hit.contains(node.parentElement) || node.parentElement.contains(hit))) {
            return { cursor: getComputedStyle(target).cursor, via: `texto→${target.tagName}` };
          }
        }
        let el = document.elementFromPoint(x, y);
        for (let i = 0; i < 10 && el?.shadowRoot; i += 1) {
          const inner = el.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === el) break;
          el = inner;
        }
        return { cursor: el ? getComputedStyle(el).cursor : null, via: el?.tagName ?? null };
      }
      function textCenter(cell) {
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!n.textContent.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          const r = range.getBoundingClientRect();
          if (r.width) return { x: r.left + Math.min(r.width / 2, 20), y: r.top + r.height / 2 };
        }
        return null;
      }
      const cells = row.querySelectorAll('s-table-cell');
      window.__effectiveCursor = effectiveCursor;
      return { a: textCenter(cells[0]), b: textCenter(cells[1]), href: row.querySelector('s-link').getAttribute('href') };
    });
    // Com o mouse em cima (o Polaris liga o cursor da linha no hover).
    const at = async (pt) => {
      if (!pt) return null;
      await page.mouse.move(pt.x, pt.y);
      await page.waitForTimeout(150);
      return page.evaluate(({ x, y }) => window.__effectiveCursor(x, y), pt);
    };
    const cursorNome = await at(pts.a);
    const cursorOutra = await at(pts.b);
    const cursor = { nome: cursorNome, outraCelula: cursorOutra, href: pts.href };
    const [popup] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null),
      page.locator('[data-testid="home-live-product-row"] s-table-cell').nth(1).click({ modifiers: ['Control'] }),
    ]);
    const popupUrl = popup ? popup.url() : null;
    check('e_cursor_e_ctrl_clique', cursor.nome?.cursor === 'pointer' && cursor.outraCelula?.cursor === 'pointer' && cursor.href === '/products/p-serum' && /\/products\/p-serum$/.test(popupUrl ?? ''), { ...cursor, popupUrl });
    if (popup) await popup.close();
    const t = await page.evaluate(() => {
      const h = document.querySelector('#home-live-title');
      const cs = getComputedStyle(h);
      return { texto: h.textContent, fontWeight: cs.fontWeight, fontSize: cs.fontSize };
    });
    check('a_titulo_secao', t.texto === 'Ao vivo — Voss Concept' && Number(t.fontWeight) >= 600, t);
    await ctx.close();
  }

  // ── Troca de loja: números da outra loja, nada da anterior ─────────────────
  {
    live = { kind: 'muitos', status: 200, newOrders: [] };
    const { ctx, page, errors } = await newPage({ width: 1440 });
    await openHome(page);
    const before = await page.evaluate(() => ({ slot: document.querySelector('[data-testid="home-visitors-now"]').textContent, secao: document.querySelector('[data-testid="home-live"]').textContent }));
    await shot(page, 'depois-1440-troca-de-loja-loja-a');
    await page.goto(`${BASE}/lojas`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Loja Brasil', { timeout: 20000 });
    const row = page.locator('s-table-row, tr, li, s-section').filter({ hasText: 'Loja Brasil' }).first();
    const useBtn = row.locator('s-button').filter({ hasNotText: /Ver|Editar/ }).first();
    await useBtn.dispatchEvent('click').catch(() => undefined);
    await page.waitForTimeout(800);
    await page.locator('.ds-shell-nav a[href="/"]').first().click();
    await page.waitForSelector('[data-testid="home-live"][data-state="ready"]');
    await page.waitForFunction(() => /Loja Brasil/.test(document.querySelector('#home-live-title')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    const after = await page.evaluate(() => ({ slot: document.querySelector('[data-testid="home-visitors-now"]').textContent, secao: document.querySelector('[data-testid="home-live"]').textContent }));
    await shot(page, 'depois-1440-troca-de-loja-loja-b');
    check('g_troca_de_loja', /108/.test(before.slot) && /23/.test(after.slot) && /Loja Brasil/.test(after.secao) && /Recife/.test(after.secao) && !/Lisboa|Sérum|544/.test(after.secao), { antes: before.slot, depois: after.slot, erros: errors });
    await ctx.close();
  }
} finally {
  report.resultados = results;
  report.falhas = failures;
  writeFileSync(join(OUT, 'depois-medicoes.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  api.close();
}
console.log(`\n${Object.keys(results).length - failures.length}/${Object.keys(results).length} ok`);
if (failures.length) {
  console.log('falhas:', failures.join(', '));
  process.exit(1);
}
