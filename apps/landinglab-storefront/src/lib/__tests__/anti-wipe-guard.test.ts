// Guarda anti-wipe: bloqueia o "kill switch" anti-clone (esvaziar <body>/<html>) sem atrapalhar
// atribuições normais. DOM mínimo em node:vm (o storefront roda testes em ambiente node).
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { ANTI_WIPE_GUARD_SCRIPT } from '../anti-wipe-guard';

function setup() {
  class Node {
    _text = 'conteúdo';
    get textContent() { return this._text; }
    set textContent(v: string) { this._text = v; }
    removeChild(child: unknown) { return child; }
  }
  class Element extends Node {
    tagName = 'DIV';
    _html = '<main>landing</main>';
    get innerHTML() { return this._html; }
    set innerHTML(v: string) { this._html = v; }
    get outerHTML() { return this._html; }
    set outerHTML(v: string) { this._html = v; }
    replaceChildren(...nodes: unknown[]) { this._html = nodes.join(''); }
    removed = false;
    remove() { this.removed = true; }
  }
  const body = Object.assign(new Element(), { tagName: 'BODY' });
  const html = Object.assign(new Element(), { tagName: 'HTML' });
  const div = new Element();
  const listeners: Record<string, () => void> = {};
  const writes: string[] = [];
  const document = { body, documentElement: html, write: (s: string) => writes.push(s), writeln: () => undefined, open: () => undefined };
  const ctx = {
    Node, Element, document, writes,
    console: { warn: () => undefined },
    window: { addEventListener: (ev: string, fn: () => void) => { listeners[ev] = fn; } },
  };
  const js = ANTI_WIPE_GUARD_SCRIPT.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  runInNewContext(js, ctx);
  return { body, html, div, document, writes, load: () => listeners.load?.() };
}

describe('ANTI_WIPE_GUARD_SCRIPT', () => {
  it('bloqueia body.innerHTML = "" (kill switch do tema Shrine)', () => {
    const { body } = setup();
    body.innerHTML = '';
    expect(body.innerHTML).toBe('<main>landing</main>');
  });

  it('bloqueia esvaziar <html>, textContent, outerHTML, replaceChildren() e remove()', () => {
    const { body, html } = setup();
    html.innerHTML = '   ';
    body.textContent = '';
    body.outerHTML = '';
    body.replaceChildren();
    body.remove();
    expect(html.innerHTML).toBe('<main>landing</main>');
    expect(body.textContent).toBe('conteúdo');
    expect(body.innerHTML).toBe('<main>landing</main>');
    expect(body.removed).toBe(false);
  });

  it('deixa passar conteúdo no body e qualquer coisa em outros elementos', () => {
    const { body, div } = setup();
    div.innerHTML = '';
    div.remove();
    body.innerHTML = '<main>novo</main>';
    expect(div.innerHTML).toBe('');
    expect(div.removed).toBe(true);
    expect(body.innerHTML).toBe('<main>novo</main>');
  });

  it('document.write só é bloqueado depois do load', () => {
    const { document, writes, load } = setup();
    document.write('a');
    load();
    document.write('b');
    expect(writes).toEqual(['a']);
  });
});
