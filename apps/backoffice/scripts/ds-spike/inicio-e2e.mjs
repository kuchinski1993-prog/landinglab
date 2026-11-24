/* eslint-env browser, node */
/* eslint-disable no-console */
// Story 21.5 · AC16 — Início estilo Shopify no navegador real (Chromium/Playwright do repo),
// padrão 20.5f: backoffice em `next start` desta branch (sem `.env*`), API em mock HTTP
// local (este script sobe o mock e troca os cenários), sessão = cookie `blackshop.sid`.
// Grava prints (1920/1440/1280/390 e cenários), `comparacao-lado-a-lado.png` (recorte do
// print da Shopify × o nosso, mesmo recorte) e `depois-medicoes.json` (a–l do AC16).
//
// Uso:
//   1) cd apps/backoffice && NEXT_PUBLIC_API_URL=http://127.0.0.1:3071 npx next build && npx next start -p 3072
//   2) BASE_URL=http://localhost:3072 node apps/backoffice/scripts/ds-spike/inicio-e2e.mjs docs/prints/21.5
// Sai 1 se alguma verificação falhar.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const { chromium } = createRequire(join(repo, 'package.json'))('@playwright/test');

const BASE = process.env.BASE_URL ?? 'http://localhost:3072';
const API_PORT = Number(process.env.MOCK_API_PORT ?? 3071);
const OUT = resolve(repo, process.argv[2] ?? 'docs/prints/21.5');
const TMP = mkdtempSync(join(tmpdir(), 'inicio-e2e-'));
mkdirSync(OUT, { recursive: true });
const REF = join(repo, 'docs/prints/onda-16/referencia-shopify-inicio.png');
const WEBGL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

