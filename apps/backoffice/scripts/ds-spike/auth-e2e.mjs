/* eslint-env browser, node */
/* eslint-disable no-console */
// Story 22.1b · AC22 — verificação das telas de acesso no navegador real (Chromium do Playwright do
// repo) com a API REAL da branch (buildServer + PGlite com as migrations 0101–0103, repositório e loja
// de sessão Drizzle, mailer Resend real apontado para um mock HTTP local, limites/piso de produção) e
// o painel em `next start` (rewrite /api/* → API), sem `.env*`.
//
// Uso:
//   1) API: harness em mktemp (ver Dev Agent Record da 22.1b) ouvindo em :3001 com /__harness/*
//   2) cd apps/backoffice && pnpm build && ADMIN_USER_IDS=admin-test npx next start -p 3000
//   3) node apps/backoffice/scripts/ds-spike/auth-e2e.mjs docs/prints/22.1b
//
// Gera prints (1440, 1280, 390) e `depois-medicoes.json` (a–k do AC22). Sai 1 se algo falhar.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const { chromium } = createRequire(join(repo, 'package.json'))('@playwright/test');

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const OUT = resolve(repo, process.argv[2] ?? 'docs/prints/22.1b');
const OWNER = 'kuchinski1993@gmail.com';
const LEGACY_PASSWORD = 'test-session-secret-must-be-at-least-32-chars-long';
const PW = { owner: 'Girassol-Trovao-Mesa-4821', owner2: 'Abacate-Navio-Lampada-7395', ana: 'Cometa-Laranja-Piano-2468', des: 'Farol-Bambu-Cereja-1357' };
mkdirSync(OUT, { recursive: true });

const results = {};
const failures = [];
const check = (key, ok, detail = {}) => {
  results[key] = { ok, ...detail };
  if (!ok) failures.push(key);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${key} ${JSON.stringify(detail).slice(0, 400)}`);
};

const browser = await chromium.launch();

async function newPage({ width = 1440, height = 900, blockPolaris = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  if (blockPolaris) await ctx.route('**/cdn.shopify.com/**', (route) => route.abort());
  const page = await ctx.newPage();
  const log = { console: [], requests: [], errors: [] };
  page.on('console', (m) => log.console.push(m.text()));
  page.on('pageerror', (e) => log.errors.push(String(e).slice(0, 200)));
  page.on('request', (r) => log.requests.push({ url: r.url(), method: r.method(), referer: r.headers()['referer'] ?? null }));
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
const harness = async (path) => (await fetch(`http://127.0.0.1:3001/__harness/${path}`)).json();
const lastLinkFor = async (email) => {
  const { emails } = await harness('emails');
  const mail = [...emails].reverse().find((m) => m.to.includes(email));
  return mail ? /https?:\/\/\S+\/criar-senha\?token=[^\s"<>]+/.exec(mail.text)?.[0] ?? null : null;
};
const waitLinkFor = async (email, previous = null) => {
  for (let i = 0; i < 40; i += 1) {
    const link = await lastLinkFor(email);
    if (link && link !== previous) return link;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
};
const shot = (page, name, fullPage = false) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function gotoLogin(page, query = '') {
  await page.goto(`${BASE}/login${query}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('form[aria-label="Entrar"]');
}

async function uiLogin(page, email, password) {
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
}

async function alertAfterLogin(page) {
  const alert = await page.waitForSelector('[data-testid="login-error"]', { timeout: 10000 });
  return { text: (await alert.textContent())?.trim(), html: await alert.evaluate((el) => el.outerHTML), focused: await alert.evaluate((el) => el === document.activeElement) };
}

// ── 1. /login nas três larguras: visual, foco, globo × cartão, sem emergência, tabulação ──
for (const [width, height] of [[1440, 900], [1280, 800], [390, 844]]) {
  const { ctx, page } = await newPage({ width, height });
  await gotoLogin(page);
  await page.waitForTimeout(800); // globo (canvas) pronto
  await shot(page, `login-entrar-${width}`);
  const focus = await page.evaluate(() => ({ name: document.activeElement?.getAttribute('name'), type: document.activeElement?.getAttribute('type') }));
  const geo = await page.evaluate(() => {
    const g = document.querySelector('[data-testid="corner-globe"]');
    const c = document.querySelector('.ds-auth-card');
    const gr = g?.getBoundingClientRect();
    const cr = c.getBoundingClientRect();
    const visible = g ? getComputedStyle(g).display !== 'none' : false;
    const ix = gr && visible ? Math.max(0, Math.min(gr.right, cr.right) - Math.max(gr.left, cr.left)) * Math.max(0, Math.min(gr.bottom, cr.bottom) - Math.max(gr.top, cr.top)) : 0;
    return { globeVisible: visible, globe: gr && { x: gr.x, y: gr.y, w: gr.width, h: gr.height }, card: { x: cr.x, y: cr.y, w: cr.width, h: cr.height }, intersection: ix, variant: g?.getAttribute('data-variant') };
  });
  const emergencyLink = await page.evaluate(() => /emergencia|emergência/i.test(document.documentElement.outerHTML));
  if (width === 1440) {
    check('f_foco_inicial_email', focus.name === 'email', focus);
    // (h) tabulação completa por teclado
    const order = [];
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Tab');
      order.push(await page.evaluate(() => {
        const el = document.activeElement;
        return el ? `${el.tagName.toLowerCase()}${el.getAttribute('name') ? `[name=${el.getAttribute('name')}]` : ''}${el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : ''}:${(el.textContent ?? '').trim().slice(0, 30)}` : 'none';
      }));
    }
    const expected = ['input[name=password]', 'button[Mostrar senha]', 'a:Esqueci minha senha', 'a:Criar conta'];
    check('h_tabulacao', expected.every((e, i) => order[i]?.startsWith(e.split(':')[0]) && (!e.includes(':') || order[i].includes(e.split(':')[1]))), { order });
    const ring = await page.evaluate(() => {
      document.querySelector('input[name="email"]').focus();
      const s = getComputedStyle(document.activeElement);
      return { outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}` };
    });
    check('h_foco_visivel', /solid 2px rgb\(0, 91, 211\)/.test(ring.outline), ring);
  }
  if (width !== 390) check(`e_globo_x_cartao_${width}`, geo.intersection === 0 && geo.globeVisible && geo.variant === 'dark', geo);
  else {
    check('e_sem_globo_390', !geo.globeVisible, geo);
    check('k_390_sem_rolagem_horizontal_login', await noHScroll(page));
    const targets = await page.evaluate(() =>
      [...document.querySelectorAll('.ds-auth-card input, .ds-auth-card button, .ds-auth-card a')].map((el) => Math.round(el.getBoundingClientRect().height)),
    );
    check('alvo_toque_44px_390', targets.every((h) => h >= 44), { targets });
  }
  check(`j_sem_link_emergencia_${width}`, !emergencyLink);
  await ctx.close();
}

