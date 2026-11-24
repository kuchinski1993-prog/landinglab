/* eslint-env browser, node */
/* global ReactDOM */
/* eslint-disable no-console */
// Story 20.1 — spike: Polaris Web Components 2.x × React 18 (fora do admin).
//
// Mede, num Chromium real (Playwright), o que funciona e o que quebra quando o
// React 18 renderiza elementos `s-*` diretamente, e o que o wrapper fino
// (ref + propriedade + addEventListener) resolve. Saída: JSON no stdout,
// usado como evidência no ADR-003.
//
// Uso (na raiz do monorepo, com rede liberada para o CDN da Shopify):
//   node apps/backoffice/scripts/ds-spike/polaris-wc-react18.spike.mjs
//
// Não roda no CI (depende de rede e de navegador). Não é importado pelo app.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const backoffice = resolve(here, '../..');
const req = createRequire(resolve(backoffice, 'package.json'));
const rootReq = createRequire(resolve(backoffice, '../../package.json'));

const React = req('react');
const ReactDOMServer = req('react-dom/server');
const { chromium } = rootReq('@playwright/test');

const CDN = 'https://cdn.shopify.com/shopifycloud/polaris-2.js';
const reactUmd = readFileSync(resolve(dirname(req.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDomUmd = readFileSync(resolve(dirname(req.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');


const h = React.createElement;
function ssrTree() {
  return h(
    's-page',
    { heading: 'Configurações' },
    h('s-button', { slot: 'primary-action', variant: 'primary' }, 'Salvar'),
    h(
      's-section',
      null,
      h('s-text-field', { label: 'Nome', value: 'Loja' }),
      h('s-banner', { tone: 'critical', heading: 'Erro' }, 'Falhou'),
    ),
  );
}
const ssrHtml = ReactDOMServer.renderToString(ssrTree());

function page({ scriptMode }) {
  const polaris =
    scriptMode === 'sync'
      ? `<script src="${CDN}"></script>`
      : scriptMode === 'async'
        ? `<script src="${CDN}" async></script>`
        : '';
  return `<!doctype html><html lang="pt-BR"><head>${polaris}
<script src="/react.js"></script><script src="/react-dom.js"></script></head>
<body><div id="ssr">${ssrHtml}</div><div id="app"></div></body></html>`;
}

const results = { cdn: CDN, react: React.version, measuredAt: new Date().toISOString() };

const browser = await chromium.launch();
try {
  for (const scriptMode of ['sync', 'async']) {
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    const errors = [];
    pg.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text().slice(0, 300));
    });
    await pg.route('http://spike.local/**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/react.js') return route.fulfill({ body: reactUmd, contentType: 'text/javascript' });
      if (url.pathname === '/react-dom.js') return route.fulfill({ body: reactDomUmd, contentType: 'text/javascript' });
      return route.fulfill({ body: page({ scriptMode }), contentType: 'text/html; charset=utf-8' });
    });
    const t0 = Date.now();
    await pg.goto('http://spike.local/');
    await pg.waitForFunction(() => !!customElements.get('s-page'), null, { timeout: 15000 });
    const defineMs = Date.now() - t0;

    // 1) Hidratação do HTML do servidor (s-page/s-button/s-text-field/s-banner).
    const hydration = await pg.evaluate(async () => {
      const errs = [];
      const orig = console.error;
      console.error = (...a) => {
        errs.push(a.map(String).join(' ').slice(0, 300));
        orig(...a);
      };
      const h = React.createElement;
      const tree = h(
        's-page',
        { heading: 'Configurações' },
        h('s-button', { slot: 'primary-action', variant: 'primary' }, 'Salvar'),
        h(
          's-section',
          null,
          h('s-text-field', { label: 'Nome', value: 'Loja' }),
          h('s-banner', { tone: 'critical', heading: 'Erro' }, 'Falhou'),
        ),
      );
      ReactDOM.hydrateRoot(document.getElementById('ssr'), tree);
      await new Promise((r) => setTimeout(r, 300));
      console.error = orig;
      const lightAttrs = [...document.querySelectorAll('#ssr *')].map((el) => ({
        tag: el.localName,
        attrs: [...el.attributes].map((a) => a.name),
        shadow: !!el.shadowRoot,
      }));
      return { errors: errs, hydrationErrors: errs.filter((e) => /hydrat|did not match/i.test(e)), lightAttrs };
    });

    // 2) Campo controlado ingênuo (React 18 direto no s-text-field).
    const naive = await pg.evaluate(async () => {
      const h = React.createElement;
      const log = { onInputCalls: 0, onChangeCalls: 0, lastValueSeen: null };
      let setValue;
      function Naive() {
        const [v, sv] = React.useState('inicial');
        setValue = sv;
        return h('s-text-field', {
          id: 'naive',
          label: 'Nome',
          value: v,
          error: v.length > 5 ? 'Muito longo' : undefined,
          onInput: (e) => {
            log.onInputCalls++;
            log.lastValueSeen = e.target.value;
            sv(e.target.value);
          },
          onChange: () => {
            log.onChangeCalls++;
          },
        });
      }
      const host = document.getElementById('app');
      const root = ReactDOM.createRoot(host);
      root.render(h(Naive));
      await new Promise((r) => setTimeout(r, 300));
      const el = document.getElementById('naive');
      const initial = { prop: el.value, attr: el.getAttribute('value') };
      // simula digitação: escreve no <input> interno e dispara input (como o navegador faz)
      const inner = el.shadowRoot && el.shadowRoot.querySelector('input');
      if (inner) {
        inner.focus();
        inner.value = 'abc';
        inner.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      }
      await new Promise((r) => setTimeout(r, 200));
      const afterTyping = { prop: el.value, attr: el.getAttribute('value') };
      // reset pelo estado (ex.: botão "Limpar")
      setValue('');
      await new Promise((r) => setTimeout(r, 200));
      const afterReset = { prop: el.value, attr: el.getAttribute('value'), innerValue: inner && inner.value };
      // estado → valor longo (erro de validação)
      setValue('muito longo');
      await new Promise((r) => setTimeout(r, 200));
      const afterLong = {
        prop: el.value,
        attr: el.getAttribute('value'),
        innerValue: inner && inner.value,
        errorAttr: el.getAttribute('error'),
        errorProp: el.error,
      };
      root.unmount();
      return { hasInnerInput: !!inner, initial, afterTyping, afterReset, afterLong, log };
    });

    // 3) Mesmo cenário com o wrapper fino (propriedade + addEventListener).
    const wrapped = await pg.evaluate(async () => {
      const h = React.createElement;
      const log = { inputCalls: 0, listenersAdded: 0, listenersRemoved: 0 };
      let setValue;
      function Wrapped() {
        const [v, sv] = React.useState('inicial');
        setValue = sv;
        const ref = React.useRef(null);
        React.useLayoutEffect(() => {
          const el = ref.current;
          if (el.value !== v) el.value = v;
          el.error = v.length > 5 ? 'Muito longo' : '';
        }, [v]);
        React.useEffect(() => {
          const el = ref.current;
          const on = (e) => {
            log.inputCalls++;
            sv(e.currentTarget.value);
          };
          el.addEventListener('input', on);
          log.listenersAdded++;
          return () => {
            el.removeEventListener('input', on);
            log.listenersRemoved++;
          };
        }, []);
        return h('s-text-field', { id: 'wrapped', label: 'Nome', ref });
      }
      const host = document.getElementById('app');
      const root = ReactDOM.createRoot(host);
      root.render(h(Wrapped));
      await new Promise((r) => setTimeout(r, 300));
      const el = document.getElementById('wrapped');
      const initial = { prop: el.value };
      const inner = el.shadowRoot && el.shadowRoot.querySelector('input');
      if (inner) {
        inner.focus();
        inner.value = 'abc';
        inner.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      }
      await new Promise((r) => setTimeout(r, 200));
      const afterTyping = { prop: el.value };
      setValue('');
      await new Promise((r) => setTimeout(r, 200));
      const afterReset = { prop: el.value, innerValue: inner && inner.value };
      setValue('muito longo');
      await new Promise((r) => setTimeout(r, 200));
      const afterLong = { prop: el.value, innerValue: inner && inner.value, errorProp: el.error };
      root.unmount();
      return { initial, afterTyping, afterReset, afterLong, log };
    });

    // 4) Modal: ingênuo (onHide + commandFor) × wrapper (showOverlay/hideOverlay + addEventListener).
    const modal = await pg.evaluate(async () => {
      const h = React.createElement;
      const log = { naiveOnHide: 0, wrappedHide: 0, wrappedShow: 0 };
      function Lab() {
        const ref = React.useRef(null);
        React.useEffect(() => {
          const el = ref.current;
          const onHide = () => log.wrappedHide++;
          const onShow = () => log.wrappedShow++;
          el.addEventListener('hide', onHide);
          el.addEventListener('show', onShow);
          return () => {
            el.removeEventListener('hide', onHide);
            el.removeEventListener('show', onShow);
          };
        }, []);
        return h(
          'div',
          null,
          h('s-button', { id: 'opener', commandFor: 'm1', command: '--show' }, 'Abrir'),
          h('s-modal', { id: 'm1', heading: 'Confirmar', ref, onHide: () => log.naiveOnHide++ }, 'Conteúdo'),
        );
      }
      const host = document.getElementById('app');
      const root = ReactDOM.createRoot(host);
      root.render(h(Lab));
      await new Promise((r) => setTimeout(r, 300));
      const opener = document.getElementById('opener');
      const m = document.getElementById('m1');
      const isOpen = () => !!(m.shadowRoot && m.shadowRoot.querySelector('dialog[open]'));
      const attrs = {
        opener: [...opener.attributes].map((a) => `${a.name}=${a.value}`),
        modal: [...m.attributes].map((a) => a.name),
      };
      const hasMethods = { showOverlay: typeof m.showOverlay, hideOverlay: typeof m.hideOverlay };
      const innerBtn = opener.shadowRoot && opener.shadowRoot.querySelector('button');
      (innerBtn || opener).click();
      await new Promise((r) => setTimeout(r, 500));
      const openAfterCommandFor = isOpen();
      const focusInsideAfterOpen = document.activeElement && document.activeElement.localName;
      const dlg = m.shadowRoot && m.shadowRoot.querySelector('dialog');
      if (dlg) dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
      if (dlg && dlg.open) dlg.dispatchEvent(new Event('cancel', { cancelable: true }));
      await new Promise((r) => setTimeout(r, 700));
      const openAfterEsc = isOpen();
      const focusAfterClose = document.activeElement && (document.activeElement.id || document.activeElement.localName);
      if (m.showOverlay) m.showOverlay();
      await new Promise((r) => setTimeout(r, 500));
      const openAfterMethod = isOpen();
      if (m.hideOverlay) m.hideOverlay();
      await new Promise((r) => setTimeout(r, 700));
      const openAfterHideMethod = isOpen();
      root.unmount();
      return {
        attrs,
        hasMethods,
        openAfterCommandFor,
        focusInsideAfterOpen,
        openAfterEsc,
        focusAfterClose,
        openAfterMethod,
        openAfterHideMethod,
        log,
      };
    });

    // 5) Digitação real pelo teclado (cursor no meio do texto) no campo ingênuo × wrapper.
    const keyboard = {};
    for (const mode of ['naive', 'wrapped']) {
      await pg.evaluate((m) => {
        const h = React.createElement;
        window.__state = '';
        function Naive() {
          const [v, sv] = React.useState('Loja');
          window.__state = v;
          return h('s-text-field', { id: 'kb', label: 'Nome', value: v, onInput: (e) => sv(e.target.value) });
        }
        function Wrapped() {
          const [v, sv] = React.useState('Loja');
          window.__state = v;
          const ref = React.useRef(null);
          React.useLayoutEffect(() => {
            if (ref.current.value !== v) ref.current.value = v;
          }, [v]);
          React.useEffect(() => {
            const el = ref.current;
            const on = (e) => sv(e.currentTarget.value);
            el.addEventListener('input', on);
            return () => el.removeEventListener('input', on);
          }, []);
          return h('s-text-field', { id: 'kb', label: 'Nome', ref });
        }
        const host = document.getElementById('app');
        window.__kbRoot = ReactDOM.createRoot(host);
        window.__kbRoot.render(h(m === 'naive' ? Naive : Wrapped));
      }, mode);
      await pg.waitForTimeout(300);
      const input = pg.locator('#kb input');
      await input.click();
      await pg.keyboard.press('End');
      await pg.keyboard.type(' Nova');
      await pg.keyboard.press('Home');
      await pg.keyboard.type('A ');
      await pg.waitForTimeout(200);
      keyboard[mode] = await pg.evaluate(() => {
        const el = document.getElementById('kb');
        const out = { state: window.__state, prop: el.value };
        window.__kbRoot.unmount();
        return out;
      });
    }

    // 6) Booleanos: React 18 passa `disabled={false}` como atributo?
    const booleans = await pg.evaluate(async () => {
      const h = React.createElement;
      const host = document.getElementById('app');
      const root = ReactDOM.createRoot(host);
      root.render(
        h(
          'div',
          null,
          h('s-button', { id: 'bf', disabled: false }, 'A'),
          h('s-button', { id: 'bt', disabled: true }, 'B'),
        ),
      );
      await new Promise((r) => setTimeout(r, 300));
      const f = document.getElementById('bf');
      const t = document.getElementById('bt');
      const out = {
        falseProp: { attr: f.getAttribute('disabled'), prop: f.disabled },
        trueProp: { attr: t.getAttribute('disabled'), prop: t.disabled },
      };
      root.unmount();
      return out;
    });

    results[scriptMode] = {
      defineMs,
      hydration,
      naive,
      wrapped,
      modal,
      keyboard,
      booleans,
      consoleErrorsAndWarnings: errors,
    };
    await ctx.close();
  }

  // 5) Falha do CDN: script bloqueado → elementos nunca são definidos.
  {
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    await pg.route(CDN, (route) => route.abort());
    await pg.route('http://spike.local/**', (route) =>
      route.fulfill({
        body: `<!doctype html><html><head><script id="p" src="${CDN}" async></script></head><body><s-page heading="X">texto do conteúdo</s-page></body></html>`,
        contentType: 'text/html; charset=utf-8',
      }),
    );
    await pg.goto('http://spike.local/');
    await pg.waitForTimeout(1500);
    results.cdnBlocked = await pg.evaluate(() => ({
      sPageDefined: !!customElements.get('s-page'),
      bodyText: document.body.innerText,
    }));
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify(results, null, 2));