const results = {};
const failures = [];
const check = (key, ok, detail = {}) => {
  results[key] = { ok, ...detail };
  if (!ok) failures.push(key);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${key} ${JSON.stringify(detail).slice(0, 400)}`);
  return ok;
};

// ── Mock da API ────────────────────────────────────────────────────────────
const UPDATED = new Date().toISOString();
const STORES = [
  { id: 'loja-a', name: 'Voss Concept', domain: null, shopifyDomain: 'voss.myshopify.com', isActive: true },
  { id: 'loja-b', name: 'Loja Brasil', domain: null, shopifyDomain: 'brasil.myshopify.com', isActive: true },
];
const cur = (list) => list.map(([currency, total, orders = 1]) => ({ currency, total, orders, averageTicket: total / orders, previousTotal: 0, previousOrders: 0, changePct: null }));
const salesOf = (storeId, base, shopify, landing = []) => ({
  storeId, range: 'today', timezoneLabel: 'horário de Brasília', baseCurrency: base, updatedAt: UPDATED,
  sources: [
    { source: 'shopify', label: 'Pedidos da loja (Shopify)', currencies: cur(shopify), withoutValue: { orders: 0, previousOrders: 0 }, series: [] },
    { source: 'landing', label: 'Pedidos das landings', currencies: cur(landing), withoutValue: { orders: 0, previousOrders: 0 }, series: [] },
  ],
});
const trafficOf = (storeId, sessions, changePct, paidOrders, conversionPct) => ({
  storeId, range: 'today', timezoneLabel: 'horário de Brasília', sessions, previousSessions: 2, changePct, paidOrders, conversionPct, minSessions: 30, updatedAt: UPDATED,
});
const att = (id, module, count, href) => ({ id, module, severity: 'warning', label: `${count} ${id}`, description: id, count, href, oldest: null });
const attentionOf = (items, unavailable = []) => ({ items, unavailable, updatedAt: UPDATED });

const BASE_SCENARIO = () => ({
  name: 'com-vendas',
  user: { id: 'u-owner', email: 'will@example.com', name: 'Will Kuchinski', role: 'owner' }, // formato real de /auth/me (22.1a/22.1b)
  assistant: { status: 200, body: { enabled: true } },
  modulesOff: [],
  sales: {
    'loja-a': salesOf('loja-a', 'EUR', [['EUR', 544, 5]]),
    'loja-b': salesOf('loja-b', 'BRL', [['BRL', 321, 3]]),
  },
  salesStatus: 200,
  traffic: {
    'loja-a': trafficOf('loja-a', 46, 200, 5, 10.87),
    'loja-b': trafficOf('loja-b', 77, -12.5, 3, 3.9),
  },
  attention: {
    'loja-a': attentionOf([
      att('shopify-to-ship', 'pedidos', 50, '/orders'),
      att('landing-to-ship', 'landinglab', 3, '/landing-orders'),
      att('emails-need-reply', 'atendimento', 10, '/trustshield/inbox?folder=needs_reply'),
      att('landing-support-open', 'landinglab', 2, '/landing-support'),
      att('products-out-of-sync', 'catalogo', 4, '/products'),
    ]),
    'loja-b': attentionOf([att('shopify-to-ship', 'pedidos', 7, '/orders')]),
  },
});
let scenario = BASE_SCENARIO();
const requests = [];

function accountSummary() {
  const row = (s, today) => ({
    id: s.id, name: s.name, kind: 'store', timezoneLabel: 'horário de Brasília', status: 'ok', attentionCount: 3, attentionPartial: false,
    attentionByModule: [{ module: 'pedidos', count: 3 }],
    sources: [{ source: 'shopify', label: 'x', today, last7Days: today, last30Days: today, withoutValue30Days: 0 }],
  });
  return { updatedAt: UPDATED, stores: [row(STORES[0], [{ currency: 'EUR', total: 544, orders: 5 }]), row(STORES[1], [{ currency: 'BRL', total: 321, orders: 3 }])] };
}

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const api = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${API_PORT}`);
  const p = url.pathname;
  const store = String(req.headers['x-store-id'] ?? 'loja-a');
  requests.push(`${req.method} ${p}${url.search}`);
  if (p === '/auth/me') return reply(res, 200, { authenticated: true, ...(scenario.user ? { user: scenario.user } : {}) });
  if (p === '/stores') return reply(res, 200, { items: STORES });
  const mod = /^\/stores\/([^/]+)\/modules$/.exec(p);
  if (mod) {
    const ids = ['catalogo', 'pedidos', 'loja-online', 'atendimento', 'marketing', 'landinglab', 'vsl', 'tracker'];
    return reply(res, 200, { storeId: decodeURIComponent(mod[1]), modules: ids.map((id) => ({ id, enabled: !scenario.modulesOff.includes(id) })) });
  }
  if (p === '/assistant/status') return scenario.assistant.status === 404 ? reply(res, 404, { message: 'Route GET:/assistant/status not found', error: 'Not Found', statusCode: 404 }) : reply(res, 200, scenario.assistant.body);
  if (p === '/home/store/sales') {
    if (scenario.salesStatus !== 200) return reply(res, 503, { code: 'HOME_BLOCK_UNAVAILABLE', message: 'Não foi possível carregar este bloco agora. Tente de novo em instantes.', details: { block: 'sales' } });
    return reply(res, 200, scenario.sales[store] ?? scenario.sales['loja-a']);
  }
  if (p === '/home/store/traffic') return reply(res, 200, scenario.traffic[store] ?? scenario.traffic['loja-a']);
  if (p === '/home/store/attention') return reply(res, 200, scenario.attention[store] ?? attentionOf([]));
  if (p === '/home/account/summary') return reply(res, 200, accountSummary());
  if (p === '/home/account/landinglab') return reply(res, 200, { tenantId: 'l0i', publishedLandings: 5, openSupportThreads: 2, last7Days: [], attention: { items: [], unavailable: [] }, updatedAt: UPDATED });
  if (p === '/home/account/vsl') return reply(res, 200, { published: 1, draft: 2, updatedAt: UPDATED });
  if (p === '/home/account/tracker') return reply(res, 200, { enabled: true, activeCampaigns: 6, clicksLast7Days: 84, updatedAt: UPDATED });
  if (p.startsWith('/admin/landing-support/threads')) return reply(res, 200, { unread: 0, items: [] });
  if (p.startsWith('/notifications')) return reply(res, 200, { unreadCount: 0, items: [] });
  return reply(res, 404, { code: 'NOT_FOUND', message: 'not found' });
});
await new Promise((r) => api.listen(API_PORT, '127.0.0.1', r));

// ── Navegador ───────────────────────────────────────────────────────────────
const browser = await chromium.launch({ args: WEBGL_ARGS });

async function newPage({ width = 1440, height = 900, store = 'loja-a', clock = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addCookies([
    { name: 'blackshop.sid', value: 'e2e', url: BASE },
    { name: 'bs:activeStoreId', value: store, url: BASE },
  ]);
  // CLS acumulado (layout-shift sem interação recente).
  await ctx.addInitScript(() => {
    window.__cls = 0;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.hadRecentInput) continue;
          window.__cls += e.value;
          window.__clsSources = (window.__clsSources || []).concat(
            (e.sources || []).map((src) => `${Math.round(e.value * 10000) / 10000} ${src.node?.className || src.node?.nodeName || '?'} ${Math.round(src.previousRect.top)}→${Math.round(src.currentRect.top)}`),
          );
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      /* sem suporte */
    }
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  if (clock) await page.clock.setFixedTime(clock);
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
  return { ctx, page, errors };
}

async function openHome(page, path = '/') {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="home-greeting"]', { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="home-strip"] .ds-skeleton-line'), null, { timeout: 15000 }).catch(() => undefined);
  await page.waitForSelector('[data-testid="home-block-account-summary"][data-state="ready"]', { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(600);
}

async function shot(page, name, fullPage = true) {
  if (!fullPage) {
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    return;
  }
  // A moldura da 20.14a é uma máscara `position: fixed`: o fullPage do Playwright a deixa cobrindo o
  // meio da página. Em vez disso, a viewport cresce até a altura do documento (a moldura acompanha).
  const vp = page.viewportSize();
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, h) });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await page.setViewportSize(vp);
  await page.waitForTimeout(200);
}

