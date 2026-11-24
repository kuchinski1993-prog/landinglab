/* eslint-env browser, node */
/* eslint-disable no-console */
// Story 21.6 · AC23 — verificação do assistente no navegador real (Chromium/Playwright) com a API
// REAL desta branch (apps/api/src/__tests__/helpers/assistant-browser-harness.ts: Postgres real em
// memória + modelo SIMULADO) e o painel em `next start` (rewrite /api/* → API), sem `.env*`.
//
// Uso:
//   1) cd apps/api && ASSISTANT_MODEL_MODE=fake npx tsx src/__tests__/helpers/assistant-browser-harness.ts
//   2) cd apps/backoffice && NEXT_PUBLIC_API_URL=http://127.0.0.1:3061 pnpm build && npx next start -p 3062
//   3) BASE_URL=http://localhost:3062 node apps/backoffice/scripts/ds-spike/assistant-e2e.mjs docs/prints/21.6
//
// Gera prints (1440, 1280, 390) e `depois-medicoes.json` (a–j do AC23). Sai 1 se algo falhar.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const { chromium } = createRequire(join(repo, 'package.json'))('@playwright/test');

const BASE = process.env.BASE_URL ?? 'http://localhost:3062';
const PASSWORD = 'test-session-secret-must-be-at-least-32-chars-long';
const OUT = resolve(repo, process.argv[2] ?? 'docs/prints/21.6');
mkdirSync(OUT, { recursive: true });

const results = {};
const failures = [];
const check = (key, ok, detail) => {
  results[key] = { ok, ...detail };
  if (!ok) failures.push(key);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${key} ${JSON.stringify(detail)}`);
};

async function context(browser, { width = 1440, height = 900, store = 'loja-a' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addCookies([{ name: 'bs:activeStoreId', value: store, url: BASE }]);
  const login = await ctx.request.post(`${BASE}/api/auth/login`, { data: { password: PASSWORD } });
  if (login.status() !== 200) throw new Error(`login falhou: ${login.status()}`);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  return { ctx, page, errors };
}

async function harness(ctx, path, init) {
  const res = init ? await ctx.request.post(`${BASE}/api/__harness/${path}`, { data: init }) : await ctx.request.get(`${BASE}/api/__harness/${path}`);
  return res.json();
}

async function settings(ctx, body) {
  const res = await ctx.request.put(`${BASE}/api/assistant/settings`, { data: body, headers: { 'x-store-id': 'loja-a' } });
  if (res.status() !== 200) throw new Error(`settings ${res.status()}`);
}

async function openAssistant(page, query = '') {
  await page.goto(`${BASE}/assistente${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1.ds-page-title', { timeout: 15000 });
}

async function ask(page, text) {
  await page.waitForSelector('[data-testid="assistant-input"]', { timeout: 15000 });
  await page.fill('[data-testid="assistant-input"]', text);
  await page.press('[data-testid="assistant-input"]', 'Enter');
}

async function waitAnswer(page) {
  await page.waitForSelector('[data-testid="assistant-consulted"], [data-testid="assistant-error"], [data-testid="assistant-msg-answer"] .ds-assistant-msg__meta', { timeout: 20000 });
}

async function shot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
}

async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

