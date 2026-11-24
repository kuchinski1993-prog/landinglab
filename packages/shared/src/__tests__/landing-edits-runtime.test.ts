// Story 26.1 — runtime das edições do editor visual: link de botão e texto travado (AC 15, 16).
import { describe, expect, it, vi } from 'vitest';

import {
  buildEditsManifestTag,
  buildEditsRuntimeScript,
  editsRuntimeScriptFor,
  htmlNeedsEditsRuntime,
  LANDING_EDITS_RUNTIME_BODY,
  validateButtonHref,
} from '../landing-edits-runtime.js';

describe('validateButtonHref', () => {
  it('aceita https e âncora', () => {
    expect(validateButtonHref(' https://pay.example.com/c?x=1 ')).toEqual({ ok: true, href: 'https://pay.example.com/c?x=1' });
    expect(validateButtonHref('#ofertas')).toEqual({ ok: true, href: '#ofertas' });
  });
  it.each(['javascript:alert(1)', 'data:text/html,x', 'http://x.com', 'https://10.0.0.1/a', 'https://u:p@x.com', '#', '#1a', '', null])(
    'recusa %s',
    (raw) => {
      expect(validateButtonHref(raw).ok).toBe(false);
    },
  );
});

describe('htmlNeedsEditsRuntime', () => {
  it('só com data-ll-href ou data-ll-lock-text', () => {
    expect(htmlNeedsEditsRuntime('<button data-ll-href="#a">x</button>')).toBe(true);
    expect(htmlNeedsEditsRuntime('<span data-ll-lock-text="9,90 €">9,90 €</span>')).toBe(true);
    expect(htmlNeedsEditsRuntime('<div data-ll-hidden="1" style="display:none !important"></div>')).toBe(false);
    expect(editsRuntimeScriptFor('<p>nada</p>')).toBe('');
    expect(editsRuntimeScriptFor('<a data-ll-href="#a">x</a>')).toBe(buildEditsRuntimeScript());
  });
  it('receitas do editor também pedem o runtime', () => {
    expect(htmlNeedsEditsRuntime('<script type="application/json" data-ll-edits>[]</script>')).toBe(true);
    expect(htmlNeedsEditsRuntime('<script type="application/json" data-ll-edits="">[]</script>')).toBe(true);
    expect(htmlNeedsEditsRuntime('<div data-ll-editsx="1"></div>')).toBe(false);
  });
  it('tag de receitas escapa < e some sem edições', () => {
    expect(buildEditsManifestTag([])).toBe('');
    const tag = buildEditsManifestTag([{ s: 'a.btn', i: 0, t: '</script><b>' }]);
    expect(tag).toContain('data-ll-edits');
    expect(tag).not.toContain('</script><b>');
    expect(JSON.parse(tag.replace(/^<script[^>]*>|<\/script>$/g, ''))).toEqual([{ s: 'a.btn', i: 0, t: '</script><b>' }]);
  });
  it('script marcado para sobreviver ao sanitize', () => {
    expect(buildEditsRuntimeScript()).toContain('data-landinglab-engine="edits"');
  });
});

interface FakeNode {
  nodeType: number;
  nodeValue?: string;
  nextSibling: FakeNode | null;
}
interface FakeEl {
  attrs: Record<string, string>;
  textContent: string;
  firstChild: FakeNode | null;
  firstElementChild: unknown;
  getAttribute(n: string): string | null;
  closest(sel: string): FakeEl | null;
}
function el(attrs: Record<string, string>, text = ''): FakeEl {
  const node: FakeEl = {
    attrs,
    textContent: text,
    firstChild: null,
    firstElementChild: null,
    getAttribute: (n) => (n in attrs ? attrs[n]! : null),
    closest: (sel) => (sel === '[data-ll-href]' && 'data-ll-href' in attrs ? node : null),
  };
  return node;
}

function run(pageUrl: string, locked: FakeEl[] = []) {
  let click: ((ev: unknown) => void) | null = null;
  const assign = vi.fn();
  const scrollIntoView = vi.fn();
  const loc = new URL(pageUrl);
  const win: Record<string, unknown> = {
    location: { search: loc.search, assign },
    addEventListener: (type: string, fn: (ev: unknown) => void, capture: boolean) => {
      expect(capture).toBe(true);
      if (type === 'click') click = fn;
    },
  };
  const doc = {
    readyState: 'complete',
    documentElement: {},
    getElementById: (id: string) => (id === 'ofertas' ? { scrollIntoView } : null),
    querySelector: () => null,
    querySelectorAll: () => locked,
  };
  new Function('window', 'document', 'setInterval', 'setTimeout', LANDING_EDITS_RUNTIME_BODY)(win, doc, () => 0, () => 0);
  const fire = (target: FakeEl) => {
    const ev = { target, preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn() };
    click!(ev);
    return ev;
  };
  return { assign, fire, scrollIntoView };
}

describe('runtime: link do botão', () => {
  it('navega repassando tracking sem sobrescrever o do link', () => {
    const { assign, fire } = run('https://lp.test/p?utm_source=fb&fbclid=abc&evil=1');
    const ev = fire(el({ 'data-ll-href': 'https://pay.example.com/c?utm_source=mine' }));
    expect(assign).toHaveBeenCalledWith('https://pay.example.com/c?utm_source=mine&fbclid=abc');
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(ev.stopImmediatePropagation).toHaveBeenCalled();
  });
  it('âncora rola até a seção sem navegar', () => {
    const { assign, fire, scrollIntoView } = run('https://lp.test/p');
    fire(el({ 'data-ll-href': '#ofertas' }));
    expect(scrollIntoView).toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
  it('sem data-ll-href ou com link não-https: clique segue normal', () => {
    const { assign, fire } = run('https://lp.test/p');
    const a = fire(el({}));
    const b = fire(el({ 'data-ll-href': 'javascript:alert(1)' }));
    expect(assign).not.toHaveBeenCalled();
    expect(a.preventDefault).not.toHaveBeenCalled();
    expect(b.preventDefault).not.toHaveBeenCalled();
  });
});

describe('runtime: texto travado', () => {
  it('reaplica o texto travado quando o tema trocou', () => {
    const price = el({ 'data-ll-lock-text': '19,90 €' }, '29,90 €');
    const same = el({ 'data-ll-lock-text': 'Comprar' }, 'Comprar');
    run('https://lp.test/p', [price, same]);
    expect(price.textContent).toBe('19,90 €');
    expect(same.textContent).toBe('Comprar');
  });
  it('com filhos (ícone + texto) troca só o maior trecho de texto', () => {
    const small: FakeNode = { nodeType: 3, nodeValue: ' ', nextSibling: null };
    const main: FakeNode = { nodeType: 3, nodeValue: 'Add to cart', nextSibling: small };
    const icon: FakeNode = { nodeType: 1, nextSibling: main };
    const btn = el({ 'data-ll-lock-text': 'Quero o meu' }, 'Add to cart');
    btn.firstChild = icon;
    btn.firstElementChild = icon;
    run('https://lp.test/p', [btn]);
    expect(main.nodeValue).toBe('Quero o meu');
    expect(small.nodeValue).toBe(' ');
  });
});