const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// (m) QA 21.5 — "Enviar" com o campo vazio: propriedade, estado interno e cor do botão do Polaris.
async function sendButtonState(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="home-assistant"] .ds-home-assistant__actions s-button:last-of-type');
    if (!el) return null;
    const inner = el.shadowRoot?.querySelector('button, a');
    const input = document.querySelector('[data-testid="home-assistant-input"]');
    return {
      vazio: (input?.value ?? '') === '',
      propriedade: el.disabled === true,
      atributo: el.hasAttribute('disabled'),
      propriaSombreada: Object.prototype.hasOwnProperty.call(el, 'disabled'),
      interno: inner ? inner.disabled === true || inner.getAttribute('aria-disabled') === 'true' : null,
      fundo: inner ? getComputedStyle(inner).backgroundColor : null,
    };
  });
}

async function layout(page) {
  return page.evaluate(() => {
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return { l: Math.round(b.left * 10) / 10, t: Math.round(b.top * 10) / 10, r: Math.round(b.right * 10) / 10, b: Math.round(b.bottom * 10) / 10, w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 };
    };
    const surface = document.querySelector('.ds-home-surface');
    const h1s = [...document.querySelectorAll('h1')];
    const h1 = h1s[0];
    const lines = h1 ? [...h1.querySelectorAll('.ds-home-greeting__line')] : [];
    const lineCenters = lines.map((ln) => {
      const range = document.createRange();
      range.selectNodeContents(ln);
      const b = range.getBoundingClientRect();
      return b.left + b.width / 2;
    });
    const cs = h1 ? getComputedStyle(h1) : null;
    const cards = [...document.querySelectorAll('.ds-home-card')].map(r);
    const firstRow = cards.filter((c) => Math.abs(c.t - (cards[0]?.t ?? 0)) < 2);
    const gaps = firstRow.slice(1).map((c, i) => Math.round((c.l - firstRow[i].r) * 10) / 10);
    const sb = surface ? r(surface) : null;
    const grid = document.querySelector('.ds-home-cards');
    const gb = grid ? r(grid) : null;
    const descs = [...document.querySelectorAll('.ds-home-card__desc')].map((d) => {
      const st = getComputedStyle(d);
      const lh = parseFloat(st.lineHeight);
      return { cortado: d.scrollHeight > d.clientHeight + 1 || st.textOverflow === 'ellipsis', linhas: Math.round(d.getBoundingClientRect().height / lh) };
    });
    return {
      h1Count: h1s.length,
      h1Text: h1?.textContent ?? null,
      h1FontSize: cs?.fontSize,
      h1FontWeight: cs?.fontWeight,
      h1FontFamily: cs?.fontFamily,
      painelCentroX: sb ? sb.l + sb.w / 2 : null,
      linhasCentroX: lineCenters,
      assistente: document.querySelector('[data-testid="home-assistant"]') ? r(document.querySelector('[data-testid="home-assistant"]')) : null,
      grade: gb,
      gradeMargens: gb && sb ? { esquerda: Math.round(gb.l - sb.l), direita: Math.round(sb.r - gb.r) } : null,
      colunasPrimeiraFileira: firstRow.length,
      larguraCartoes: firstRow.map((c) => c.w),
      vaos: gaps,
      cartoes: cards.length,
      descricoes: descs,
      faixa: document.querySelector('[data-testid="home-strip"]') ? r(document.querySelector('[data-testid="home-strip"]')) : null,
      globos: document.querySelectorAll('[data-testid="corner-globe"]').length,
      globo: document.querySelector('[data-testid="corner-globe"]') ? r(document.querySelector('[data-testid="corner-globe"]')) : null,
      cardIds: [...document.querySelectorAll('.ds-home-card')].map((a) => a.getAttribute('data-testid')),
      fallbacks: document.querySelectorAll('.ds-home-card__media--fallback').length,
      imagens: document.querySelectorAll('img.ds-home-card__media').length,
    };
  });
}

