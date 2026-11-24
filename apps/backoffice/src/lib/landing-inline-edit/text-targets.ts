// Textos e imagens editáveis direto na página (IDs `e_…`). Calculados SÓ no servidor, sobre o `html_body`
// cru — no preview `?edit=inline` (marca `data-ll-eid`/`data-ll-kind`) e no `PATCH edit-inline` (acha o
// elemento pelo ID). O navegador não recalcula: lá os scripts da landing já mexeram no DOM (cards
// recriados, preço trocado, wrappers inseridos) e o ID não batia mais ("Nenhum edit aplicado").

export type TextImageKind = 'text' | 'image';

export interface TextImageTarget {
  id: string;
  kind: TextImageKind;
  el: Element;
}

const TEXT_TAGS = [
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SPAN', 'LI',
  'STRONG', 'EM', 'B', 'I', 'SMALL', 'LABEL', 'FIGCAPTION', 'BLOCKQUOTE', 'A', 'DIV',
];

const SKIP_ANCESTOR_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT']);

function djb2(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) + str.charCodeAt(i);
    h = h & 0xffffffff;
  }
  return (h >>> 0).toString(36);
}

function pathOf(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.tagName !== 'BODY' && cur.parentElement) {
    const p: Element = cur.parentElement;
    let idx = 0;
    let sib = p.firstElementChild;
    while (sib && sib !== cur) {
      if (sib.tagName === cur.tagName) idx++;
      sib = sib.nextElementSibling;
    }
    parts.unshift(cur.tagName + idx);
    cur = p;
    if (parts.length >= 8) break;
  }
  return parts.join('>');
}

export function stableId(el: Element, kind: TextImageKind, text: string): string {
  const basis = `${kind}|${el.tagName}|${pathOf(el)}|${(text || '').slice(0, 40)}`;
  return `e_${djb2(basis)}`;
}

function hasSkipAncestor(el: Element): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (SKIP_ANCESTOR_TAGS.has(p.tagName) || p.tagName.includes('-')) return true;
  }
  return false;
}

export function isPureTextElement(el: Element): boolean {
  if (el.childNodes.length !== 1) return false;
  const first = el.childNodes[0]!;
  return first.nodeType === 3 && !!first.nodeValue && first.nodeValue.trim().length > 0;
}

/** Textos (um único nó de texto) e imagens (src não-data:). ID repetido: vale o primeiro. */
export function collectTextImageTargets(doc: Document): TextImageTarget[] {
  const out: TextImageTarget[] = [];
  const seen = new Set<string>();
  const push = (id: string, kind: TextImageKind, el: Element): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, kind, el });
  };
  for (const tag of TEXT_TAGS) {
    for (const el of Array.from(doc.getElementsByTagName(tag))) {
      if (!isPureTextElement(el) || hasSkipAncestor(el)) continue;
      push(stableId(el, 'text', el.childNodes[0]!.nodeValue ?? ''), 'text', el);
    }
  }
  for (const img of Array.from(doc.getElementsByTagName('img'))) {
    if (hasSkipAncestor(img)) continue;
    const src = img.getAttribute('src') ?? '';
    if (!src || src.startsWith('data:')) continue;
    push(stableId(img, 'image', src), 'image', img);
  }
  return out;
}
