// Receitas das edições (link de botão e texto travado) para o runtime reaplicar depois que um script da
// landing redesenhar o bloco — ex.: cards de oferta recriados com o preço na moeda do visitante perdem
// `data-ll-href`/`data-ll-lock-text`. Gravadas a cada save, sempre a partir dos atributos do HTML salvo.
//
// Receita = `<escopo> <tag.classes>` + posição entre os elementos que casam no documento. O escopo é o
// ancestral mais próximo com `id` ou com um `data-*` próprio da landing (ex.: `[data-bundle-index="2"]`),
// que os scripts mantêm ao redesenhar. Classes de estado (`is-active`, `selected`…) ficam de fora.

import {
  EDIT_HREF_ATTR,
  EDITS_MANIFEST_ATTR,
  LOCK_TEXT_ATTR,
  type EditsManifestEntry,
} from '@blackshop/shared/landing-edits-runtime';

const IDENT = /^-?[_a-zA-Z][\w-]*$/;
const STATE_CLASS = /^(?:is|has|js)-|active|selected|current|open|hidden|visible|show|loaded|init|focus|hover/i;
const SCOPE_MAX_DEPTH = 8;
const SCOPE_ATTR_MAX = 60;

function cssString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ')}"`;
}

function elementSelector(el: Element): string {
  const classes = Array.from(el.classList).filter((c) => IDENT.test(c) && !STATE_CLASS.test(c));
  return el.tagName.toLowerCase() + classes.map((c) => `.${c}`).join('');
}

function scopeSelector(el: Element): string | null {
  let p = el.parentElement;
  for (let depth = 0; p && p.tagName !== 'BODY' && depth < SCOPE_MAX_DEPTH; depth++, p = p.parentElement) {
    if (p.id && IDENT.test(p.id)) return `#${p.id}`;
    for (const a of Array.from(p.attributes)) {
      if (!a.name.startsWith('data-') || a.name.startsWith('data-ll-') || !IDENT.test(a.name)) continue;
      if (!a.value || a.value.length > SCOPE_ATTR_MAX) continue;
      return `${p.tagName.toLowerCase()}[${a.name}=${cssString(a.value)}]`;
    }
  }
  return null;
}

export interface ElementLocator {
  s: string;
  i: number;
}

/**
 * Localizador `{s, i}` de elementos do documento: `<escopo> <tag.classes>` + posição entre os que casam.
 * Os `querySelectorAll` ficam em cache por seletor (o preview localiza milhares de alvos num HTML grande),
 * então o documento não pode mudar de estrutura entre as chamadas.
 */
export function createLocator(doc: Document): (el: Element) => ElementLocator | null {
  const cache = new Map<string, Map<Element, number> | null>();
  return (el) => {
    const scope = scopeSelector(el);
    const s = scope ? `${scope} ${elementSelector(el)}` : elementSelector(el);
    let index = cache.get(s);
    if (index === undefined) {
      try {
        index = new Map(Array.from(doc.querySelectorAll(s)).map((m, i) => [m, i] as const));
      } catch {
        index = null; // seletor que o parser não aceita
      }
      cache.set(s, index);
    }
    const i = index?.get(el);
    return i === undefined ? null : { s, i };
  };
}

export function buildEditsManifest(doc: Document): EditsManifestEntry[] {
  const out: EditsManifestEntry[] = [];
  const locate = createLocator(doc);
  const seen = new Set<Element>();
  for (const el of Array.from(doc.querySelectorAll(`[${EDIT_HREF_ATTR}], [${LOCK_TEXT_ATTR}]`))) {
    if (seen.has(el)) continue;
    seen.add(el);
    const loc = locate(el);
    if (!loc) continue; // o atributo no HTML continua valendo
    const entry: EditsManifestEntry = { s: loc.s, i: loc.i };
    const href = el.getAttribute(EDIT_HREF_ATTR);
    const text = el.getAttribute(LOCK_TEXT_ATTR);
    if (href) entry.h = href;
    if (text != null) entry.t = text;
    out.push(entry);
  }
  return out;
}

/** Troca a tag de receitas do documento pela do estado atual (sem edições = sem tag). */
export function writeEditsManifest(doc: Document): number {
  doc.querySelectorAll(`script[${EDITS_MANIFEST_ATTR}]`).forEach((s) => s.remove());
  const entries = buildEditsManifest(doc);
  if (!entries.length) return 0;
  const tag = doc.createElement('script');
  tag.setAttribute('type', 'application/json');
  tag.setAttribute(EDITS_MANIFEST_ATTR, '');
  tag.textContent = JSON.stringify(entries).replace(/</g, '\\u003c');
  (doc.body ?? doc.documentElement).appendChild(tag);
  return entries.length;
}
