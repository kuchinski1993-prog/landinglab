/* eslint-env browser, node */
/* eslint-disable no-console */
// Story 22.1c · AC16 — verificação da tela "Usuários", do contador do menu e da faixa de pedidos de
// acesso no navegador real (Chromium do Playwright do repo), com a API REAL da branch (buildServer +
// PGlite com as migrations de contas, repositório e loja de sessão Drizzle reais, mailer Resend real
// apontado para um mock HTTP local que pode devolver 500, limites de produção) e o painel em
// `next start` (rewrite /api/* → API), sem `.env*`. Sessões REAIS por login (owner e member).
//
// Uso (harness novo — o da 22.1b + `/__harness/resend-fail?on=1|0`):
//   1) API: harness em mktemp ouvindo em :3001 (cwd apps/api: npx tsx /tmp/h221c-*/users-api-harness.mts)
//   2) cd apps/backoffice && pnpm build && ADMIN_USER_IDS=admin-test npx next start -p 3000
//   3) node apps/backoffice/scripts/ds-spike/users-e2e.mjs docs/prints/22.1c
//
// Gera prints (1440, 1280, 390) e `depois-medicoes.json` (a–j do AC16). Sai 1 se algo falhar.
// Precisa de um harness recém-iniciado (o cadastro é limitado a 5 por hora por IP — usa exatamente 5).

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const { chromium } = createRequire(join(repo, 'package.json'))('@playwright/test');

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const HARNESS = process.env.HARNESS_URL ?? 'http://127.0.0.1:3001/__harness';
const OUT = resolve(repo, process.argv[2] ?? 'docs/prints/22.1c');
const OWNER = 'kuchinski1993@gmail.com';
const PW = { owner: 'Girassol-Trovao-Mesa-4821', member: 'Cometa-Laranja-Piano-2468' };
const USERS = '/settings/conta/usuarios';
mkdirSync(OUT, { recursive: true });

const results = {};
const failures = [];
const check = (key, ok, detail = {}) => {
  results[key] = { ok, ...detail };
  if (!ok) failures.push(key);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${key} ${JSON.stringify(detail).slice(0, 400)}`);
};

const browser = await chromium.launch();

async function newPage({ width = 1440, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  // (g) gancho de XSS: se algum texto do visitante executar, registra aqui.
  await ctx.addInitScript(() => {
    window.__xssHits = 0;
    window.__xss = () => {
      window.__xssHits += 1;
    };
  });
  const page = await ctx.newPage();
  const log = { requests: [], errors: [] };
  page.on('pageerror', (e) => log.errors.push(String(e).slice(0, 200)));
  page.on('request', (r) => log.requests.push({ url: r.url(), method: r.method() }));
  return { ctx, page, log };
}

const api = async (ctx, method, path, data) => {
  const res = await ctx.request.fetch(`${BASE}/api${path}`, { method, data, headers: { origin: BASE } });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status(), body };
};
const harness = async (path) => (await fetch(`${HARNESS}/${path}`)).json();
const lastLinkFor = async (email) => {
  const { emails } = await harness('emails');
  const mail = [...emails].reverse().find((m) => m.to.includes(email));
  return mail ? /https?:\/\/\S+\/criar-senha\?token=[^\s"<>]+/.exec(mail.text)?.[0] ?? null : null;
};
const waitLinkFor = async (email, previous = null) => {
  for (let i = 0; i < 60; i += 1) {
    const link = await lastLinkFor(email);
    if (link && link !== previous) return link;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
};
const shot = (page, name, fullPage = false) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setPasswordFromLink(page, link, password) {
  await page.goto(link, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[name="new-password"]');
  await page.fill('input[name="new-password"]', password);
  await page.fill('input[name="confirm-password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE}/`, { timeout: 15000 });
  await page.waitForSelector('[data-testid="shell-topbar"]');
}