/** Cursor no ponto (desce no shadow DOM e no slot). */
async function cursorAt(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    let b = el.getBoundingClientRect();
    // s-button pode ter caixa vazia no host (display: contents): mede o botão/link interno.
    if (b.width === 0 || b.height === 0) {
      const inner = el.shadowRoot?.querySelector('button, a');
      if (inner) b = inner.getBoundingClientRect();
    }
    const x = b.left + b.width / 2;
    const y = b.top + b.height / 2;
    let hit = document.elementFromPoint(x, y);
    let depth = 0;
    while (hit && hit.shadowRoot && depth < 5) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
      depth += 1;
    }
    let target = hit?.assignedSlot ?? hit;
    // Texto do rótulo é luz (slot): o ponto cai no host; o cursor efetivo é o do <a>/<button>
    // interno do shadow DOM que contém o ponto.
    if (target?.shadowRoot) {
      const inner = [...target.shadowRoot.querySelectorAll('a, button')].find((n) => {
        const r = n.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      });
      if (inner) target = inner;
    }
    return { tag: target?.tagName?.toLowerCase() ?? null, cursor: target ? getComputedStyle(target).cursor : null };
  }, selector);
}

function lum(r, g, b) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const analysis = await (await browser.newContext()).newPage();
await analysis.goto('about:blank');

/** Pixels de um PNG (base64) numa caixa: [r,g,b] mais escuro e mais claro. */
async function extremes(b64, box) {
  return analysis.evaluate(async ({ b64, box }) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const x = c.getContext('2d');
    x.drawImage(bmp, 0, 0);
    const { data } = x.getImageData(Math.max(0, Math.floor(box.l)), Math.max(0, Math.floor(box.t)), Math.max(1, Math.floor(box.w)), Math.max(1, Math.floor(box.h)));
    let dark = [255, 255, 255];
    let darkSum = 765;
    for (let i = 0; i < data.length; i += 4) {
      const s = data[i] + data[i + 1] + data[i + 2];
      if (s < darkSum) {
        darkSum = s;
        dark = [data[i], data[i + 1], data[i + 2]];
      }
    }
    return { dark };
  }, { b64, box });
}