const browser = await chromium.launch();
try {
  // ── Owner, 1440 e 1280: vazio, pergunta completa, transmitindo/Parar ─────────────
  const owner = await context(browser, { width: 1440 });
  await settings(owner.ctx, { enabled: true, dailyCapUsd: 2 });
  await openAssistant(owner.page);
  await owner.page.waitForSelector('[data-testid="assistant-empty"]');
  await shot(owner.page, '1440-vazio-exemplos');

  // (c) título 26px/700 e ação na mesma linha
  const header = await owner.page.evaluate(() => {
    const h1 = document.querySelector('h1.ds-page-title');
    const action = document.querySelector('[data-testid="page-header-actions"]');
    const cs = h1 ? getComputedStyle(h1) : null;
    const hb = h1?.getBoundingClientRect();
    const ab = action?.getBoundingClientRect();
    return {
      fontSize: cs?.fontSize,
      fontWeight: cs?.fontWeight,
      titleCenterY: hb ? hb.top + hb.height / 2 : null,
      actionCenterY: ab ? ab.top + ab.height / 2 : null,
      actionText: action?.querySelector('s-button[variant="primary"]')?.textContent?.trim(),
    };
  });
  const dy = header.titleCenterY !== null && header.actionCenterY !== null ? Math.abs(header.titleCenterY - header.actionCenterY) : 999;
  check('c_titulo_26px_700_acao_mesma_linha', header.fontSize === '26px' && header.fontWeight === '700' && dy <= 8, { ...header, diferencaVerticalPx: Math.round(dy) });

  // pergunta "como foram as vendas essa semana" — resposta completa
  const posts = [];
  owner.page.on('request', (r) => {
    if (r.url().endsWith('/api/assistant/chat') && r.method() === 'POST') posts.push(Date.now());
  });
  await ask(owner.page, 'Como foram as vendas essa semana?');
  await owner.page.waitForSelector('text=Consultando vendas…', { timeout: 10000 }).catch(() => undefined);
  await owner.page.waitForSelector('[data-testid="page-header-actions"]');
  await owner.page.waitForTimeout(400);
  await shot(owner.page, '1440-transmitindo-parar');
  await waitAnswer(owner.page);
  await owner.page.waitForTimeout(300);
  await shot(owner.page, '1440-resposta-vendas-completa');
  const answerText = await owner.page.textContent('[data-testid="assistant-msg-answer"]');
  check('resposta_com_numeros_comparacao_recomendacoes', /€ 200,00/.test(answerText ?? '') && /\+300%/.test(answerText ?? '') && /Sugestões/.test(answerText ?? ''), {
    trecho: (answerText ?? '').slice(0, 160),
    consultou: await owner.page.textContent('[data-testid="assistant-consulted"]'),
  });

  // (a) streaming real por trás do rewrite: 1º delta antes do done, ≥ 2 chegadas separadas por ≥ 150 ms
  const stream = await owner.page.evaluate(async () => {
    const started = performance.now();
    const res = await fetch('/api/assistant/chat', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-store-id': 'loja-a' },
      body: JSON.stringify({ message: 'Como foram as vendas essa semana? (medição)' }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const arrivals = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = dec.decode(value, { stream: true });
      arrivals.push({ t: Math.round(performance.now() - started), delta: text.includes('event: delta'), done: text.includes('event: done') });
    }
    return { status: res.status, contentType: res.headers.get('content-type'), encoding: res.headers.get('content-encoding'), arrivals };
  });
  const deltas = stream.arrivals.filter((a) => a.delta);
  const doneAt = stream.arrivals.find((a) => a.done)?.t ?? null;
  const gaps = deltas.slice(1).map((a, i) => a.t - deltas[i].t);
  check('a_streaming_por_tras_do_rewrite', deltas.length >= 2 && doneAt !== null && deltas[0].t < doneAt && gaps.some((g) => g >= 150), {
    status: stream.status,
    contentType: stream.contentType,
    contentEncoding: stream.encoding,
    chegadasComDelta: deltas.length,
    primeiroDeltaMs: deltas[0]?.t ?? null,
    doneMs: doneAt,
    intervalosEntreDeltasMs: gaps,
  });

  // (b) Parar aborta e o servidor registra uso parcial
  const usageBefore = await harness(owner.ctx, 'usage');
  await ask(owner.page, 'Como foram as vendas essa semana? (vou parar)');
  await owner.page.waitForSelector('[data-testid="assistant-composer"] s-button:has-text("Parar")', { timeout: 10000 });
  await owner.page.waitForTimeout(500);
  await owner.page.locator('[data-testid="assistant-composer"] s-button:has-text("Parar")').dispatchEvent('click');
  await owner.page.waitForTimeout(1500);
  const usageAfter = await harness(owner.ctx, 'usage');
  const lastAnswer = await owner.page.evaluate(() => {
    const all = document.querySelectorAll('[data-testid="assistant-msg-answer"]');
    return all[all.length - 1]?.textContent ?? '';
  });
  check('b_parar_aborta_e_grava_uso_parcial', /Resposta interrompida/.test(lastAnswer) && usageAfter.n > usageBefore.n, { usoAntes: usageBefore, usoDepois: usageAfter, fimDaResposta: lastAnswer.slice(-40) });

  // 1280
  await owner.page.setViewportSize({ width: 1280, height: 900 });
  await owner.page.waitForTimeout(300);
  await shot(owner.page, '1280-conversa');
  const scroll1280 = await noHorizontalScroll(owner.page);
  await owner.page.setViewportSize({ width: 1440, height: 900 });
  const scroll1440 = await noHorizontalScroll(owner.page);

  // (e) HTML literal
  await owner.page.locator('[data-testid="page-header-actions"] s-button[variant="primary"]').dispatchEvent('click');
  await ask(owner.page, 'Mostre um exemplo com html');
  await waitAnswer(owner.page);
  await owner.page.waitForTimeout(800);
  await shot(owner.page, '1440-html-literal');
  const html = await owner.page.evaluate(() => {
    const answer = document.querySelector('[data-testid="assistant-msg-answer"]');
    return { tags: answer ? answer.querySelectorAll('a, img, script').length : -1, text: answer?.textContent ?? '' };
  });
  check('e_html_literal', html.tags === 0 && html.text.includes('<script>alert(1)</script>'), { elementosPerigososNoDom: html.tags });

  // (f) e-mail colado não chega ao modelo
  await owner.page.locator('[data-testid="page-header-actions"] s-button[variant="primary"]').dispatchEvent('click');
  await ask(owner.page, 'Meu e-mail é dono.loja@example.com, como foram as vendas essa semana?');
  await waitAnswer(owner.page);
  const captured = await harness(owner.ctx, 'last-model-request');
  const capturedText = JSON.stringify(captured.body ?? {});
  check('f_email_colado_mascarado', !capturedText.includes('dono.loja@example.com') && capturedText.includes('[e-mail]'), { contemEmail: capturedText.includes('dono.loja@example.com') });

  // (g) trocar de loja mostra outro histórico
  const listA = await owner.ctx.request.get(`${BASE}/api/assistant/conversations?limit=50`, { headers: { 'x-store-id': 'loja-a' } }).then((r) => r.json());
  await owner.ctx.addCookies([{ name: 'bs:activeStoreId', value: 'loja-b', url: BASE }]);
  await openAssistant(owner.page);
  await owner.page.waitForTimeout(800);
  const recentsB = await owner.page.$$eval('[data-testid="assistant-recent"]', (els) => els.length);
  await shot(owner.page, '1440-loja-b-outro-historico');
  check('g_troca_de_loja_outro_historico', listA.items.length > 0 && recentsB === 0, { conversasLojaA: listA.items.length, conversasLojaBNaTela: recentsB });
  await owner.ctx.addCookies([{ name: 'bs:activeStoreId', value: 'loja-a', url: BASE }]);

  // (i) ?q= envia 1 vez e some da URL
  posts.length = 0;
  await openAssistant(owner.page, `?q=${encodeURIComponent('Como foram as vendas essa semana?')}`);
  await waitAnswer(owner.page);
  const urlAfter = owner.page.url();
  await owner.page.reload({ waitUntil: 'domcontentloaded' });
  await owner.page.waitForTimeout(800);
  check('i_q_envia_uma_vez_e_sai_da_url', posts.length === 1 && !urlAfter.includes('q='), { postsDeChat: posts.length, urlDepois: urlAfter });

  // estados de erro: teto diário, desligado, sem chave, busy
  await settings(owner.ctx, { dailyCapUsd: 0 });
  await openAssistant(owner.page);
  await ask(owner.page, 'Como foram as vendas essa semana?');
  await owner.page.waitForSelector('[data-testid="assistant-error"]', { timeout: 10000 });
  await shot(owner.page, '1440-erro-teto-diario');
  results.erro_teto_diario = { ok: true, texto: await owner.page.textContent('[data-testid="assistant-error"]') };
  await settings(owner.ctx, { dailyCapUsd: 2, enabled: false });
  await openAssistant(owner.page);
  await owner.page.waitForSelector('[data-testid="assistant-unavailable"]');
  await shot(owner.page, '1440-desligado');
  await settings(owner.ctx, { enabled: true });
  await harness(owner.ctx, 'env', { mode: 'real' });
  await openAssistant(owner.page);
  await owner.page.waitForSelector('[data-testid="assistant-unavailable"][data-reason="no_key"]');
  await shot(owner.page, '1440-sem-chave');
  await harness(owner.ctx, 'env', { mode: 'fake' });

  const second = await owner.ctx.newPage();
  await openAssistant(owner.page);
  await second.goto(`${BASE}/assistente`, { waitUntil: 'domcontentloaded' });
  await ask(owner.page, 'Como foram as vendas essa semana? (aba 1)');
  await owner.page.waitForTimeout(300);
  await ask(second, 'Como foram as vendas essa semana? (aba 2)');
  await second.waitForSelector('[data-testid="assistant-error"][data-code="assistant_busy"]', { timeout: 10000 });
  await shot(second, '1440-assistant-busy');
  await second.close();
  await waitAnswer(owner.page);

  // menu do usuário com o item
  await owner.page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await owner.page.click('.ds-shell-user__trigger');
  await owner.page.waitForSelector('a[role="menuitem"][href="/assistente"]', { timeout: 10000 });
  await shot(owner.page, '1440-menu-do-usuario');

  // (j) custo na Saúde da operação → custos
  await owner.page.goto(`${BASE}/saude`, { waitUntil: 'domcontentloaded' });
  await owner.page.waitForTimeout(1500);
  await shot(owner.page, '1440-saude-custos');
  const overview = await owner.ctx.request.get(`${BASE}/api/admin/health/overview`).then((r) => r.json());
  const usageTotal = await harness(owner.ctx, 'usage');
  const aiMonth = Number(overview?.blocks?.costs?.details?.ai?.monthUsd ?? 0);
  check('j_custo_do_assistente_na_saude', aiMonth > 0 && aiMonth >= Math.floor(Number(usageTotal.total) * 100) / 100, { iaDoMesUsd: overview?.blocks?.costs?.details?.ai?.monthUsd, gastoAssistenteUsd: usageTotal.total, nota: overview?.blocks?.costs?.details?.ai?.note });

  // ── Member: não vê o teto editável ───────────────────────────────────────────────
  const member = await context(browser, { width: 1440 });
  await harness(member.ctx, 'as', { userId: 'membro-1', role: 'member' });
  await openAssistant(member.page);
  await member.page.waitForSelector('[data-testid="assistant-input"]');
  const memberView = await member.page.evaluate(() => ({
    configurar: Array.from(document.querySelectorAll('[data-testid="page-header-actions"] s-button')).some((b) => b.textContent?.trim() === 'Configurar'),
    uso: !!document.querySelector('[data-testid="assistant-usage"]'),
  }));
  await shot(member.page, '1440-member-sem-teto');
  check('h_member_sem_teto_editavel', !memberView.configurar && !memberView.uso, memberView);
  await member.ctx.close();

  // ── 390 px ───────────────────────────────────────────────────────────────────────
  const mobile = await context(browser, { width: 390, height: 844 });
  await openAssistant(mobile.page);
  await mobile.page.waitForSelector('[data-testid="assistant-input"]');
  await shot(mobile.page, '390-assistente');
  const scroll390 = await noHorizontalScroll(mobile.page);
  check('d_sem_rolagem_horizontal', scroll1280 && scroll1440 && scroll390, { em1280: scroll1280, em1440: scroll1440, em390: scroll390 });
  await mobile.ctx.close();

  check('sem_erros_de_pagina', owner.errors.length === 0, { erros: owner.errors.slice(0, 3) });
  await owner.ctx.close();
} catch (err) {
  failures.push(`exceção: ${String(err).slice(0, 300)}`);
  console.error(err);
} finally {
  await browser.close();
  writeFileSync(join(OUT, 'depois-medicoes.json'), `${JSON.stringify({ geradoEm: new Date().toISOString(), base: BASE, modelo: 'simulado (ASSISTANT_MODEL_MODE=fake)', resultados: results, falhas: failures }, null, 2)}\n`);
}
console.log(failures.length ? `FALHAS: ${failures.join(', ')}` : 'tudo ok');
process.exit(failures.length ? 1 : 0);
