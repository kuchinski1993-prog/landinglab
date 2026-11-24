// CTA Detector — extração e reescrita de Call-To-Action links no HTML clonado.
//
// Uso: pós-clone, backoffice chama extractCTAs pra popular UI de configuração.
// Operator preenche URLs de destino, chama rewriteCTAs pra aplicar mudanças
// e persistir HTML novo.
//
// Sem custo API — puro string/DOM manipulation via parse5.
//
// Categorias (heurística por URL path):
//   - sale:        contém /product /cart /checkout /order /buy → CRÍTICO trocar
//   - nav:         contém /pages /blog /adv → geralmente trocar
//   - internal:    começa com # → âncora interna, PRESERVAR
//   - external:    mailto:/tel:/protocol externo do domínio origem → PRESERVAR
//   - placeholder: href="/" ou href="#" solto → OPCIONAL (root domain)
//   - unknown:     fallback quando nada casa

import * as parse5 from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

type Parse5Node = DefaultTreeAdapterMap['node'];
type Parse5Element = DefaultTreeAdapterMap['element'];
type Attribute = { name: string; value: string };

export type CtaCategory = 'sale' | 'nav' | 'internal' | 'external' | 'placeholder' | 'unknown';

export interface DetectedCta {
  /** Selector estável pra localizar o elemento no rewrite. Formato:
   * `tag[href='...']:nth-of-type(N)` — N único por (tag,href) combo. */
  selector: string;
  /** innerText do link/button (max 80 chars). Usado só pra UI display. */
  text: string;
  /** href original (ou string vazia pra button sem href). */
  currentHref: string;
  /** Categoria heurística. */
  category: CtaCategory;
  /** Tag do elemento: 'a' ou 'button'. Butoun implica conversão pra <a> no rewrite. */
  tag: 'a' | 'button';
  /** True se estiver em <nav>, <header> ou <footer> — hint pra UI agrupar. */
  isChrome: boolean;
}