async function gotoUsers(page, query = '') {
  await page.goto(`${BASE}${USERS}${query}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="users-table"], [data-testid="users-empty"], [data-testid="users-no-permission"]', { timeout: 15000 });
  await page.waitForTimeout(400);
}

const listUsers = async (ctx) => (await api(ctx, 'GET', '/admin/users?limit=100')).body?.items ?? [];
const pendingCountApi = async (ctx) => (await api(ctx, 'GET', '/admin/users/pending-count')).body?.count;

/** Número do contador do item "Usuários" (grupo aberto) ou do pai "Configurações da conta". */
const navBadge = (page, navId) =>
  page.evaluate((id) => {
    const link = document.querySelector(`[data-nav-id="${id}"]`);
    const badge = link?.querySelector('.ds-shell-nav__badge [aria-hidden="true"]');
    return { text: badge?.textContent ?? null, label: link?.textContent?.replace(/\s+/g, ' ').trim() ?? null };
  }, navId);

async function clickRowAction(page, userId, label) {
  await page.locator(`[data-testid="user-row"][data-user-id="${userId}"] s-button`, { hasText: new RegExp(`^${label}$`) }).first().click();
}

async function waitModalOpen(page) {
  await page.waitForFunction(() => {
    const m = document.getElementById('users-confirm-dialog');
    const dialog = m?.shadowRoot?.querySelector('dialog');
    return Boolean(dialog?.open);
  }, null, { timeout: 5000 });
  await page.waitForTimeout(350);
}

async function waitModalClosed(page) {
  await page.waitForFunction(() => {
    const dialog = document.getElementById('users-confirm-dialog')?.shadowRoot?.querySelector('dialog');
    return !dialog?.open;
  }, null, { timeout: 10000 });
}

const modalButton = (page, label) => page.locator('#users-confirm-dialog > s-button', { hasText: new RegExp(`^${label}$`) });
const feedbackText = (page) => page.locator('[data-testid="action-feedback"]').first().textContent({ timeout: 10000 });

async function selectTab(page, name) {
  await page.locator('[data-testid="users-tabs"] button[role="tab"]', { hasText: new RegExp(`^${name}`) }).click();
  await page.waitForTimeout(250);
}

// ── 0. Owner cria a senha (esqueci → e-mail no mock → /criar-senha) e entra ──
const owner = await newPage();
{
  const forgot = await api(owner.ctx, 'POST', '/auth/forgot', { email: OWNER });
  const link = await waitLinkFor(OWNER);
  await setPasswordFromLink(owner.page, link, PW.owner);
  check('setup_owner_logado', forgot.status === 202 && Boolean(link));
}

// ── 1. Member: cadastro (API) → owner aprova (API) → e-mail → member cria a senha e entra ──
const member = await newPage();
let memberId;
{
  const signup = await api(member.ctx, 'POST', '/auth/signup', { name: 'Bruno Membro', email: 'bruno@exemplo.com', note: 'Pedidos das lojas' });
  memberId = (await listUsers(owner.ctx)).find((u) => u.email === 'bruno@exemplo.com')?.id;
  const approved = await api(owner.ctx, 'POST', `/admin/users/${memberId}/approve`);
  const link = await waitLinkFor('bruno@exemplo.com');
  await setPasswordFromLink(member.page, link, PW.member);
  check('setup_member_logado', signup.status === 202 && approved.status === 200 && approved.body?.mail === 'sent', { approved: approved.body });
}

// ── 2. Três pedidos pendentes: um pela tela "Criar conta" (cadastro real), dois pela API (um com XSS) ──
const XSS_NAME = '<img src=x onerror="window.__xss()">';
const XSS_NOTE = '<script>window.__xss()</script> preciso do painel';
{
  const visitor = await newPage();
  await visitor.page.goto(`${BASE}/login/criar-conta`, { waitUntil: 'networkidle' });
  await visitor.page.fill('input[name="name"]', 'Carla Pedido');
  await visitor.page.fill('input[name="email"]', 'carla@exemplo.com');
  await visitor.page.fill('textarea[name="note"]', 'Vou cuidar do atendimento das lojas da Europa.');
  await visitor.page.click('button[type="submit"]');
  await visitor.page.waitForSelector('[data-testid="signup-received"]');
  await visitor.ctx.close();
  await sleep(1300); // datas de pedido distintas (ordem do mais antigo ao mais novo)
  await api(member.ctx, 'POST', '/auth/signup', { name: XSS_NAME, email: 'xss@exemplo.com', note: XSS_NOTE });
  await sleep(1300);
  await api(member.ctx, 'POST', '/auth/signup', { name: 'Diego Pedido', email: 'diego@exemplo.com' });
  await sleep(800);
}
const ids = Object.fromEntries((await listUsers(owner.ctx)).map((u) => [u.email, u.id]));

// ── 3. Tela com 3 pendentes (1440/1280/390), Todos, medições (a)(b)(c)(g) e menu com contador ──
{
  const { page } = owner;
  await gotoUsers(page);
  const pendingApi = await pendingCountApi(owner.ctx);
  const order = await page.$$eval('[data-testid="user-row"]', (rows) => rows.map((r) => r.getAttribute('data-user-id')));
  check('pendentes_aba_padrao_mais_antigo_primeiro', order.join() === [ids['carla@exemplo.com'], ids['xss@exemplo.com'], ids['diego@exemplo.com']].join(), {
    pendingApi,
    tabs: await page.$$eval('[data-testid="users-tabs"] button', (b) => b.map((x) => `${x.textContent}${x.getAttribute('aria-selected') === 'true' ? ' *' : ''}`)),
  });
  // (d) contador do item = pendentes reais da API
  const badge = await navBadge(page, 'config-usuarios');
  results.d_contador_antes = { badge, pendingApi };
  // Abre a mensagem do pedido com XSS para provar que é texto
  await page.locator(`[data-user-id="${ids['xss@exemplo.com']}"] s-button`, { hasText: 'Ver mensagem' }).click();
  await page.waitForTimeout(300);
  await shot(page, 'usuarios-pendentes-1440');
  // (a) título 26px/700 e ações na mesma linha
  const a = await page.evaluate(() => {
    const h1 = document.querySelector('h1.ds-page-title');
    const actions = document.querySelector('[data-testid="page-header-actions"]');
    const s = getComputedStyle(h1);
    const hr = h1.getBoundingClientRect();
    const ar = actions.getBoundingClientRect();
    return {
      text: h1.textContent,
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      fontFamily: s.fontFamily.split(',')[0],
      titleCenterY: hr.top + hr.height / 2,
      actionsCenterY: ar.top + ar.height / 2,
      deltaY: Math.abs(hr.top + hr.height / 2 - (ar.top + ar.height / 2)),
    };
  });
  check('a_titulo_26_700_acoes_na_linha', a.text === 'Usuários' && a.fontSize === '26px' && a.fontWeight === '700' && a.deltaY <= 8, a);
  // (c) cursor pointer só nos botões (linha não clicável): elementFromPoint profundo + assignedSlot
  const c = await page.evaluate(() => {
    // Cursor efetivo como na 20.5f: nó de texto sob o ponto → `assignedSlot` → estilo computado;
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
        if (!n.textContent.trim() || n.parentElement.closest('s-button')) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const r = range.getBoundingClientRect();
        if (r.width) return { x: r.left + Math.min(r.width / 2, 20), y: r.top + r.height / 2, text: n.textContent.trim().slice(0, 20) };
      }
      return null;
    }
    const out = [];
    for (const row of document.querySelectorAll('[data-testid="user-row"]')) {
      for (const cell of row.querySelectorAll('s-table-cell')) {
        const r = cell.getBoundingClientRect();
        out.push({ kind: 'cell-vazio', ...effectiveCursor(r.right - 4, r.bottom - 4) });
        const t = textCenter(cell);
        if (t) out.push({ kind: 'cell-texto', text: t.text, ...effectiveCursor(t.x, t.y) });
      }
      for (const btn of row.querySelectorAll('s-button')) {
        // o host do s-button é `display: contents`: mede o botão de dentro do Shadow DOM
        const inner = btn.shadowRoot?.querySelector('button, a') ?? btn;
        const r = inner.getBoundingClientRect();
        if (!r.width) continue;
        out.push({ kind: 'button', label: btn.textContent.trim(), ...effectiveCursor(r.left + r.width / 2, r.top + r.height / 2) });
      }
    }
    return out;
  });
  const cellsPointer = c.filter((x) => x.kind.startsWith('cell') && x.cursor === 'pointer');
  const buttonsNotPointer = c.filter((x) => x.kind === 'button' && x.cursor !== 'pointer');
  check('c_cursor_pointer_so_nos_botoes', cellsPointer.length === 0 && buttonsNotPointer.length === 0 && c.some((x) => x.kind === 'button'), {
    cells: c.filter((x) => x.kind.startsWith('cell')).length,
    textCells: c.filter((x) => x.kind === 'cell-texto').map((x) => `${x.text}:${x.cursor}`),
    buttons: c.filter((x) => x.kind === 'button').map((x) => `${x.label}:${x.cursor}`),
    cellsPointer,
  });
  // (g) XSS literal e não executado
  const g = await page.evaluate((xssId) => {
    const row = document.querySelector(`[data-user-id="${xssId}"]`);
    return {
      hits: window.__xssHits,
      nameLiteral: row?.textContent?.includes('<img src=x onerror="window.__xss()">') ?? false,
      noteLiteral: document.querySelector('[data-testid="user-note"]')?.textContent?.includes('<script>window.__xss()</script>') ?? false,
      injected: row ? row.querySelectorAll('img, script').length : -1,
    };
  }, ids['xss@exemplo.com']);
  check('g_xss_nao_executa_texto_literal', g.hits === 0 && g.nameLiteral && g.noteLiteral && g.injected === 0, g);
  check('b_sem_rolagem_horizontal_1440', await noHScroll(page));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(300);
  check('b_sem_rolagem_horizontal_1280', await noHScroll(page));
  await shot(page, 'usuarios-pendentes-1280');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await shot(page, 'usuarios-pendentes-390');
  results.lista_390_rolagem_horizontal_da_pagina = !(await noHScroll(page));
  await page.setViewportSize({ width: 1440, height: 900 });
  await selectTab(page, 'Todos');
  await shot(page, 'usuarios-todos-1440');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot(page, 'usuarios-todos-1280');
  await page.setViewportSize({ width: 1440, height: 900 });
  // menu com contador (pai fechado numa tela de loja)
  await page.goto(`${BASE}/orders`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const parent = await navBadge(page, 'config-conta');
  check('d_contador_igual_api', badge.text === String(pendingApi) && parent.text === String(pendingApi), { item: badge, pai: parent, pendingApi });
}

// ── 4. Faixa: aparece, dispensa, não volta ao navegar, VOLTA com um pedido novo (f) ──
{
  const { page } = owner;
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const banner = await page.waitForSelector('[data-testid="shell-access-requests"]', { timeout: 10000 });
  const bannerText = (await banner.textContent())?.trim();
  await shot(page, 'shell-faixa-pedidos-1440');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot(page, 'shell-faixa-pedidos-1280');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[data-testid="shell-access-requests"] button', { hasText: 'Dispensar' }).click();
  await page.waitForTimeout(200);
  const goneAfterDismiss = (await page.$('[data-testid="shell-access-requests"]')) === null;
  await page.click('[data-nav-id="pedidos"]');
  await page.waitForURL(`${BASE}/orders`);
  await page.waitForTimeout(800);
  const stillGone = (await page.$('[data-testid="shell-access-requests"]')) === null;
  // Novo pedido de acesso durante o teste (cadastro pela API, como a tela de criar conta faz)
  const signup = await api(member.ctx, 'POST', '/auth/signup', { name: 'Elisa Nova', email: 'elisa@exemplo.com' });
  await page.click('[data-nav-id="lucro"]');
  await page.waitForURL(`${BASE}/lucro`);
  const back = await page.waitForSelector('[data-testid="shell-access-requests"]', { timeout: 10000 }).catch(() => null);
  const backText = back ? (await back.textContent())?.trim() : null;
  await shot(page, 'shell-faixa-voltou-1440');
  // Ver pedidos → aba Pendentes
  await page.locator('[data-testid="shell-access-requests"] a', { hasText: 'Ver pedidos' }).click();
  await page.waitForURL((u) => u.pathname === USERS);
  await page.waitForSelector('[data-testid="users-table"]');
  const selected = await page.$eval('[data-testid="users-tabs"] [aria-selected="true"]', (b) => b.textContent);
  const bannerOnUsers = (await page.$('[data-testid="shell-access-requests"]')) !== null;
  check('f_faixa_dispensada_nao_volta_e_volta_com_pedido_novo', goneAfterDismiss && stillGone && signup.status === 202 && /4 pedidos/.test(backText ?? '') && /^Pendentes/.test(selected) && !bannerOnUsers, {
    bannerText,
    goneAfterDismiss,
    stillGone,
    backText,
    selected,
    bannerOnUsers,
  });
}
ids['elisa@exemplo.com'] = (await listUsers(owner.ctx)).find((u) => u.email === 'elisa@exemplo.com')?.id;

// ── 5. (h)(i)(d) Aprovar a Carla com duplo clique: 1 requisição, e-mail no mock, mail: sent, contador cai ──
{
  const { page, log } = owner;
  await gotoUsers(page);
  const before = await navBadge(page, 'config-usuarios');
  const emailsBefore = (await harness('emails')).emails.length;
  await clickRowAction(page, ids['carla@exemplo.com'], 'Aprovar');
  await waitModalOpen(page);
  const focus = await page.evaluate(() => {
    const el = document.activeElement;
    return { tag: el?.tagName ?? null, text: el?.textContent?.trim() ?? null, slot: el?.getAttribute('slot') ?? null };
  });
  check('foco_inicial_no_cancelar', focus.text === 'Cancelar', focus);
  await shot(page, 'usuarios-confirmar-aprovar-1440');
  const start = log.requests.length;
  await modalButton(page, 'Aprovar e enviar convite').dblclick();
  const fb = await feedbackText(page);
  await waitModalClosed(page);
  await page.waitForTimeout(800);
  const approveReqs = log.requests.slice(start).filter((r) => r.method === 'POST' && r.url.endsWith(`/api/admin/users/${ids['carla@exemplo.com']}/approve`));
  check('h_duplo_clique_1_requisicao', approveReqs.length === 1, { requests: approveReqs.length });
  const mails = (await harness('emails')).emails.slice(emailsBefore);
  const carlaMail = mails.find((m) => m.to.includes('carla@exemplo.com'));
  const after = await navBadge(page, 'config-usuarios');
  const pendingApi = await pendingCountApi(owner.ctx);
  check('i_fim_a_fim_cadastro_aprovar_email_mail_sent', /Convite enviado para carla@exemplo\.com\./.test(fb ?? '') && Boolean(carlaMail) && /criar-senha\?token=/.test(carlaMail?.text ?? ''), {
    feedback: fb?.trim(),
    mailSubject: carlaMail?.subject,
  });
  check('d_contador_cai_apos_aprovar', Number(before.text) === Number(after.text) + 1 && after.text === String(pendingApi), { before, after, pendingApi });
  await shot(page, 'usuarios-aprovado-email-enviado-1440');
  // Carla cria a senha pelo link do e-mail e aparece ativa
  const carla = await newPage();
  await setPasswordFromLink(carla.page, await waitLinkFor('carla@exemplo.com'), 'Bambu-Farol-Cereja-1357');
  await carla.ctx.close();
  await gotoUsers(page);
  await selectTab(page, 'Ativos');
  const carlaChip = await page.$eval(`[data-user-id="${ids['carla@exemplo.com']}"] [data-testid="user-status"]`, (e) => e.textContent).catch(() => null);
  check('carla_cria_senha_e_aparece_ativa', carlaChip === 'Ativo', { carlaChip });
  await shot(page, 'usuarios-ativos-1440');
}

// ── 6. Recusar o pedido com XSS (confirmação com motivo) ──
{
  const { page } = owner;
  await selectTab(page, 'Pendentes');
  await clickRowAction(page, ids['xss@exemplo.com'], 'Recusar');
  await waitModalOpen(page);
  await page.locator('#users-reject-reason textarea').click();
  await page.keyboard.type('Não reconheço este pedido.');
  await page.waitForTimeout(300);
  await shot(page, 'usuarios-confirmar-recusar-1440');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot(page, 'usuarios-confirmar-recusar-1280');
  await page.setViewportSize({ width: 1440, height: 900 });
  // Esc fecha sem chamar a API; o foco volta ao botão de origem
  await page.keyboard.press('Escape');
  await waitModalClosed(page);
  await page.waitForTimeout(300);
  const focusBack = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? null);
  await clickRowAction(page, ids['xss@exemplo.com'], 'Recusar');
  await waitModalOpen(page);
  await page.locator('#users-reject-reason textarea').click();
  await page.keyboard.type('Não reconheço este pedido.');
  await modalButton(page, 'Recusar pedido').click();
  const fb = await feedbackText(page);
  await waitModalClosed(page);
  const rec = (await harness('users')).users.find((u) => u.email === 'xss@exemplo.com');
  check('recusar_com_motivo', /recusado/.test(fb ?? '') && rec?.status === 'rejected' && focusBack === 'Recusar', { feedback: fb?.trim(), status: rec?.status, focusBackAfterEsc: focusBack });
}

// ── 7. (j) E-mail com falha (mock devolve 500) ⇒ aviso persistente + chip ──
{
  const { page } = owner;
  await harness('resend-fail?on=1');
  await clickRowAction(page, ids['diego@exemplo.com'], 'Aprovar');
  await waitModalOpen(page);
  await modalButton(page, 'Aprovar e enviar convite').click();
  const warning = await page.waitForSelector('[data-testid="users-mail-warning"]', { timeout: 15000 });
  const text = (await warning.textContent())?.trim();
  await page.waitForTimeout(7000); // não some sozinho (o sucesso some em 5 s)
  const stillThere = (await page.$('[data-testid="users-mail-warning"]')) !== null;
  await shot(page, 'usuarios-email-nao-enviado-1440');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot(page, 'usuarios-email-nao-enviado-1280');
  await page.setViewportSize({ width: 1440, height: 900 });
  await selectTab(page, 'Aguardando');
  const chip = await page.$eval(`[data-user-id="${ids['diego@exemplo.com']}"] [data-testid="user-status"]`, (e) => e.textContent).catch(() => null);
  await shot(page, 'usuarios-aguardando-email-nao-enviado-1440');
  await harness('resend-fail?on=0');
  check('j_email_falhou_aviso_persistente', /A aprovação foi salva, mas o e-mail não saiu/.test(text ?? '') && stillThere && chip === 'Aguardando criar senha · e-mail não enviado', { text, stillThere, chip });
}

// ── 8. Elisa (pedido do teste da faixa) aprovada → Pendentes vazio ──
{
  const { page } = owner;
  await selectTab(page, 'Pendentes');
  await clickRowAction(page, ids['elisa@exemplo.com'], 'Aprovar');
  await waitModalOpen(page);
  await modalButton(page, 'Aprovar e enviar convite').click();
  await feedbackText(page);
  await waitModalClosed(page);
  await gotoUsers(page, '?aba=pendentes');
  const empty = (await page.textContent('[data-testid="users-empty"]').catch(() => null))?.trim();
  await shot(page, 'usuarios-vazio-1440');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot(page, 'usuarios-vazio-1280');
  await page.setViewportSize({ width: 1440, height: 900 });
  check('vazio_pendentes', /Nenhum pedido de acesso pendente\./.test(empty ?? ''), { empty });
}

// ── 9. (e) member: 0 requisições a /admin/users*, sem item/faixa, "Sem permissão" ──
{
  const { page, log } = member;
  const start = log.requests.length;
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.goto(`${BASE}/settings/conta`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const item = await page.$('[data-nav-id="config-usuarios"]');
  const banner = await page.$('[data-testid="shell-access-requests"]');
  await gotoUsers(page);
  const noPerm = (await page.textContent('[data-testid="users-no-permission"]'))?.trim();
  await shot(page, 'usuarios-sem-permissao-member-1440');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot(page, 'usuarios-sem-permissao-member-1280');
  await page.setViewportSize({ width: 1440, height: 900 });
  const adminReqs = log.requests.slice(start).filter((r) => r.url.includes('/api/admin/users'));
  check('e_member_zero_requisicoes_sem_item_sem_faixa', adminReqs.length === 0 && item === null && banner === null && /Sem permissão/.test(noPerm ?? ''), {
    adminRequests: adminReqs.map((r) => r.url),
    item: item !== null,
    banner: banner !== null,
    noPerm,
  });
}

// ── 10. Encerrar sessões do member (a janela dele cai no /login) e desativar ──
{
  const { page } = owner;
  await gotoUsers(page);
  await selectTab(page, 'Ativos');
  await clickRowAction(page, memberId, 'Encerrar sessões');
  await waitModalOpen(page);
  await shot(page, 'usuarios-confirmar-encerrar-sessoes-1440');
  await modalButton(page, 'Encerrar sessões').click();
  const fb = await feedbackText(page);
  await waitModalClosed(page);
  await member.page.goto(`${BASE}/orders`, { waitUntil: 'domcontentloaded' });
  await member.page.waitForURL((u) => u.pathname === '/login', { timeout: 15000 }).catch(() => undefined);
  check('encerrar_sessoes_member_cai_no_login', /Sessões de bruno@exemplo\.com encerradas/.test(fb ?? '') && new URL(member.page.url()).pathname === '/login', {
    feedback: fb?.trim(),
    memberUrl: member.page.url(),
  });
  await clickRowAction(page, memberId, 'Desativar');
  await waitModalOpen(page);
  await shot(page, 'usuarios-confirmar-desativar-1440');
  await modalButton(page, 'Desativar').click();
  const fb2 = await feedbackText(page);
  await waitModalClosed(page);
  const status = (await harness('users')).users.find((u) => u.email === 'bruno@exemplo.com')?.status;
  check('desativar_member', /desativado/.test(fb2 ?? '') && status === 'disabled', { feedback: fb2?.trim(), status });
  // member desativado não entra
  await member.page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await member.page.fill('input[name="email"]', 'bruno@exemplo.com');
  await member.page.fill('input[name="password"]', PW.member);
  await member.page.click('button[type="submit"]');
  const errEl = await member.page.waitForSelector('[data-testid="login-error"]', { timeout: 10000 }).catch(() => null);
  const loginErr = errEl ? (await errEl.textContent())?.trim() : null;
  check('member_desativado_nao_entra', loginErr === 'E-mail ou senha incorretos.', { loginErr });
  await selectTab(page, 'Recusados');
  await shot(page, 'usuarios-recusados-desativados-1440');
}

// ── 11. Último owner: botão desabilitado com explicação e a API recusa (409 last_owner) ──
{
  const { page, ctx } = owner;
  await selectTab(page, 'Ativos');
  const ownerId = (await listUsers(ctx)).find((u) => u.email === OWNER)?.id;
  const ui = await page.evaluate((id) => {
    const row = document.querySelector(`[data-user-id="${id}"]`);
    const btn = [...(row?.querySelectorAll('s-button') ?? [])].find((b) => b.textContent.trim() === 'Desativar');
    return { disabled: btn ? Boolean(btn.disabled) : null, hint: row?.querySelector('[data-testid="user-disable-hint"]')?.textContent ?? null };
  }, ownerId);
  const res = await api(ctx, 'POST', `/admin/users/${ownerId}/disable`);
  await shot(page, 'usuarios-ultimo-owner-1440');
  check('ultimo_owner_desabilitado_e_api_409', ui.disabled === true && /único owner ativo/.test(ui.hint ?? '') && res.status === 409 && res.body?.code === 'last_owner', { ui, api: res });
}

// ── 12. Erro ao carregar a lista (resposta 500 simulada no navegador) ──
{
  for (const [width, height] of [[1440, 900], [1280, 800]]) {
    const { page } = owner;
    await page.setViewportSize({ width, height });
    await page.route('**/api/admin/users?*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"code":"internal_error"}' }));
    await page.goto(`${BASE}${USERS}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('s-banner[tone="critical"]', { timeout: 10000 });
    await page.waitForTimeout(400);
    await shot(page, `usuarios-erro-${width}`);
    await page.unroute('**/api/admin/users?*');
  }
  await owner.page.setViewportSize({ width: 1440, height: 900 });
  check('erro_lista_com_tentar_de_novo', (await owner.page.textContent('s-banner[tone="critical"]'))?.includes('Tentar de novo') ?? false);
}

results.page_errors = { owner: owner.log.errors, member: member.log.errors };
writeFileSync(join(OUT, 'depois-medicoes.json'), `${JSON.stringify({ base: BASE, date: new Date().toISOString(), failures, results }, null, 2)}\n`);
await browser.close();
console.log(failures.length ? `FALHAS: ${failures.join(', ')}` : 'todas as verificações ok');
process.exit(failures.length ? 1 : 0);
