// Sugestões automáticas de botão de compra (CTA) a partir do HTML de uma revisão de página.
// Serve para o operador escolher o botão mesmo quando ele está num passo oculto do quiz (o picker na prévia só
// alcança o que está na tela). Candidato = link/botão que aponta para checkout/próxima etapa ou com texto de compra.
// O seletor devolvido é único no HTML estático (verificado com css-select) e respeita a regra da API (1..200, sem {};<>).
import { selectAll } from 'css-select';
import { parse } from 'parse5';
import { adapter } from 'parse5-htmlparser2-tree-adapter';

export interface VslCtaCandidate {
  selector: string;
  text: string;
  href: string | null;
  /**
   * Por que foi sugerido: link de checkout/próxima etapa, link HTTPS para outro site (checkout COD/loja própria,
   * VSL-14) e/ou texto de compra.
   */
  reasons: Array<'checkout_link' | 'next_step_link' | 'external_link' | 'buy_text'>;
}

/**
 * Aviso da página que acompanha o CTA travado ("Seguí mirando el video para desbloquear tu plan"): o runtime o esconde
 * quando o CTA é liberado (`waitSelectors`). `ctaSelectors`: sugestões de CTA ao lado das quais o aviso foi achado.
 */
export interface VslCtaWaitCandidate { selector: string; text: string; ctaSelectors: string[] }
export interface VslCtaSuggestions { candidates: VslCtaCandidate[]; waitCandidates: VslCtaWaitCandidate[] }

/* eslint-disable @typescript-eslint/no-explicit-any -- árvore do parse5 (adapter htmlparser2) sem tipos úteis aqui */
type Node = any;

const MAX_CANDIDATES = 20;
const MAX_SELECTOR = 200;
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'svg', 'math']);
const CHECKOUT_HOSTS = /(^|\.)(hotmart\.com|kiwify\.com\.br|kiwify\.app|eduzz\.com|monetizze\.com\.br)$/i;
// Texto de compra (pt/es/en/fr/de/it/pl/nl): "Quiero mi plan", "Eu quero", "Comprar agora", "Buy now", "Acheter", "Jetzt kaufen",
// "Zamów teraz", "Kup teraz", "Bestel nu"...
const BUY_TEXT = /(^|[^\p{L}])(quiero|quero|comprar|compra|compre|pedir|buy|order|acheter|achetez|commander|kaufen|bestellen|acquista|ordina|kup|kupuj[eę]|zam[oó]w|zamawiam|bestel|koop|checkout)($|[^\p{L}])/iu;
const DYNAMIC_CLASS = /^(?:active|hover|focus|selected|open|show|visible|hidden|is-|has-|js-|ng-|css-[a-z0-9]{5,}|sc-|jsx-)|\d{4,}|^[a-z0-9]{8,}$/i;
const IDENT = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;
// Texto de "espere/continue assistindo para desbloquear" (es/pt/en/it/fr/de).
const WAIT_TEXT = /(segu[ií]|sigue|sigan|contin[uú]a)\s+(mirando|viendo)|continue\s+(assistindo|vendo|watching)|keep\s+watching|desbloque|unlock|continua\s+a\s+guardare|sblocc|continuez\s+[àa]\s+regarder|d[ée]bloqu|weiter\s*(an)?(sehen|schauen)|schau\s+weiter|freischalt|entsperr/iu;
// Classe/id de spinner/aviso de espera (wait/lock/loading…), como token separado por - ou _.
const WAIT_CLASS = /(^|[-_])(wait|waiting|lock|locked|loading|loader|spinner|spin)($|[-_])/i;
const MAX_WAIT_TEXT = 160;
const MAX_WAIT_LEVELS = 3;
const MAX_WAIT_CANDIDATES = 10;

const isElement = (node: Node) => node && node.type !== 'text' && node.type !== 'comment' && typeof node.name === 'string';
const attr = (node: Node, name: string): string | undefined => node.attribs?.[name];
function textOf(node: Node): string {
  if (node.type === 'text') return node.data ?? '';
  if (!isElement(node) || SKIP.has(node.name)) return '';
  return (node.children ?? []).map(textOf).join(' ');
}
const squash = (value: string) => value.replace(/\s+/g, ' ').trim();

function hrefReason(href: string | undefined, nextPath: string | null): VslCtaCandidate['reasons'][number] | null {
  if (!href) return null;
  const value = href.trim();
  if (!value || value.startsWith('#') || /^(javascript|mailto|tel):/i.test(value)) return null;
  let url: URL;
  try { url = new URL(value, 'https://page.invalid/'); } catch { return null; }
  if (url.hostname !== 'page.invalid') {
    if (url.protocol !== 'https:') return null;
    return CHECKOUT_HOSTS.test(url.hostname) ? 'checkout_link' : 'external_link';
  }
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (nextPath && nextPath !== '/' && path === (nextPath.replace(/\/+$/, '') || '/')) return 'next_step_link';
  return /(^|\/)checkout(\/|$)/i.test(path) ? 'checkout_link' : null;
}