/** Contraste do texto da faixa/saudação sobre o PIOR pixel do fundo (globo) atrás dele. */
async function contrastOverGlobe(page) {
  const boxes = await page.evaluate(() => {
    const pick = (sel) =>
      [...document.querySelectorAll(sel)].map((el) => {
        const b = el.getBoundingClientRect();
        return { sel, l: b.left, t: b.top, w: b.width, h: b.height, color: getComputedStyle(el).color };
      });
    return [...pick('.ds-home-strip__label'), ...pick('.ds-home-strip__value'), ...pick('.ds-home-strip__today'), ...pick('.ds-home-visitors'), ...pick('.ds-home-greeting__line')].filter((b) => b.w > 0);
  });
  await page.addStyleTag({ content: '.ds-home { color: transparent !important; } .ds-home * { color: transparent !important; text-decoration-color: transparent !important; } .ds-home-strip__warn, .ds-home-visitors__dot { visibility: hidden !important; }' });
  await page.waitForTimeout(150);
  const png = (await page.screenshot()).toString('base64');
  let worst = null;
  for (const b of boxes) {
    const { dark } = await extremes(png, b);
    const m = /rgba?\((\d+), (\d+), (\d+)/.exec(b.color);
    const text = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [48, 48, 48];
    const l1 = lum(...dark);
    const l2 = lum(...text);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    if (!worst || ratio < worst.ratio) worst = { ratio: Math.round(ratio * 100) / 100, sel: b.sel, fundoMaisEscuro: dark, texto: text };
  }
  return worst;
}

async function composeSideBySide(file, tiles) {
  const png = await analysis.evaluate(async (items) => {
    const bmps = [];
    for (const it of items) bmps.push(await createImageBitmap(await (await fetch(`data:image/png;base64,${it.b64}`)).blob(), it.crop.sx, it.crop.sy, it.crop.sw, it.crop.sh));
    const W = 1500;
    const lh = 30;
    const heights = bmps.map((b) => Math.round((b.height * W) / b.width));
    const c = new OffscreenCanvas(W * 2 + 30, Math.max(...heights) + lh + 20);
    const x = c.getContext('2d');
    x.fillStyle = '#e9e9e9';
    x.fillRect(0, 0, c.width, c.height);
    bmps.forEach((b, i) => {
      const px = 10 + i * (W + 10);
      x.fillStyle = '#1a1a1a';
      x.fillRect(px, 10, W, lh);
      x.fillStyle = '#fff';
      x.font = '600 16px sans-serif';
      x.fillText(items[i].label, px + 10, 31);
      x.drawImage(b, px, 10 + lh, W, heights[i]);
    });
    const blob = await c.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, tiles);
  writeFileSync(join(OUT, file), Buffer.from(png, 'base64'));
}

async function setScenario(over) {
  scenario = { ...BASE_SCENARIO(), ...over };
}

const report = { base: BASE, geradoEm: new Date().toISOString(), navegador: browser.version(), temp: TMP };
try {
  // ── Larguras: 1920 / 1440 / 1280 com vendas e pendências ───────────────
  const ours = {};
  for (const width of [1920, 1440, 1280]) {
    await setScenario({});
    const { ctx, page, errors } = await newPage({ width, clock: new Date('2026-11-04T09:30:00') });
    requests.length = 0;
    await openHome(page);
    await shot(page, `depois-${width}-com-vendas`);
    ours[width] = (await page.screenshot()).toString('base64');
    const L = await layout(page);
    report[`layout${width}`] = L;
    const centerOk = L.linhasCentroX.every((cx) => Math.abs(cx - L.painelCentroX) <= 8);
    check(`a_h1_${width}`, L.h1Count === 1 && L.h1FontSize === '26px' && L.h1FontWeight === '700' && /ShopifyInter/.test(L.h1FontFamily) && centerOk, {
      h1: L.h1Text, fontSize: L.h1FontSize, fontWeight: L.h1FontWeight, centroPainel: L.painelCentroX, centrosLinhas: L.linhasCentroX.map((v) => Math.round(v * 10) / 10),
    });
    check(`b_assistente_e_grade_${width}`, L.assistente && L.assistente.w <= 620 && L.colunasPrimeiraFileira === 3 && L.vaos.every((g) => Math.abs(g - 16) <= 1) && Math.abs(L.gradeMargens.esquerda - L.gradeMargens.direita) <= 2, {
      larguraAssistente: L.assistente?.w, colunas: L.colunasPrimeiraFileira, larguraCartoes: L.larguraCartoes, vaos: L.vaos, grade: L.grade, margens: L.gradeMargens,
    });
    check(`c_sem_rolagem_horizontal_${width}`, await noHScroll(page), {});
    check(`d_texto_dos_cartoes_inteiro_${width}`, L.descricoes.every((d) => !d.cortado && d.linhas <= 3), { linhas: L.descricoes.map((d) => d.linhas) });
    const btn = await cursorAt(page, '[data-testid="home-card-vsl"] s-button');
    const body = await cursorAt(page, '[data-testid="home-card-vsl"] .ds-home-card__desc');
    const media = await cursorAt(page, '[data-testid="home-card-vsl"] .ds-home-card__media');
    const chip = await cursorAt(page, '[data-testid="home-chip-to-ship"]');
    check(`e_cursor_${width}`, btn?.cursor === 'pointer' && chip?.cursor === 'pointer' && body?.cursor !== 'pointer' && media?.cursor !== 'pointer', { botao: btn, chip, corpo: body, ilustracao: media });
    const envio = await sendButtonState(page);
    check(`m_enviar_desabilitado_com_campo_vazio_${width}`, !!envio && envio.vazio && envio.propriedade && envio.atributo && !envio.propriaSombreada && envio.interno !== false, envio ?? {});
    check(`k_um_globo_${width}`, L.globos === 1, { globo: L.globo, faixa: L.faixa });
    const cls = await page.evaluate(() => window.__cls);
    const clsSources = await page.evaluate(() => (window.__clsSources || []).slice(0, 12));
    check(`i_cls_${width}`, cls < 0.02, { cls: Math.round(cls * 10000) / 10000, imagens: L.imagens, fallbacks: L.fallbacks, fontes: clsSources });
    const homeReqs = requests.filter((r) => !r.includes('/_next/'));
    report[`requisicoes${width}`] = [...new Set(homeReqs)];
    check(`l_requisicoes_${width}`, !homeReqs.some((r) => r.includes('/admin/live/overview')) && homeReqs.some((r) => r.includes('/assistant/status')) && errors.length === 0, { requisicoes: [...new Set(homeReqs)], erros: errors });
    check(`j_contraste_sobre_o_globo_${width}`, ((await contrastOverGlobe(page))?.ratio ?? 0) >= 4.5, { pior: await (async () => report[`contraste${width}`])() });
    await ctx.close();
  }
  // contraste: repete e guarda o detalhe (a função muda o estilo da página)
  for (const width of [1920, 1440, 1280]) {
    await setScenario({});
    const { ctx, page } = await newPage({ width });
    await openHome(page);
    report[`contraste${width}`] = await contrastOverGlobe(page);
    results[`j_contraste_sobre_o_globo_${width}`].pior = report[`contraste${width}`];
    await ctx.close();
  }

  // ── Comparação lado a lado com o print da Shopify (mesmo recorte) ──────────
  {
    const ref = readFileSync(REF).toString('base64');
    // Print da Shopify (3393×1289) está em ~1:1 px CSS (cartão ≈ 300 px), num monitor muito largo
    // (painel ≈ 3177 px). Recorte na MESMA escala: 1200 px centrados na grade (centro x ≈ 1802),
    // da faixa até o fim da 1ª fileira de cartões (y ≈ 820). Também a versão do painel inteiro.
    const refCrop = { sx: 1802 - 600, sy: 0, sw: 1200, sh: 820 };
    const refFull = { sx: 216, sy: 0, sw: 3393 - 216, sh: 820 };
    const tiles = [{ label: 'Shopify (referencia-shopify-inicio.png) — 1200 px centrais, mesma escala', b64: ref, crop: refCrop }];
    for (const width of [1440]) {
      const { ctx, page } = await newPage({ width, height: 1100, clock: new Date('2026-11-04T09:30:00') });
      await setScenario({ user: null });
      await openHome(page);
      const L = await layout(page);
      const png = (await page.screenshot()).toString('base64');
      const firstCardBottom = await page.evaluate(() => document.querySelector('.ds-home-card')?.getBoundingClientRect().bottom ?? 700);
      tiles.push({ label: `BlackShop ${width} (esta branch, sem nome = "Bom dia!")`, b64: png, crop: { sx: 240, sy: 56, sw: width - 240, sh: Math.round(firstCardBottom + 12 - 56) } });
      report.comparacao = { recorteShopify: refCrop, recorteNosso: tiles[1].crop, layout: { h1: L.h1Text, assistente: L.assistente, grade: L.grade, vaos: L.vaos } };
      await ctx.close();
    }
    await composeSideBySide('comparacao-lado-a-lado.png', tiles);
    await composeSideBySide('comparacao-lado-a-lado-painel-inteiro.png', [{ ...tiles[0], label: 'Shopify — painel inteiro (monitor largo)', crop: refFull }, tiles[1]]);
    for (const width of [1920, 1280]) {
      const firstCardBottom = 760;
      await composeSideBySide(`comparacao-lado-a-lado-${width}.png`, [tiles[0], { label: `BlackShop ${width}`, b64: ours[width], crop: { sx: 240, sy: 56, sw: width - 240, sh: Math.min(900 - 56, firstCardBottom) } }]);
    }
  }

  // ── Cenários (1440) ───────────────────────────────────────────────────────
  const scenarios = [
    ['sem-vendas', { sales: { 'loja-a': salesOf('loja-a', 'EUR', []) }, traffic: { 'loja-a': trafficOf('loja-a', 6, 200, 0, null) }, attention: { 'loja-a': attentionOf([]) } }],
    ['uma-moeda', {}],
    ['duas-moedas', { sales: { 'loja-a': salesOf('loja-a', 'EUR', [['EUR', 544, 5], ['BRL', 1200, 2]]) } }],
    ['conversao-indisponivel', { traffic: { 'loja-a': trafficOf('loja-a', 12, 50, 1, null) } }],
    ['vendas-em-erro', { salesStatus: 503 }],
    ['assistente-ausente-404', { assistant: { status: 404 } }],
    ['assistente-desligado', { assistant: { status: 200, body: { enabled: false, reason: 'disabled', envEnabled: false } } }],
    ['assistente-ativo', {}],
    ['vsl-desligado', { modulesOff: ['vsl'] }],
  ];
  for (const [name, over] of scenarios) {
    await setScenario(over);
    const { ctx, page, errors } = await newPage({ width: 1440 });
    await openHome(page);
    if (name === 'duas-moedas') await page.click('.ds-home-strip__more-btn');
    await shot(page, `depois-1440-${name}`);
    const s = await page.evaluate(() => ({
      faixa: document.querySelector('[data-testid="home-strip"]')?.textContent ?? '',
      vendas: document.querySelector('[data-testid="home-strip-sales"]')?.textContent ?? '',
      conversao: document.querySelector('[data-testid="home-strip-conversion"]')?.textContent ?? '',
      sessoes: document.querySelector('[data-testid="home-strip-sessions"]')?.textContent ?? '',
      moedas: [...document.querySelectorAll('[data-testid="home-strip-currencies"] li')].map((li) => li.textContent),
      assistente: document.querySelector('[data-testid="home-assistant"]')?.getAttribute('data-state') ?? 'ausente',
      ajuda: document.querySelector('[data-testid="home-assistant-help"]')?.textContent ?? null,
      cartoes: [...document.querySelectorAll('.ds-home-card')].map((a) => a.getAttribute('data-testid')),
      blocoVsl: Boolean(document.querySelector('[data-testid="home-block-vsl"]')),
      chips: [...document.querySelectorAll('.ds-home-chip')].map((c) => c.getAttribute('aria-label')),
    }));
    report[`cenario-${name}`] = { ...s, erros: errors };
    if (name === 'sem-vendas') check('cenario_sem_vendas', /Sem vendas/.test(s.vendas) && /—/.test(s.conversao) && !/0,00/.test(s.vendas), s);
    if (name === 'uma-moeda') check('cenario_uma_moeda', /544,00/.test(s.vendas) && !/moeda/.test(s.vendas), s);
    if (name === 'duas-moedas') check('cenario_duas_moedas_sem_somar', s.moedas.length === 2 && /\+1 moeda/.test(s.vendas) && !/1\.744/.test(s.vendas), s);
    if (name === 'conversao-indisponivel') check('cenario_conversao_indisponivel', /—/.test(s.conversao) && /Poucas sessões hoje \(mínimo 30\)/.test(s.conversao) && !/0%/.test(s.conversao), s);
    if (name === 'vendas-em-erro') check('cenario_vendas_em_erro', /—/.test(s.vendas) && /Tentar de novo/.test(s.vendas) && /46/.test(s.sessoes) && !/Sem vendas|0,00/.test(s.vendas), s);
    if (name === 'assistente-ausente-404') check('cenario_assistente_404', s.assistente === 'ausente' && errors.filter((e) => !/404/.test(e)).length === 0, { ...s, erros: errors });
    if (name === 'assistente-desligado') check('cenario_assistente_desligado', s.assistente === 'disabled' && s.ajuda === 'O assistente está desligado.', s);
    if (name === 'assistente-ativo') {
      await page.fill('[data-testid="home-assistant-input"]', 'Como foram as vendas hoje?');
      await page.press('[data-testid="home-assistant-input"]', 'Enter');
      await page.waitForURL(/\/assistente/, { timeout: 15000 }).catch(() => undefined);
      check('cenario_assistente_ativo_envia', s.assistente === 'enabled' && /\/assistente/.test(page.url()), { ...s, url: page.url() });
    }
    if (name === 'vsl-desligado') check('h_cartoes_iguais_ao_menu_vsl_desligado', s.cartoes.length === 8 && !s.cartoes.includes('home-card-vsl') && !s.blocoVsl, s);
    await ctx.close();
  }

  // ── (f) saudação nos 3 horários e sem nome ─────────────────────────────────
  {
    const seen = {};
    for (const [label, iso, expected] of [['manha', '2026-11-04T09:00:00', 'Bom dia, Will!'], ['tarde', '2026-11-04T14:00:00', 'Boa tarde, Will!'], ['noite', '2026-11-04T20:00:00', 'Boa noite, Will!']]) {
      await setScenario({});
      const { ctx, page } = await newPage({ width: 1440, clock: new Date(iso) });
      await openHome(page);
      await page.waitForFunction((t) => document.querySelector('[data-testid="home-greeting"]')?.textContent?.includes(t), expected, { timeout: 10000 }).catch(() => undefined);
      seen[label] = await page.textContent('[data-testid="home-greeting"]');
      await shot(page, `depois-1440-saudacao-${label}`, false);
      await ctx.close();
    }
    await setScenario({ user: null });
    const { ctx, page } = await newPage({ width: 1440, clock: new Date('2026-11-04T09:00:00') });
    await openHome(page);
    seen.semNome = await page.textContent('[data-testid="home-greeting"]');
    await ctx.close();
    check('f_saudacao_por_horario_e_sem_nome', /^Bom dia, Will!/.test(seen.manha) && /^Boa tarde, Will!/.test(seen.tarde) && /^Boa noite, Will!/.test(seen.noite) && /^Bom dia! /.test(seen.semNome) && !/undefined/.test(seen.semNome), seen);
  }

  // ── (g) trocar de loja: faixa e chips mudam; nada da anterior fica ────────
  {
    await setScenario({});
    const { ctx, page, errors } = await newPage({ width: 1440 });
    await openHome(page);
    const before = await page.evaluate(() => ({ faixa: document.querySelector('[data-testid="home-strip"]').textContent, chips: document.querySelector('[data-testid="home-chips"]').textContent }));
    await page.goto(`${BASE}/lojas`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Loja Brasil', { timeout: 20000 });
    const row = page.locator('s-table-row, tr, li, s-section').filter({ hasText: 'Loja Brasil' }).first();
    const useBtn = row.locator('s-button').filter({ hasNotText: /Ver|Editar/ }).first();
    await useBtn.dispatchEvent('click').catch(() => undefined);
    await page.waitForTimeout(800);
    await page.locator('.ds-shell-nav a[href="/"]').first().click();
    await page.waitForSelector('[data-testid="home-greeting"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="home-strip-store"]')?.textContent === 'Loja Brasil', null, { timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    const after = await page.evaluate(() => ({ faixa: document.querySelector('[data-testid="home-strip"]').textContent, chips: document.querySelector('[data-testid="home-chips"]').textContent }));
    await shot(page, 'depois-1440-troca-de-loja-loja-b');
    check('g_troca_de_loja', /Voss Concept/.test(before.faixa) && /Loja Brasil/.test(after.faixa) && /77/.test(after.faixa) && !/544|46/.test(after.faixa) && /7/.test(after.chips) && !/50/.test(after.chips), { antes: before, depois: after, erros: errors });
    await ctx.close();
  }

  // ── 390 px ───────────────────────────────────────────────────────────────
  {
    await setScenario({});
    const { ctx, page } = await newPage({ width: 390, height: 844 });
    await openHome(page);
    await shot(page, 'depois-390-com-vendas');
    const L = await layout(page);
    check('c_sem_rolagem_horizontal_390', await noHScroll(page), { colunas: L.colunasPrimeiraFileira, globos: L.globos });
    report.layout390 = L;
    await ctx.close();
  }

  // ── (i) imagens: 9 ilustrações aprovadas (decisão 56) — peso, lazy, sem CLS e fallback ──
  {
    await setScenario({});
    const { ctx, page, errors } = await newPage({ width: 1440 });
    const imgs = [];
    page.on('response', async (r) => {
      if (!r.url().includes('/home-cards/')) return;
      const body = await r.body().catch(() => null);
      imgs.push({ arquivo: r.url().split('/home-cards/')[1], status: r.status(), bytes: body ? body.length : null, tipo: r.headers()['content-type'] });
    });
    await openHome(page);
    const antesDeRolar = imgs.length;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(800);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => [...document.querySelectorAll('img.ds-home-card__media')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 }).catch(() => undefined);
    const L = await layout(page);
    const attrs = await page.evaluate(() =>
      [...document.querySelectorAll('img.ds-home-card__media')].map((i) => ({
        alt: i.getAttribute('alt'), loading: i.getAttribute('loading'), width: i.getAttribute('width'), height: i.getAttribute('height'),
        natural: `${i.naturalWidth}x${i.naturalHeight}`, renderizada: `${Math.round(i.getBoundingClientRect().width)}x${Math.round(i.getBoundingClientRect().height)}`,
      })),
    );
    const cls = await page.evaluate(() => window.__cls);
    const total = imgs.reduce((n, i) => n + (i.bytes ?? 0), 0);
    report.imagens = { requisicoes: imgs, total, antesDeRolar, atributos: attrs, cls };
    check('i_imagens_pesos_lazy_cls', L.imagens === 9 && L.fallbacks === 0 && imgs.length === 9 && imgs.every((i) => i.status === 200 && i.bytes <= 70 * 1024 && /webp/.test(i.tipo ?? '')) && total <= 600 * 1024 && attrs.every((a) => a.alt === '' && a.loading === 'lazy' && a.width === '1120' && a.height === '560' && a.natural === '1120x560') && cls < 0.02 && errors.length === 0, {
      imagens: L.imagens, totalBytes: total, porArquivo: imgs.map((i) => `${i.arquivo} ${i.bytes}`), requisicoesAntesDeRolar: antesDeRolar, renderizada: attrs[0]?.renderizada, cls: Math.round(cls * 10000) / 10000, erros: errors,
    });
    await shot(page, 'depois-1440-ilustracoes-carregadas');
    await ctx.close();
  }
  {
    // Fallback: um arquivo removido (requisição abortada) ⇒ só aquele cartão cai na cor + ícone.
    await setScenario({});
    const { ctx, page } = await newPage({ width: 1440 });
    await page.route('**/home-cards/vsl.webp', (route) => route.abort());
    await openHome(page);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(800);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForSelector('[data-testid="home-card-fallback-vsl"]', { timeout: 10000 }).catch(() => undefined);
    const L = await layout(page);
    const vslOk = await page.evaluate(() => Boolean(document.querySelector('[data-testid="home-card-fallback-vsl"]')) && Boolean(document.querySelector('[data-testid="home-card-vsl"] s-button')));
    await shot(page, 'depois-1440-fallback-vsl-sem-arquivo', false);
    check('i_fallback_com_um_arquivo_removido', vslOk && L.fallbacks === 1 && L.imagens === 8, { imagens: L.imagens, fallbacks: L.fallbacks });
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