// ── 2. Criar conta: tela, duplo clique = 1 requisição, confirmação ──
const signupCount = { n: 0 };
{
  for (const [width, height] of [[1440, 900], [1280, 800]]) {
    const { ctx, page } = await newPage({ width, height });
    await page.goto(`${BASE}/login/criar-conta`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await shot(page, `login-criar-conta-${width}`);
    await ctx.close();
  }
  const { ctx, page } = await newPage();
  page.on('request', (r) => {
    if (r.url().endsWith('/api/auth/signup')) signupCount.n += 1;
  });
  await page.goto(`${BASE}/login/criar-conta`, { waitUntil: 'networkidle' });
  await page.fill('input[name="name"]', 'Ana Souza');
  await page.fill('input[name="email"]', 'Ana.Souza@Exemplo.com');
  await page.fill('textarea[name="note"]', 'Atendimento das lojas');
  await page.dblclick('button[type="submit"]');
  await page.waitForSelector('[data-testid="signup-received"]');
  await page.waitForTimeout(300);
  check('g_duplo_clique_1_requisicao', signupCount.n === 1, { requests: signupCount.n });
  await shot(page, 'login-criar-conta-confirmacao-1440');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot(page, 'login-criar-conta-confirmacao-1280');
  results.signup_text = (await page.textContent('[data-testid="signup-received"]'))?.trim();
  await ctx.close();
}

// ── 3. Owner: "Esqueci minha senha" → e-mail (mock Resend) → /criar-senha → entra ──
let ownerLink;
{
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/login/esqueci`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await shot(page, 'login-esqueci-1440');
  await page.fill('input[name="email"]', OWNER);
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="forgot-received"]');
  const forgotText = (await page.textContent('[data-testid="forgot-received"]'))?.trim();
  const countdown = (await page.textContent('button[type="submit"]'))?.trim();
  await shot(page, 'login-esqueci-enviado-1440');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot(page, 'login-esqueci-enviado-1280');
  // Mesmo texto para e-mail que não existe.
  await page.goto(`${BASE}/login/esqueci`, { waitUntil: 'networkidle' });
  await page.fill('input[name="email"]', 'ninguem@exemplo.com');
  await page.click('button[type="submit"]');
  await page.waitForSelector('[data-testid="forgot-received"]');
  const forgotUnknown = (await page.textContent('[data-testid="forgot-received"]'))?.trim();
  check('esqueci_mesma_frase', forgotText === forgotUnknown && /^Se existir uma conta/.test(forgotText ?? ''), { forgotText, countdown });
  ownerLink = await waitLinkFor(OWNER);
  check('email_capturado_pelo_mock_resend', Boolean(ownerLink), { linkPath: ownerLink ? new URL(ownerLink).pathname : null });
  await ctx.close();
}

let ownerCtx;
{
  const { ctx, page, log } = await newPage();
  const token = new URL(ownerLink).searchParams.get('token');
  await page.goto(ownerLink, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[name="new-password"]');
  const locationAfter = await page.evaluate(() => window.location.href);
  await page.waitForTimeout(500);
  await shot(page, 'criar-senha-valido-1440');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot(page, 'criar-senha-valido-1280');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'criar-senha-valido-390', true);
  check('k_390_sem_rolagem_horizontal_criar_senha', await noHScroll(page));
  await page.setViewportSize({ width: 1440, height: 900 });
  // senhas diferentes → erro local, sem chamar /password/set
  await page.fill('input[name="new-password"]', PW.owner);
  await page.fill('input[name="confirm-password"]', `${PW.owner}x`);
  await page.click('button[type="submit"]');
  await page.waitForSelector('text=As senhas não são iguais.');
  await page.fill('input[name="confirm-password"]', PW.owner);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE}/`, { timeout: 15000 });
  await page.waitForSelector('[data-testid="shell-topbar"]');
  const leaks = {
    location: locationAfter.includes(token),
    referer: log.requests.filter((r) => r.referer && r.referer.includes(token)).map((r) => r.url),
    // A 1ª requisição é a própria abertura do link do e-mail (documento); nenhuma outra pode levar o token.
    requestUrls: log.requests.slice(1).filter((r) => r.url.includes(token)).map((r) => r.url),
    console: log.console.filter((m) => m.includes(token)),
  };
  check('b_token_fora_de_location_referer_console', !leaks.location && leaks.referer.length === 0 && leaks.requestUrls.length === 0 && leaks.console.length === 0, {
    locationAfterLoad: locationAfter,
    ...leaks,
  });
  const hosts = [...new Set(log.requests.map((r) => new URL(r.url).host))];
  results.criar_senha_requisicoes = { hosts, list: log.requests.map((r) => ({ method: r.method, url: r.url.replace(token, '<token>'), referer: r.referer })) };
  check('criar_senha_sem_terceiros_alem_do_cdn_global', hosts.every((h) => h === new URL(BASE).host || h === 'cdn.shopify.com'), { hosts });
  // link usado de novo → inválido
  const again = await newPage();
  await again.page.goto(ownerLink, { waitUntil: 'networkidle' });
  await again.page.waitForSelector('[data-testid="set-password-invalid"]');
  check('link_usado_de_novo_invalido', true, { text: (await again.page.textContent('[data-testid="set-password-invalid"]'))?.trim() });
  await again.ctx.close();
  ownerCtx = { ctx, page };
}