export interface CtaMapping {
  selector: string;
  /** URL nova. Se vazia (''), remove o CTA (converte pra span). Se null, preserva original. */
  newHref: string | null;
  /**
   * Se presente, marca o elemento como botão de compra: adiciona
   * data-landing-cta="buy" + data-landing-variant-id={landingVariantId}.
   * O runtime de checkout (checkout-handler-injector) detecta esses attrs
   * e dispara POST /api/landing-checkout ao clicar. Neste caso, newHref
   * pode ser null (o script sobrescreve o click).
   */
  landingVariantId?: string;
  /** Quantidade padrão desse botão (default 1). Vira data-landing-qty. */
  quantity?: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Extraction
// ─────────────────────────────────────────────────────────────────────────

const SALE_HINTS = /\/(product|cart|checkout|order|buy|shop)/i;
const NAV_HINTS = /\/(pages|blog|adv|article|post)/i;

function isElement(node: Parse5Node): node is Parse5Element {
  const n = node as { tagName?: string; attrs?: unknown };
  if (typeof n.tagName !== 'string') return false;
  // Garantir attrs array — alguns nodes exóticos (Text, Document) não têm.
  if (!Array.isArray(n.attrs)) {
    (n as { attrs: unknown[] }).attrs = [];
  }
  return true;
}

function getAttr(el: Parse5Element, name: string): string | null {
  const attr = el.attrs.find((a: Attribute) => a.name.toLowerCase() === name.toLowerCase());
  return attr ? attr.value : null;
}

function extractText(node: Parse5Node, buf: string[] = []): string[] {
  if (node.nodeName === '#text') {
    const value = (node as unknown as { value: string }).value;
    if (value) buf.push(value);
  } else if (isElement(node)) {
    const children = node.childNodes;
    if (Array.isArray(children)) {
      for (const child of children) extractText(child, buf);
    }
  }
  return buf;
}

function categorize(href: string, sourceOrigin: string | null): CtaCategory {
  if (!href) return 'unknown';
  if (href.startsWith('#')) return 'internal';
  if (/^(mailto|tel|sms|javascript):/i.test(href)) return 'external';

  // Placeholder root: href="/" ou href="#"
  if (href === '/' || href === '#') return 'placeholder';

  // URL absoluta
  if (/^https?:/i.test(href)) {
    if (SALE_HINTS.test(href)) return 'sale';
    if (NAV_HINTS.test(href)) return 'nav';
    // Absoluta pra domínio diferente do source: external
    if (sourceOrigin) {
      try {
        const linkOrigin = new URL(href).origin;
        if (linkOrigin !== sourceOrigin) return 'external';
      } catch {
        // fall through
      }
    }
    return 'unknown';
  }

  // Path relativo
  if (href.startsWith('/')) {
    if (SALE_HINTS.test(href)) return 'sale';
    if (NAV_HINTS.test(href)) return 'nav';
  }

  return 'unknown';
}

function isInsideChrome(ancestors: string[]): boolean {
  return ancestors.some((t) => t === 'nav' || t === 'header' || t === 'footer');
}

/**
 * Selector estável: `tag[href='...']:nth-of-type(N)` onde N é ordem de
 * aparição desse par (tag,href) no documento. Determinístico pra
 * rewriteCTAs encontrar o elemento sem depender de position no DOM.
 */
function buildSelector(
  tag: 'a' | 'button',
  href: string,
  seenCount: Map<string, number>,
): string {
  const key = `${tag}::${href}`;
  const idx = (seenCount.get(key) ?? 0) + 1;
  seenCount.set(key, idx);
  return `${tag}[data-cta-idx='${idx}'][data-cta-href='${escapeAttr(href)}']`;
}

function escapeAttr(v: string): string {
  return v.replace(/'/g, '&#39;');
}

interface CollectContext {
  ancestors: string[];
  seenCount: Map<string, number>;
  sourceOrigin: string | null;
  out: DetectedCta[];
}

function walk(node: Parse5Node, ctx: CollectContext): void {
  // Root Document/DocumentFragment não é element mas tem childNodes — recursa
  // sem push no ancestors.
  if (!isElement(node)) {
    const children = (node as { childNodes?: Parse5Node[] }).childNodes;
    if (Array.isArray(children)) {
      for (const child of children) walk(child, ctx);
    }
    return;
  }
  const tagName = node.tagName.toLowerCase();
  ctx.ancestors.push(tagName);

  if (tagName === 'a' || tagName === 'button') {
    const href = tagName === 'a' ? getAttr(node, 'href') ?? '' : '';
    // Button sem role de link puro (add cart Shopify, checkout) só entra
    // se tiver texto de sale/checkout (heurística de conversão).
    if (tagName === 'a' || looksLikeSaleButton(node)) {
      const text = extractText(node).join(' ').replace(/\s+/g, ' ').trim().slice(0, 80);
      const category = tagName === 'button' ? 'sale' : categorize(href, ctx.sourceOrigin);
      const selector = buildSelector(tagName, href, ctx.seenCount);
      ctx.out.push({
        selector,
        text,
        currentHref: href,
        category,
        tag: tagName,
        isChrome: isInsideChrome(ctx.ancestors),
      });
    }
  }

  const children = node.childNodes;
  if (Array.isArray(children)) {
    for (const child of children) walk(child, ctx);
  }
  ctx.ancestors.pop();
}

const SALE_BUTTON_TEXT = /\b(comprar|buy|order|add\s*(to)?\s*cart|adiciona|checkout|finalizar|pagar|pay\s*now|aggiungi\s*al\s*carrello|acquista|kaufen|comprar\s*agora)\b/i;

function looksLikeSaleButton(el: Parse5Element): boolean {
  const text = extractText(el).join(' ').trim();
  if (!text) return false;
  return SALE_BUTTON_TEXT.test(text);
}

export interface ExtractCtasOpts {
  /** URL da origem original (pra classificar external vs local). */
  sourceUrl?: string;
}

export interface ExtractCtasResult {
  /** HTML anotado com data-cta-idx + data-cta-href pra permitir rewrite estável. */
  html: string;
  /** CTAs detectados, ordem de aparição. */
  ctas: DetectedCta[];
}

/**
 * Detecta CTAs no HTML e ANOTA o HTML com atributos data-cta-* pra permitir
 * rewrite estável depois. Retorna HTML anotado + lista de CTAs.
 *
 * IMPORTANTE: o HTML retornado tem os data-attrs. Persistir esse HTML é ok
 * (attrs data-* são ignorados por browsers). Chamador pode escolher persistir
 * ou usar só a lista pra UI.
 */
export function extractCtas(html: string, opts: ExtractCtasOpts = {}): ExtractCtasResult {
  const sourceOrigin = opts.sourceUrl ? safeOrigin(opts.sourceUrl) : null;
  const isFullDoc = /<html/i.test(html);
  const document = isFullDoc ? parse5.parse(html) : parse5.parseFragment(html);

  const ctx: CollectContext = {
    ancestors: [],
    seenCount: new Map(),
    sourceOrigin,
    out: [],
  };
  walk(document, ctx);

  // Segunda passada: anota o HTML com data-cta-idx/data-cta-href baseado nos
  // selectors gerados. Fazemos anotação inline no AST (não reserializa hash).
  const annotateSeen = new Map<string, number>();
  annotate(document, annotateSeen);

  const outHtml = isFullDoc
    ? parse5.serialize(document)
    : parse5.serialize(document);

  return { html: outHtml, ctas: ctx.out };
}

function annotate(node: Parse5Node, seenCount: Map<string, number>): void {
  if (!isElement(node)) {
    const children = (node as { childNodes?: Parse5Node[] }).childNodes;
    if (Array.isArray(children)) {
      for (const child of children) annotate(child, seenCount);
    }
    return;
  }
  const tagName = node.tagName.toLowerCase();
  if (tagName === 'a' || (tagName === 'button' && looksLikeSaleButton(node))) {
    const href = tagName === 'a' ? getAttr(node, 'href') ?? '' : '';
    const key = `${tagName}::${href}`;
    const idx = (seenCount.get(key) ?? 0) + 1;
    seenCount.set(key, idx);
    // SEMPRE sobrescreve data-cta-idx/data-cta-href com valores atuais.
    // Não podemos preservar anotações antigas — depois de um rewrite, o href
    // do elemento muda mas o selector antigo (com data-cta-href=antigo) fica
    // desalinhado do novo href, fazendo re-rewrites falharem silenciosamente
    // (bySignature.get() → miss). Rewriting é idempotente: a segunda passada
    // recompõe idx/href a partir do estado atual.
    setOrReplaceAttr(node, 'data-cta-idx', String(idx));
    setOrReplaceAttr(node, 'data-cta-href', href);
  }
  const children = node.childNodes;
  if (Array.isArray(children)) {
    for (const child of children) annotate(child, seenCount);
  }
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Rewrite
// ─────────────────────────────────────────────────────────────────────────

export interface RewriteCtasResult {
  html: string;
  applied: number;
  skipped: number;
}

/**
 * Aplica mappings no HTML. Requer HTML previamente anotado por extractCtas
 * (data-cta-idx + data-cta-href). Mappings sem selector match são ignorados
 * silenciosamente (retornados em skipped counter).
 *
 * Regras por newHref:
 *   - string não-vazia → substitui href (ou converte button → a com href)
 *   - '' (string vazia) → remove o link (converte pra <span> com mesmo text)
 *   - null → preserva original (no-op — útil pra UI marcar "manter")
 */
export function rewriteCtas(html: string, mappings: CtaMapping[]): RewriteCtasResult {
  if (mappings.length === 0) return { html, applied: 0, skipped: 0 };

  const isFullDoc = /<html/i.test(html);
  const document = isFullDoc ? parse5.parse(html) : parse5.parseFragment(html);

  // Index mappings por (tag,idx,href) pra lookup O(1) — guarda mapping completo
  // pra permitir aplicar landingVariantId + quantity além de newHref.
  const bySignature = new Map<string, CtaMapping>();
  for (const m of mappings) {
    const parsed = parseSelector(m.selector);
    if (!parsed) continue;
    bySignature.set(`${parsed.tag}::${parsed.idx}::${parsed.href}`, m);
  }

  let applied = 0;
  let skipped = 0;

  function annotateBuyButton(el: Parse5Element, mapping: CtaMapping): void {
    // Marca como botão de compra. Se mapping tem landingVariantId → bind fixo;
    // se não tem (mapping.landingVariantId undefined) → botão universal que usa
    // a variant ATIVA no DOM (data-landing-variant-active) via findActiveVariantId.
    setOrReplaceAttr(el, 'data-landing-cta', 'buy');
    if (mapping.landingVariantId) {
      setOrReplaceAttr(el, 'data-landing-variant-id', mapping.landingVariantId);
    }
    if (mapping.quantity && mapping.quantity > 1) {
      setOrReplaceAttr(el, 'data-landing-qty', String(mapping.quantity));
    }
    // Se o elemento é <button type="submit">, muda pra "button" pra não
    // submeter o <form> pai (que teria action="/cart/add" e cairia em 404).
    // Script client-side vai interceptar o click e disparar checkout.
    if (el.tagName.toLowerCase() === 'button') {
      setOrReplaceAttr(el, 'type', 'button');
    }
    // Garante cursor pointer mesmo se ainda for <button> sem estilo.
    const currentStyle = getAttr(el, 'style') ?? '';
    if (!/cursor\s*:/i.test(currentStyle)) {
      const newStyle = currentStyle ? `${currentStyle};cursor:pointer` : 'cursor:pointer';
      setOrReplaceAttr(el, 'style', newStyle);
    }
  }

  function transform(node: Parse5Node): void {
    if (!isElement(node)) {
      const children = (node as { childNodes?: Parse5Node[] }).childNodes;
      if (Array.isArray(children)) {
        for (const child of children) transform(child);
      }
      return;
    }
    const tagName = node.tagName.toLowerCase();
    if (tagName === 'a' || tagName === 'button') {
      const idxAttr = getAttr(node, 'data-cta-idx');
      const hrefAttr = getAttr(node, 'data-cta-href');
      if (idxAttr && hrefAttr !== null) {
        const sig = `${tagName}::${idxAttr}::${hrefAttr}`;
        if (bySignature.has(sig)) {
          const mapping = bySignature.get(sig)!;
          const newHref = mapping.newHref;
          // newHref=null:
          //   - COM landingVariantId → botão de compra (variant fixa, ou universal
          //     se undefined mas o operador explicitou intent via mapping).
          //   - SEM landingVariantId → intent de "preservar original" (skip).
          //     Caller UI (backoffice /api/landing-cta) usa exatamente isso pra
          //     manter CTAs de nav/external intactos. NÃO transformar em buy
          //     button — isso viraria link de navegação em checkout trigger.
          if (newHref === null) {
            if (mapping.landingVariantId !== undefined) {
              annotateBuyButton(node, mapping);
              applied++;
            } else {
              skipped++;
            }
          } else if (newHref === '') {
            // Convert em <span> com mesmo innerText
            convertToSpan(node);
            applied++;
          } else {
            // newHref definido (não null, não '').
            // 2 modos:
            //   A) Com landingVariantId → botão de compra (data-landing-cta="buy",
            //      runtime injetado captura click → /landing-checkout).
            //   B) Sem landingVariantId (advertorial linkando pra sales page,
            //      ou nav externo) → LINK NATIVO só com href. Sem data-landing-cta,
            //      pra que o navigator siga o href normalmente.
            const finalHref: string = newHref;
            if (mapping.landingVariantId) {
              annotateBuyButton(node, mapping);
              if (tagName === 'button') {
                convertButtonToAnchor(node, finalHref);
              } else {
                setOrReplaceAttr(node, 'href', finalHref);
              }
            } else {
              // Modo link nativo: só troca href, sem marker de checkout.
              // Remove data-landing-cta se existir (limpa estado antigo).
              node.attrs = node.attrs.filter(
                (a: Attribute) => a.name.toLowerCase() !== 'data-landing-cta',
              );
              if (tagName === 'button') {
                convertButtonToAnchor(node, finalHref);
              } else {
                setOrReplaceAttr(node, 'href', finalHref);
              }
            }
            // Se newHref é externa, adiciona target/rel default (ambos modos).
            if (tagName === 'a' && /^https?:/i.test(finalHref)) {
              if (!getAttr(node, 'target')) {
                node.attrs.push({ name: 'target', value: '_blank' });
              }
              if (!getAttr(node, 'rel')) {
                node.attrs.push({ name: 'rel', value: 'noopener noreferrer' });
              }
            }
            applied++;
          }
        }
      }
    }
    const children = node.childNodes;
    if (Array.isArray(children)) {
      for (const child of children) transform(child);
    }
  }
  transform(document);

  const outHtml = parse5.serialize(document);
  return { html: outHtml, applied, skipped };
}

function parseSelector(sel: string): { tag: 'a' | 'button'; idx: string; href: string } | null {
  // `tag[data-cta-idx='N'][data-cta-href='H']`
  const m = sel.match(/^(a|button)\[data-cta-idx='([^']+)'\]\[data-cta-href='([^']*)'\]$/);
  if (!m || !m[1] || m[2] === undefined || m[3] === undefined) return null;
  return { tag: m[1] as 'a' | 'button', idx: m[2], href: m[3] };
}

function setOrReplaceAttr(el: Parse5Element, name: string, value: string): void {
  const existing = el.attrs.find((a: Attribute) => a.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    existing.value = value;
  } else {
    el.attrs.push({ name, value });
  }
}

function convertButtonToAnchor(button: Parse5Element, newHref: string): void {
  // parse5 permite mutação inline do tagName + namespace.
  (button as { tagName: string }).tagName = 'a';
  (button as { nodeName: string }).nodeName = 'a';
  // Remove attrs button-only e adiciona href/target/rel.
  button.attrs = button.attrs.filter(
    (a: Attribute) => !['type', 'disabled', 'form', 'formaction', 'formmethod'].includes(a.name.toLowerCase()),
  );
  setOrReplaceAttr(button, 'href', newHref);
  if (/^https?:/i.test(newHref)) {
    if (!getAttr(button, 'target')) button.attrs.push({ name: 'target', value: '_blank' });
    if (!getAttr(button, 'rel')) button.attrs.push({ name: 'rel', value: 'noopener noreferrer' });
  }
}

function convertToSpan(el: Parse5Element): void {
  (el as { tagName: string }).tagName = 'span';
  (el as { nodeName: string }).nodeName = 'span';
  // Remove href/target/rel (irrelevantes em span). Preserva class/style/data-cta-*.
  el.attrs = el.attrs.filter(
    (a: Attribute) => !['href', 'target', 'rel', 'type'].includes(a.name.toLowerCase()),
  );
}
