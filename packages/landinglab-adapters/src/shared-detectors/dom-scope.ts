// ADR-002 §11.2 §3-4 — Region instance identity + DOM scope.
//
// Region instance identity é determinística para o mesmo DOM estrutural.
// Não usamos random UUID nem nth-child cru.
//
// Estratégia:
//   scopeSignature = structural path do elemento raiz da região.
//     Ex.: 'body>main:0>section:2>h1:0'
//   instanceId = sha256(scopeSignature).slice(0, 12)
//
// Overlap:
//   scope A contém scope B  ⇔  A.path é prefixo de B.path
//   scope A === scope B     ⇔  A.path === B.path

import { createHash } from 'node:crypto';
import type { CheerioAPI } from 'cheerio';

// Cheerio doesn't re-export AnyNode/Element from its root types in some
// build configs. Usar unknown + narrow interno.
type CheerioNode = unknown;

/**
 * DomScope descreve onde no DOM uma região vive.
 * É neutro em relação a detector (compartilhado por adapters + shared).
 */
export interface DomScope {
  /**
   * Structural path do elemento raiz. Formato:
   *   'body>tag:index>tag:index>...'
   * Não inclui text nodes. Index é a posição entre siblings do mesmo tag.
   * Determinístico pro mesmo DOM.
   */
  structuralPath: string;

  /**
   * Hash curto de structuralPath. Usado como region instance ID estável.
   * sha256(structuralPath).slice(0, 12) — colisão negligível pra 1 DOM.
   */
  instanceId: string;

  /**
   * Selector CSS do elemento raiz (diagnóstico interno).
   * Preferir data-attr, id ou primeira classe estável quando possível.
   * NÃO usar como identidade primária — structuralPath é a fonte de verdade.
   */
  selector: string;

  /**
   * tagName do elemento raiz. Ex.: 'div', 'section', 'article'.
   */
  tagName: string;
}

/**
 * Constrói DomScope a partir de um elemento Cheerio.
 * Nunca lança. Se elemento é inválido, retorna scope 'root:unknown'.
 */
export function buildDomScope($: CheerioAPI, el: CheerioNode): DomScope {
  const path = computeStructuralPath($, el);
  const instanceId = shortHash(path);
  const tagName = extractTagName(el);
  const selector = buildDiagnosticSelector($, el, tagName);
  return { structuralPath: path, instanceId, selector, tagName };
}

/**
 * Testa se scopeA contém scopeB no DOM (A é ancestor de B).
 */
export function scopeContains(scopeA: DomScope, scopeB: DomScope): boolean {
  if (scopeA.structuralPath === scopeB.structuralPath) return false;
  return scopeB.structuralPath.startsWith(scopeA.structuralPath + '>');
}

/**
 * Testa se dois scopes se referem ao MESMO elemento no DOM.
 */
export function scopeEquals(a: DomScope, b: DomScope): boolean {
  return a.structuralPath === b.structuralPath;
}

/**
 * Testa se dois scopes se sobrepõem (mesma raiz OU ancestor/descendant).
 */
export function scopeOverlaps(a: DomScope, b: DomScope): boolean {
  return scopeEquals(a, b) || scopeContains(a, b) || scopeContains(b, a);
}

// ────────────────────────────────────────────────────────────────
// Helpers internos
// ────────────────────────────────────────────────────────────────

function computeStructuralPath($: CheerioAPI, el: CheerioNode): string {
  const parts: string[] = [];
  let current: CheerioNode = el;

  while (current) {
    const asAny = current as { type?: string; tagName?: string };
    if (asAny.type !== 'tag') break;
    const tag = (asAny.tagName ?? '').toLowerCase();
    if (!tag) break;

    // Encontra índice entre siblings do mesmo tag
    const $current = $(current as never);
    const parent = $current.parent();
    if (parent.length === 0 || tag === 'html') {
      parts.unshift(tag);
      break;
    }
    const siblings = parent.children(tag).toArray();
    const idx = siblings.findIndex((s) => s === current);
    parts.unshift(`${tag}:${idx < 0 ? 0 : idx}`);

    // Sobe pro parent
    const parentNode = parent.get(0);
    if (!parentNode) break;
    current = parentNode;
  }

  return parts.length > 0 ? parts.join('>') : 'root:unknown';
}

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

function extractTagName(el: CheerioNode): string {
  const asAny = el as { type?: string; tagName?: string };
  return (asAny.tagName ?? '').toLowerCase() || 'unknown';
}

function buildDiagnosticSelector($: CheerioAPI, el: CheerioNode, tagName: string): string {
  const $el = $(el as never);
  const id = ($el.attr('id') ?? '').trim();
  if (id) return `${tagName}#${cssEscape(id)}`;

  const dataId = firstDataAttr($el);
  if (dataId) return `${tagName}[${dataId.name}="${cssEscape(dataId.value)}"]`;

  const cls = ($el.attr('class') ?? '').trim().split(/\s+/).filter(Boolean);
  if (cls.length > 0) return `${tagName}.${cls[0]}`;

  return tagName;
}

function firstDataAttr($el: ReturnType<CheerioAPI>): { name: string; value: string } | null {
  const el = $el.get(0);
  if (!el || (el as { type?: string }).type !== 'tag') return null;
  const attribs = (el as unknown as { attribs?: Record<string, string> }).attribs ?? {};
  for (const [name, value] of Object.entries(attribs)) {
    if (name.startsWith('data-') && value) {
      return { name, value };
    }
  }
  return null;
}

function cssEscape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