// ── 4. /criar-senha inválido (prints) e cabeçalhos ──
{
  for (const [width, height] of [[1440, 900], [1280, 800]]) {
    const { ctx, page } = await newPage({ width, height });
    await page.goto(`${BASE}/criar-senha?token=invalido-123`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="set-password-invalid"]');
    await page.waitForTimeout(300);
    await shot(page, `criar-senha-invalido-${width}`);
    await ctx.close();
  }
  const headers = {};
  for (const path of ['/criar-senha?token=x', '/login/criar-senha?token=x']) {
    const res = await fetch(`${BASE}${path}`);
    headers[path] = { 'cache-control': res.headers.get('cache-control'), 'referrer-policy': res.headers.get('referrer-policy') };
  }
  check('i_headers_criar_senha', Object.values(headers).every((h) => h['cache-control'] === 'no-store' && h['referrer-policy'] === 'no-referrer'), headers);
}

// ── 5. Owner aprova a Ana (API) → e-mail → Ana cria a senha → menu do usuário → Sair ──
{
  const { page, ctx } = ownerCtx;
  const pending = await api(ctx, 'GET', '/admin/users?status=pending_approval');
  const ana = pending.body?.items?.find((u) => u.email === 'ana.souza@exemplo.com');
  const approved = await api(ctx, 'POST', `/admin/users/${ana?.id}/approve`);
  check('owner_aprova_por_api', approved.status === 200, { status: approved.status, body: approved.body });
  const anaLink = await waitLinkFor('ana.souza@exemplo.com');
  const a = await newPage();
  await a.page.goto(anaLink, { waitUntil: 'networkidle' });
  await a.page.fill('input[name="new-password"]', PW.ana);
  await a.page.fill('input[name="confirm-password"]', PW.ana);
  await a.page.click('button[type="submit"]');
  await a.page.waitForURL(`${BASE}/`, { timeout: 15000 });
  await a.page.waitForSelector('[data-testid="shell-topbar"]');
  await a.page.click('.ds-shell-user__trigger');
  await a.page.waitForSelector('[data-testid="user-menu-identity"]');
  const menuAna = (await a.page.textContent('.ds-shell-user__menu'))?.trim();
  const triggerAna = (await a.page.textContent('.ds-shell-user__trigger'))?.trim();
  await shot(a.page, 'shell-menu-usuario-ana-1440');
  check('menu_nome_email_reais_ana', /Ana Souza/.test(triggerAna) && /AS/.test(triggerAna) && /ana\.souza@exemplo\.com/.test(menuAna) && /Alterar senha/.test(menuAna), { triggerAna, menuAna });
  await a.page.click('.ds-shell-user__menu >> text=Sair');
  await a.page.waitForURL(`${BASE}/login`, { timeout: 15000 });
  check('sair_volta_ao_login', true);
  // entrar de novo pela tela (e-mail com maiúsculas e espaços)
  await uiLogin(a.page, '  Ana.Souza@EXEMPLO.com ', PW.ana);
  await a.page.waitForURL(`${BASE}/`, { timeout: 15000 });
  check('login_ana_pela_tela', true);
  await a.ctx.close();

  // menu do owner (sem nome: parte do e-mail)
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.click('.ds-shell-user__trigger');
  await page.waitForSelector('[data-testid="user-menu-identity"]');
  await shot(page, 'shell-menu-usuario-1440');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot(page, 'shell-menu-usuario-1280');
  await page.setViewportSize({ width: 1440, height: 900 });
  results.menu_owner = (await page.textContent('.ds-shell-user__menu'))?.trim();
}