function candidateKind(node: Node): boolean {
  if (node.name === 'a') return true;
  if (node.name === 'button') return true;
  if (node.name === 'input') return ['submit', 'button', 'image'].includes(String(attr(node, 'type') ?? '').toLowerCase());
  return attr(node, 'role') === 'button';
}

export function findCtaCandidates(html: string, options: { nextPath?: string | null } = {}): VslCtaCandidate[] {
  return findCtaSuggestions(html, options).candidates;
}

/** Botões de compra sugeridos + mensagens de espera próximas a eles (mesmo container/irmãos, até 3 ancestrais acima). */
export function findCtaSuggestions(html: string, options: { nextPath?: string | null } = {}): VslCtaSuggestions {
  const tree = parse(html, { treeAdapter: adapter }) as Node;
  const root = tree.children;
  const count = (selector: string): Node[] => {
    try { return selectAll(selector, root) as Node[]; } catch { return []; }
  };
  const unique = (selector: string, node: Node) =>
    selector.length <= MAX_SELECTOR && !/[{};<>]/.test(selector) && ![...selector].some((char) => char.charCodeAt(0) < 32) &&
    (() => { const found = count(selector); return found.length === 1 && found[0] === node; })();
  const stableClasses = (node: Node) => String(attr(node, 'class') ?? '').split(/\s+/).filter((name) => name && name.length <= 40 && IDENT.test(name) && !DYNAMIC_CLASS.test(name));
  const ownSelector = (node: Node): string | null => {
    const id = attr(node, 'id');
    if (id && id.length <= 60 && IDENT.test(id) && !/\d{4,}/.test(id) && unique(`#${id}`, node)) return `#${id}`;
    const tag = node.name;
    for (const [name, value] of Object.entries(node.attribs ?? {}) as Array<[string, string]>) {
      if (!name.startsWith('data-') || name.startsWith('data-blackshop') || !/^[a-z0-9_-]+$/.test(name) || value.length > 60 || /["\\\n]/.test(value)) continue;
      const selector = `${tag}[${name}${value ? `="${value}"` : ''}]`;
      if (unique(selector, node)) return selector;
    }
    const classes = stableClasses(node);
    for (const name of classes) {
      if (unique(`.${name}`, node)) return `.${name}`;
      if (unique(`${tag}.${name}`, node)) return `${tag}.${name}`;
    }
    for (let x = 0; x < classes.length; x++) for (let y = x + 1; y < classes.length; y++)
      if (unique(`${tag}.${classes[x]}.${classes[y]}`, node)) return `${tag}.${classes[x]}.${classes[y]}`;
    const href = tag === 'a' ? attr(node, 'href') : undefined;
    if (href && href.length <= 150 && !/["\\\n]/.test(href) && unique(`a[href="${href}"]`, node)) return `a[href="${href}"]`;
    return null;
  };
  const segment = (node: Node, strict: boolean) => {
    const siblings = (node.parent?.children ?? [node]).filter((child: Node) => isElement(child) && child.name === node.name);
    return siblings.length > 1 || strict ? `${node.name}:nth-of-type(${siblings.indexOf(node) + 1})` : node.name;
  };
  // Igual ao picker: id/data/classe/href próprios; senão caminho curto ancorado no ancestral com seletor próprio
  // (ou body). Sem `>` (a API rejeita `{};<>`); a segunda passada usa :nth-of-type em todos os níveis.
  const selectorFor = (node: Node): string | null => {
    const own = ownSelector(node);
    if (own) return own;
    for (const strict of [false, true]) {
      const parts = [segment(node, strict)];
      for (let parent = node.parent; parent && isElement(parent) && parent.name !== 'html'; parent = parent.parent) {
        const anchor = parent.name === 'body' ? 'body' : ownSelector(parent);
        if (anchor && unique(`${anchor} ${parts.join(' ')}`, node)) return `${anchor} ${parts.join(' ')}`;
        if (anchor && anchor !== 'body') break;
        if (parent.name !== 'body') parts.unshift(segment(parent, strict));
      }
      if (unique(parts.join(' '), node)) return parts.join(' ');
    }
    return null;
  };

  const nextPath = options.nextPath ?? null;
  const found: VslCtaCandidate[] = [];
  const nodes = new Map<string, Node>();
  const seen = new Set<string>();
  const walk = (node: Node) => {
    if (found.length >= MAX_CANDIDATES) return;
    if (isElement(node)) {
      if (SKIP.has(node.name)) return;
      if (candidateKind(node)) {
        const href = node.name === 'a' ? attr(node, 'href') ?? null : null;
        const text = squash(node.name === 'input' ? attr(node, 'value') ?? attr(node, 'alt') ?? '' : textOf(node) || attr(node, 'aria-label') || '').slice(0, 120);
        const reasons: VslCtaCandidate['reasons'] = [];
        const linkReason = hrefReason(href ?? undefined, nextPath);
        if (linkReason) reasons.push(linkReason);
        if (BUY_TEXT.test(text)) reasons.push('buy_text');
        const selector = reasons.length ? selectorFor(node) : null;
        if (selector && !seen.has(selector)) {
          seen.add(selector);
          nodes.set(selector, node);
          found.push({ selector, text, href: href ? href.slice(0, 500) : null, reasons });
        }
        return; // não procura botões dentro de botões
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  for (const node of root) walk(node);
  // Link de checkout/próxima etapa (ou link externo com texto de compra) antes de "só texto"/"só link externo";
  // empate mantém a ordem do documento.
  const weight = (candidate: VslCtaCandidate) => {
    const has = (reason: VslCtaCandidate['reasons'][number]) => candidate.reasons.includes(reason);
    return has('checkout_link') || has('next_step_link') || (has('external_link') && has('buy_text')) ? 0 : 1;
  };
  const candidates = found.map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => weight(a.candidate) - weight(b.candidate) || a.index - b.index).map(({ candidate }) => candidate);

  // Mensagem de espera: no subárvore dos irmãos do CTA (ou dos irmãos de um ancestral próximo), o elemento mais externo
  // de texto curto que fala em "continuar assistindo/desbloquear" ou tem classe/id de espera (spinner sem texto → o pai).
  const waitClass = (node: Node) => [...String(attr(node, 'class') ?? '').split(/\s+/), String(attr(node, 'id') ?? '')]
    .some((name) => name && WAIT_CLASS.test(name));
  const MEDIA = ['video', 'iframe', 'img', 'input', 'select', 'textarea'];
  const interactive = (node: Node): boolean => isElement(node) && !SKIP.has(node.name) &&
    (candidateKind(node) || MEDIA.includes(node.name) || attr(node, 'data-blackshop-video') !== undefined || (node.children ?? []).some(interactive));
  const waitIn = (node: Node, depth: number, container: Node): Node[] => {
    if (!isElement(node) || SKIP.has(node.name) || candidateKind(node) || MEDIA.includes(node.name)) return [];
    const text = squash(textOf(node));
    // Um aviso não contém botões/links/vídeo: um bloco que contém é seção da página, não mensagem de espera.
    if (text.length <= MAX_WAIT_TEXT && !interactive(node)) {
      if (WAIT_TEXT.test(text)) return [node];
      if (waitClass(node)) return [!text && node.parent && node.parent !== container && !interactive(node.parent) &&
        squash(textOf(node.parent)).length <= MAX_WAIT_TEXT ? node.parent : node];
    }
    if (depth >= 2) return [];
    return (node.children ?? []).flatMap((child: Node) => waitIn(child, depth + 1, container));
  };
  const waits = new Map<string, VslCtaWaitCandidate>();
  for (const candidate of candidates) {
    const cta = nodes.get(candidate.selector);
    let child = cta;
    for (let level = 0; level < MAX_WAIT_LEVELS && waits.size < MAX_WAIT_CANDIDATES; level++) {
      const container = child?.parent;
      // Irmãos no <body> são seções inteiras da página: longe demais para ligar ao botão.
      if (!container || !isElement(container) || container.name === 'html' || container.name === 'body') break;
      const hits = (container.children ?? []).filter((sibling: Node) => sibling !== child).flatMap((sibling: Node) => waitIn(sibling, 0, container));
      for (const hit of hits) {
        const selector = selectorFor(hit);
        if (!selector || nodes.has(selector)) continue;
        const existing = waits.get(selector);
        if (existing) { if (!existing.ctaSelectors.includes(candidate.selector)) existing.ctaSelectors.push(candidate.selector); continue; }
        if (waits.size >= MAX_WAIT_CANDIDATES) break;
        waits.set(selector, { selector, text: squash(textOf(hit)).slice(0, 120), ctaSelectors: [candidate.selector] });
      }
      if (hits.length) break; // o mais próximo vence; não sobe até a página inteira
      child = container;
    }
  }
  return { candidates, waitCandidates: [...waits.values()] };
}