// ── 6. (a) Os 7 casos de 401 — mesmo texto e mesmo DOM ──
{
  const { ctx } = ownerCtx;
  const signupApi = (name, email) => api(ctx, 'POST', '/auth/signup', { name, email });
  await signupApi('Pendente', 'pend@exemplo.com');
  await signupApi('Recusado', 'rec@exemplo.com');
  await signupApi('Sem Senha', 'sem@exemplo.com');
  await signupApi('Desativado', 'des@exemplo.com');
  const list = (await api(ctx, 'GET', '/admin/users?status=pending_approval')).body?.items ?? [];
  const id = (email) => list.find((u) => u.email === email)?.id;
  await api(ctx, 'POST', `/admin/users/${id('rec@exemplo.com')}/reject`, { reason: 'teste' });
  await api(ctx, 'POST', `/admin/users/${id('sem@exemplo.com')}/approve`);
  await api(ctx, 'POST', `/admin/users/${id('des@exemplo.com')}/approve`);
  const desLink = await waitLinkFor('des@exemplo.com');
  const d = await newPage();
  await d.page.goto(desLink, { waitUntil: 'networkidle' });
  await d.page.fill('input[name="new-password"]', PW.des);
  await d.page.fill('input[name="confirm-password"]', PW.des);
  await d.page.click('button[type="submit"]');
  await d.page.waitForURL(`${BASE}/`, { timeout: 15000 });
  await d.ctx.close();
  await api(ctx, 'POST', `/admin/users/${id('des@exemplo.com')}/disable`);

  const cases = {};
  const p = await newPage();
  const attempt = async (key, email, password) => {
    await gotoLogin(p.page);
    await uiLogin(p.page, email, password);
    cases[key] = await alertAfterLogin(p.page);
  };
  await attempt('inexistente', 'ninguem@exemplo.com', 'qualquer-senha-123');
  await attempt('pendente', 'pend@exemplo.com', 'qualquer-senha-123');
  await attempt('recusado', 'rec@exemplo.com', 'qualquer-senha-123');
  await attempt('desativado', 'des@exemplo.com', PW.des);
  await attempt('sem_senha', 'sem@exemplo.com', 'qualquer-senha-123');
  await attempt('senha_errada', OWNER, 'senha-errada-000');
  // bloqueio progressivo: 6 erradas para a Ana e depois a CERTA → continua o mesmo 401
  const wrongTexts = [];
  for (let i = 0; i < 6; i += 1) {
    await gotoLogin(p.page);
    await uiLogin(p.page, 'ana.souza@exemplo.com', `errada-${i}`);
    wrongTexts.push((await alertAfterLogin(p.page)).text);
  }
  await attempt('bloqueado', 'ana.souza@exemplo.com', PW.ana);
  await shot(p.page, 'login-erro-1440');
  await p.page.setViewportSize({ width: 1280, height: 800 });
  await shot(p.page, 'login-erro-1280');
  const texts = new Set(Object.values(cases).map((c) => c.text));
  const htmls = new Set(Object.values(cases).map((c) => c.html));
  check('a_sete_casos_401_identicos', texts.size === 1 && htmls.size === 1 && [...texts][0] === 'E-mail ou senha incorretos.' && Object.values(cases).every((c) => c.focused), {
    text: [...texts],
    distinctDom: htmls.size,
    cases: Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, { text: v.text, focused: v.focused }])),
  });
  check('senha_errada_x6_mesma_frase', new Set(wrongTexts).size === 1, { wrongTexts });
  const users = (await harness('users')).users;
  results.estados_no_banco = users.map((u) => ({ email: u.email, status: u.status, failed: u.failed_login_count }));
  await p.ctx.close();
}

// ── 7. (c) callbackUrl hostil ⇒ "/"; interno é honrado ──
{
  const { ctx, page } = await newPage();
  await gotoLogin(page, `?callbackUrl=${encodeURIComponent('https://evil.example/phish')}`);
  await uiLogin(page, OWNER, PW.owner);
  await page.waitForURL((u) => u.pathname === '/', { timeout: 15000 });
  const hostile = page.url();
  await api(ctx, 'POST', '/auth/logout');
  await gotoLogin(page, `?callbackUrl=${encodeURIComponent('//evil.example')}`);
  await uiLogin(page, OWNER, PW.owner);
  await page.waitForURL((u) => u.pathname === '/', { timeout: 15000 });
  const hostile2 = page.url();
  await api(ctx, 'POST', '/auth/logout');
  // sem sessão, tela do painel → /login?callbackUrl=/orders → entra e volta para /orders
  await page.goto(`${BASE}/orders?status=open`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL((u) => u.pathname === '/login', { timeout: 15000 });
  const redirected = page.url();
  await uiLogin(page, OWNER, PW.owner);
  await page.waitForURL((u) => u.pathname === '/orders', { timeout: 15000 });
  check('c_callback_hostil_vira_raiz_e_interno_honrado', new URL(hostile).origin === BASE && new URL(hostile2).origin === BASE && /callbackUrl=%2Forders%3Fstatus%3Dopen/.test(redirected), {
    hostile,
    hostile2,
    redirected,
    final: page.url(),
  });
  await ctx.close();
}

// ── 8. (d) Login com o script do Polaris BLOQUEADO ──
{
  const { ctx, page, log } = await newPage({ blockPolaris: true });
  await gotoLogin(page);
  await shot(page, 'login-sem-polaris-1440');
  await uiLogin(page, OWNER, PW.owner);
  await page.waitForURL(`${BASE}/`, { timeout: 15000 });
  const blocked = log.requests.filter((r) => r.url.includes('cdn.shopify.com')).length;
  check('d_login_com_polaris_bloqueado', true, { polarisRequestsBlocked: blocked });
  await ctx.close();
}

// ── 9. /alterar-senha (owner) e sessão revogada noutra janela ──
{
  const other = await newPage();
  await gotoLogin(other.page);
  await uiLogin(other.page, OWNER, PW.owner);
  await other.page.waitForURL(`${BASE}/`, { timeout: 15000 });

  const { page } = ownerCtx;
  await page.goto(`${BASE}/alterar-senha`, { waitUntil: 'networkidle' });
  await page.waitForSelector('form[aria-label="Alterar senha"]');
  await shot(page, 'alterar-senha-1440');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot(page, 'alterar-senha-1280');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.fill('input[name="current-password"]', 'errada-000000');
  await page.fill('input[name="new-password"]', PW.owner2);
  await page.fill('input[name="confirm-password"]', PW.owner2);
  await page.click('form[aria-label="Alterar senha"] button[type="submit"]');
  await page.waitForSelector('text=A senha atual não confere.');
  await page.fill('input[name="current-password"]', PW.owner);
  await page.fill('input[name="new-password"]', PW.owner2);
  await page.fill('input[name="confirm-password"]', PW.owner2);
  await page.click('form[aria-label="Alterar senha"] button[type="submit"]');
  await page.waitForSelector('[data-testid="change-password-done"]');
  await shot(page, 'alterar-senha-sucesso-1440');
  check('alterar_senha', true, { text: (await page.textContent('[data-testid="change-password-done"]'))?.trim() });
  // a outra janela perdeu a sessão: a próxima navegação cai no /login?callbackUrl=…
  await other.page.goto(`${BASE}/orders`, { waitUntil: 'domcontentloaded' });
  await other.page.waitForURL((u) => u.pathname === '/login', { timeout: 15000 });
  check('sessao_revogada_volta_ao_login_com_callback', /callbackUrl=%2Forders/.test(other.page.url()), { url: other.page.url() });
  await other.ctx.close();
}

// ── 10. Emergência: sem link, senha antiga, faixa no shell, botão do link ──
{
  for (const [width, height] of [[1440, 900], [1280, 800]]) {
    const { ctx, page } = await newPage({ width, height });
    await page.goto(`${BASE}/login/emergencia`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await shot(page, `login-emergencia-${width}`);
    await ctx.close();
  }
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/login/emergencia`, { waitUntil: 'networkidle' });
  const robots = await page.getAttribute('meta[name="robots"]', 'content');
  await page.fill('input[name="password"]', 'senha-antiga-errada');
  await page.click('button[type="submit"]');
  const wrong = (await page.waitForSelector('[data-testid="emergency-error"]').then((e) => e.textContent()))?.trim();
  await page.fill('input[name="password"]', LEGACY_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE}/`, { timeout: 15000 });
  await page.waitForSelector('[data-testid="shell-legacy-notice"]');
  await shot(page, 'shell-faixa-emergencia-1440');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot(page, 'shell-faixa-emergencia-1280');
  await page.setViewportSize({ width: 1440, height: 900 });
  const auditBefore = (await harness('audit')).events.length;
  const forgotResponse = page.waitForResponse((r) => r.url().endsWith('/api/auth/forgot'));
  await page.click('[data-testid="shell-legacy-notice"] button');
  const forgotStatus = (await forgotResponse).status();
  await page.waitForSelector('[data-testid="shell-legacy-notice"] >> text=Se existir uma conta');
  await page.waitForTimeout(800);
  // A API manda o link (ou respeita a espera de 2 min entre e-mails da mesma conta — 22.1a).
  const auditAfter = (await harness('audit')).events.slice(auditBefore).map((e) => ({ event: e.event, detail: e.detail }));
  const linkRequested = auditAfter.some((e) => e.event === 'reset_requested' || e.event === 'mail_cooldown');
  check('emergencia', /noindex/.test(robots ?? '') && wrong === 'E-mail ou senha incorretos.' && forgotStatus === 202 && linkRequested, {
    robots,
    wrong,
    forgotStatus,
    auditAfter,
  });
  await shot(page, 'shell-faixa-emergencia-link-enviado-1440');
  await ctx.close();
}

writeFileSync(join(OUT, 'depois-medicoes.json'), `${JSON.stringify({ base: BASE, date: new Date().toISOString(), failures, results }, null, 2)}\n`);
await browser.close();
console.log(failures.length ? `FALHAS: ${failures.join(', ')}` : 'todas as verificações ok');
process.exit(failures.length ? 1 : 0);
