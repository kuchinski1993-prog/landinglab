// Extração e edição de blocos de texto de uma revisão de página (F1b).
// Lê o HTML de entrada (parse5 com posições) e devolve blocos com ids estáveis por revisão.
// Aplicar edições troca SÓ os trechos editados (por posição no texto original): o resto do
// arquivo fica byte a byte igual. Strings de quiz em JS só entram quando a estrutura deixa
// claro que são textos de pergunta/resposta (literais em objetos/arrays); código nunca é reescrito.
import { createHash } from 'node:crypto';

import { parse as parseJs, parseExpressionAt } from 'acorn';
import { parse } from 'parse5';

export type PageTextKind = 'text' | 'attribute' | 'title' | 'meta' | 'script-string';
export interface PageTextBlock {
  id: string;
  kind: PageTextKind;
  /** Rótulo PT-BR para o operador ("Título", "Botão", "Pergunta do quiz"...). */
  label: string;
  text: string;
  /** Trecho ao redor (para o operador se localizar). */
  context: string;
  /** Caminho legível do elemento (ex.: "section.hero > h1"). */
  path: string;
}
export interface PageTextEdit { id: string; text: string }

export class PageTextError extends Error {
  constructor(readonly reason: 'unknown_block' | 'invalid_text' | 'encoding', readonly ids: string[] = []) { super(reason); }
}

interface Located extends PageTextBlock { start: number; end: number; encode: (value: string) => string }

/* eslint-disable @typescript-eslint/no-explicit-any -- árvores do parse5/acorn sem tipos úteis aqui */
type Html = any;
type Js = any;

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'head']);
const ASCII_WS_EDGES = /^[ \t\n\r\f]+|[ \t\n\r\f]+$/g;
const HAS_CONTENT = /[\p{L}\p{N}]/u;
const META_NAMES: Record<string, string> = {
  description: 'Descrição da página (SEO)',
  'og:title': 'Título para compartilhamento',
  'og:description': 'Descrição para compartilhamento',
};
const ATTRIBUTE_LABELS: Record<string, string> = {
  alt: 'Texto alternativo da imagem',
  placeholder: 'Texto de exemplo do campo',
  title: 'Dica ao passar o mouse',
  'aria-label': 'Rótulo de acessibilidade',
  value: 'Botão',
};
const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'body', 'form', 'ul', 'ol', 'table', 'dl', 'dd', 'dt', 'pre', 'figure', 'details']);
const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module', 'text/ecmascript']);

/** Caracteres de controle (exceto tab/LF/CR) não entram em texto de página. */
const hasControlChars = (value: string) => [...value].some((char) => { const code = char.charCodeAt(0); return code < 32 && code !== 9 && code !== 10 && code !== 13; });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const blockId = (locator: string) => `t${sha(locator).slice(0, 16)}`;
const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();
const clip = (value: string, max = 160) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const escapeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (node: Html, name: string): string | undefined => node.attrs?.find((item: Html) => item.name === name)?.value;
const tag = (node: Html): string => String(node?.tagName ?? '').toLowerCase();

function textOf(node: Html): string {
  if (node.nodeName === '#text') return node.value as string;
  if (SKIP.has(tag(node)) && tag(node) !== 'head') return '';
  return (node.childNodes ?? []).map(textOf).join(' ');
}

function elementPath(ancestors: Html[]): string {
  const parts: string[] = [];
  for (const node of ancestors) {
    const name = tag(node);
    if (!name || name === 'html' || name === 'body') continue;
    const id = attr(node, 'id');
    const cls = (attr(node, 'class') ?? '').split(/\s+/).find((item) => /^[A-Za-z_-][\w-]*$/.test(item));
    parts.push(id && /^[A-Za-z][\w-]*$/.test(id) ? `${name}#${id}` : cls ? `${name}.${cls}` : name);
  }
  return parts.slice(-4).join(' > ') || 'body';
}

function looksLikeButton(node: Html): boolean {
  const cls = `${attr(node, 'class') ?? ''} ${attr(node, 'id') ?? ''}`.toLowerCase();
  return attr(node, 'role') === 'button' || /\b(?:btn|button|botao|cta)\b|btn[-_]|[-_]btn|button[-_]|cta[-_]|[-_]cta/.test(cls);
}

function textLabel(ancestors: Html[]): string {
  for (let index = ancestors.length - 1, depth = 0; index >= 0 && depth < 6; index--, depth++) {
    const node = ancestors[index];
    const name = tag(node);
    if (name === 'button') return 'Botão';
    if (name === 'a') return looksLikeButton(node) ? 'Botão' : 'Link';
    if (name === 'h1') return 'Título';
    if (/^h[2-6]$/.test(name)) return 'Subtítulo';
    if (name === 'label') return 'Rótulo de campo';
    if (name === 'option') return 'Opção';
    if (name === 'li') return 'Item de lista';
    if (name === 'blockquote') return 'Citação';
    if (name === 'figcaption') return 'Legenda';
    if (name === 'td' || name === 'th') return 'Célula de tabela';
    if (name === 'textarea') return 'Texto do campo';
    if (name === 'summary') return 'Pergunta (lista de perguntas)';
    if (name === 'p') return 'Parágrafo';
    if (BLOCK_TAGS.has(name)) return looksLikeButton(node) ? 'Botão' : 'Texto';
  }
  return 'Texto';
}

function contextOf(ancestors: Html[], own: string): string {
  for (let index = ancestors.length - 1, depth = 0; index >= 0 && depth < 4; index--, depth++) {
    if (['body', 'html', 'head'].includes(tag(ancestors[index]))) break;
    const text = collapse(textOf(ancestors[index]));
    if (text.length > own.length + 2) return clip(text, 200);
  }
  return '';
}

/* ─────────────────────────────── Strings de quiz em <script> ─────────────────────────────── */

const norm = (key: string) => key.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
const QUESTION_KEYS = new Set(['question', 'pergunta', 'questao', 'pregunta']);
const TEXT_KEYS = new Set([...QUESTION_KEYS, 'title', 'titulo', 'text', 'texto', 'label', 'rotulo', 'answer', 'resposta', 'option', 'opcao',
  'description', 'descricao', 'subtitle', 'subtitulo', 'button', 'buttontext', 'botao', 'cta', 'placeholder', 'message', 'mensagem',
  'hint', 'dica', 'feedback', 'heading', 'headline', 'result', 'resultado', 'alternativa', 'alternative', 'choice', 'escolha']);
const ANSWER_KEYS = new Set(['answers', 'respostas', 'options', 'opcoes', 'alternativas', 'alternatives', 'choices', 'escolhas', 'respuestas', 'opciones']);
const QUIZ_KEYS = new Set([...QUESTION_KEYS, 'questions', 'perguntas', 'questoes', 'preguntas', 'answers', 'respostas', 'alternativas', 'choices', 'quiz']);
const QUIZ_NAME = /quiz|question|pergunta|questao|questoes|pregunta|respost|answer|alternativ|choice/i;

function naturalText(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2000) return false;
  if (!/\p{L}/u.test(value) || /[<>]/.test(value) || value.includes('${')) return false;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|\.{1,2}\/|#)/i.test(value.trim())) return false;
  if (/^[a-z0-9_.-]+$/.test(value)) return false; // identificador/valor técnico
  return true;
}

function literalValue(node: Js): string | null {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0 && typeof node.quasis[0]?.value?.cooked === 'string') return node.quasis[0].value.cooked;
  return null;
}

function propertyName(node: Js): string | null {
  if (node?.type !== 'Property' || node.kind !== 'init') return null;
  if (!node.computed && node.key.type === 'Identifier') return node.key.name;
  if (node.key.type === 'Literal' && typeof node.key.value === 'string') return node.key.value;
  return null;
}

function jsEncoder(raw: string): (value: string) => string {
  const quote = raw[0] === '`' ? '`' : raw[0] === "'" ? "'" : '"';
  return (value: string) => {
    let body = value.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    body = body.split(quote).join(`\\${quote}`).replace(/<\/(script)/gi, '<\\/$1');
    if (quote === '`') body = body.replace(/\$\{/g, '\\${');
    return `${quote}${body}${quote}`;
  };
}

interface ScriptString { start: number; end: number; value: string; key: string; question: string | null; answer: boolean }

function quizStrings(code: string, json: boolean): ScriptString[] {
  let program: Js;
  try {
    if (json) {
      const start = code.length - code.trimStart().length;
      program = parseExpressionAt(code, start, { ecmaVersion: 'latest' });
      if (code.slice(program.end).trim()) return [];
    } else {
      try { program = parseJs(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true }); }
      catch { program = parseJs(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }); }
    }
  } catch { return []; }
  const found: ScriptString[] = [];
  const visit = (node: Js, names: string[], question: string | null) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'ObjectExpression') {
      const keys = node.properties.map(propertyName).filter((key: string | null): key is string => Boolean(key)).map(norm);
      const quiz = keys.some((key: string) => QUIZ_KEYS.has(key)) || names.some((name) => QUIZ_NAME.test(name));
      const questionProp = node.properties.find((prop: Js) => QUESTION_KEYS.has(norm(propertyName(prop) ?? '')) && naturalText(literalValue(prop.value)));
      const ownQuestion = questionProp ? literalValue(questionProp.value) : question;
      const inAnswers = ANSWER_KEYS.has(norm(names[names.length - 1] ?? ''));
      for (const prop of node.properties) {
        const name = propertyName(prop);
        if (name === null) { visit(prop, names, ownQuestion); continue; }
        const key = norm(name);
        const value = literalValue(prop.value);
        if (quiz && TEXT_KEYS.has(key) && naturalText(value))
          found.push({ start: prop.value.start, end: prop.value.end, value, key, question: QUESTION_KEYS.has(key) ? null : ownQuestion, answer: inAnswers && !QUESTION_KEYS.has(key) });
        if (prop.value?.type === 'ArrayExpression' && ANSWER_KEYS.has(key) && (quiz || /answer|respost|alternativ|choice|escolha/.test(key)))
          for (const item of prop.value.elements) {
            const text = literalValue(item);
            if (naturalText(text)) found.push({ start: item.start, end: item.end, value: text, key, question: ownQuestion, answer: true });
          }
        visit(prop.value, [...names, name], ownQuestion);
      }
      return;
    }
    let nextNames = names;
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') nextNames = [...names, node.id.name];
    if (node.type === 'AssignmentExpression') {
      const left = node.left;
      const name = left?.type === 'Identifier' ? left.name : left?.type === 'MemberExpression' && !left.computed ? left.property?.name : null;
      if (name) nextNames = [...names, name];
    }
    for (const [field, child] of Object.entries(node)) {
      if (field === 'type' || field === 'start' || field === 'end' || !child || typeof child !== 'object') continue;
      if (Array.isArray(child)) for (const item of child) visit(item, field === 'init' || field === 'right' ? nextNames : nextNames, question);
      else visit(child, nextNames, question);
    }
  };
  visit(program, [], null);
  // Uma string pode casar como texto e como item de array: uma entrada por posição.
  const unique = new Map(found.map((item) => [item.start, item]));
  return [...unique.values()].sort((a, b) => a.start - b.start);
}

/* ─────────────────────────────── Extração ─────────────────────────────── */

function locate(html: string): Located[] {
  const document: Html = parse(html, { sourceCodeLocationInfo: true });
  const blocks: Located[] = [];
  let scriptIndex = 0;
  const pushAttribute = (node: Html, name: string, kind: PageTextKind, label: string, locator: string, ancestors: Html[]) => {
    const loc = node.sourceCodeLocation?.attrs?.[name];
    const value = attr(node, name);
    if (!loc || value === undefined || !HAS_CONTENT.test(value)) return;
    const raw = html.slice(loc.startOffset, loc.endOffset);
    const rawName = /^[^\s=]+/.exec(raw)?.[0] ?? name;
    blocks.push({ id: blockId(`${locator}@${name}`), kind, label, text: value, context: kind === 'meta' ? '' : contextOf(ancestors, value),
      path: elementPath(ancestors), start: loc.startOffset, end: loc.endOffset, encode: (next) => `${rawName}="${escapeAttr(next)}"` });
  };
  const visit = (node: Html, locator: string, ancestors: Html[]) => {
    const name = tag(node);
    if (name === 'title') {
      const text = node.childNodes?.[0];
      if (text?.nodeName === '#text' && text.sourceCodeLocation && HAS_CONTENT.test(text.value)) pushText(text, `${locator}.0`, [...ancestors, node], 'title', 'Título da página (aba do navegador)');
      return;
    }
    if (name === 'meta') {
      const key = (attr(node, 'name') ?? attr(node, 'property') ?? '').toLowerCase();
      if (META_NAMES[key]) pushAttribute(node, 'content', 'meta', META_NAMES[key], locator, ancestors);
      return;
    }
    if (name === 'script') {
      const index = scriptIndex++;
      const type = (attr(node, 'type') ?? '').trim().toLowerCase();
      const content = node.childNodes?.[0];
      if (attr(node, 'src') !== undefined || content?.nodeName !== '#text' || !content.sourceCodeLocation) return;
      const json = type === 'application/json';
      if (!json && !JS_TYPES.has(type)) return;
      const offset = content.sourceCodeLocation.startOffset as number;
      const code = html.slice(offset, content.sourceCodeLocation.endOffset);
      for (const item of quizStrings(code, json)) {
        const raw = code.slice(item.start, item.end);
        blocks.push({
          id: blockId(`${locator}#script:${item.start}`), kind: 'script-string',
          label: QUESTION_KEYS.has(item.key) ? 'Pergunta do quiz' : item.answer || /answer|resposta|alternativ|option|opcao|choice|escolha/.test(item.key) ? 'Resposta do quiz' : 'Texto do quiz',
          text: item.value, context: item.question ? `Pergunta: ${clip(item.question, 180)}` : '', path: `script[${index}] › ${item.key}`,
          start: offset + item.start, end: offset + item.end, encode: json ? (next) => JSON.stringify(next) : jsEncoder(raw),
        });
      }
      return;
    }
    if (SKIP.has(name)) {
      if (name === 'head') (node.childNodes ?? []).forEach((child: Html, index: number) => visit(child, `${locator}.${index}`, [...ancestors, node]));
      return;
    }
    if (node.attrs) {
      for (const attribute of ['alt', 'placeholder', 'title', 'aria-label'])
        pushAttribute(node, attribute, 'attribute', name === 'img' && attribute === 'title' ? 'Dica da imagem' : ATTRIBUTE_LABELS[attribute]!, locator, [...ancestors, node]);
      if (name === 'input' && ['submit', 'button', 'reset'].includes((attr(node, 'type') ?? '').toLowerCase()))
        pushAttribute(node, 'value', 'attribute', 'Botão', locator, [...ancestors, node]);
    }
    if (node.nodeName === '#text') {
      if (HAS_CONTENT.test(node.value) && node.sourceCodeLocation) pushText(node, locator, ancestors, 'text', textLabel(ancestors));
      return;
    }
    (node.childNodes ?? []).forEach((child: Html, index: number) => visit(child, `${locator}.${index}`, [...ancestors, node]));
  };
  const pushText = (node: Html, locator: string, ancestors: Html[], kind: PageTextKind, label: string) => {
    const { startOffset, endOffset } = node.sourceCodeLocation;
    const raw = html.slice(startOffset, endOffset);
    const lead = /^[ \t\n\r\f]*/.exec(raw)![0];
    const trail = /[ \t\n\r\f]*$/.exec(raw.slice(lead.length))![0];
    const text = String(node.value).replace(ASCII_WS_EDGES, '');
    blocks.push({ id: blockId(`${locator}#text`), kind, label, text, context: kind === 'title' ? '' : contextOf(ancestors, text),
      path: elementPath(ancestors), start: startOffset, end: endOffset, encode: (next) => `${lead}${escapeText(next)}${trail}` });
  };
  visit(document, '0', []);
  return blocks.sort((a, b) => a.start - b.start);
}

/** Blocos de texto editáveis/traduzíveis da página, na ordem do documento. */
export function extractPageTextBlocks(html: string): PageTextBlock[] {
  return locate(html).map(({ id, kind, label, text, context, path }) => ({ id, kind, label, text, context, path }));
}

/** Decodifica UTF-8 exigindo ida e volta exata (senão não dá para preservar o resto byte a byte). */
export function decodePageHtml(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new PageTextError('encoding');
  return text;
}

/**
 * Aplica edições por id. Só os trechos editados mudam; `lang` (opcional) atualiza/insere `<html lang>`.
 * Erros: `unknown_block` (id inexistente), `invalid_text` (string de quiz com `<`/`>` ou texto vazio em script).
 */
export function applyPageTextEdits(html: string, edits: PageTextEdit[], options: { lang?: string } = {}): string {
  const blocks = new Map(locate(html).map((block) => [block.id, block]));
  const unknown = edits.filter((edit) => !blocks.has(edit.id)).map((edit) => edit.id);
  if (unknown.length) throw new PageTextError('unknown_block', unknown);
  const invalid = edits.filter((edit) => typeof edit.text !== 'string' || hasControlChars(edit.text) ||
    (blocks.get(edit.id)!.kind === 'script-string' && (/[<>]/.test(edit.text) || !edit.text.trim()))).map((edit) => edit.id);
  if (invalid.length) throw new PageTextError('invalid_text', invalid);
  const patches = edits.map((edit) => blocks.get(edit.id)!).filter((block, index) => block.text !== edits[index]!.text)
    .map((block) => ({ start: block.start, end: block.end, text: block.encode(edits.find((edit) => edit.id === block.id)!.text) }));
  if (options.lang) {
    if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(options.lang)) throw new PageTextError('invalid_text', ['lang']);
    const document: Html = parse(html, { sourceCodeLocationInfo: true });
    const root = document.childNodes?.find((node: Html) => tag(node) === 'html');
    const loc = root?.sourceCodeLocation;
    if (loc?.attrs?.lang) patches.push({ start: loc.attrs.lang.startOffset, end: loc.attrs.lang.endOffset, text: `lang="${options.lang}"` });
    else if (loc?.startTag) {
      const at = loc.startTag.startOffset + '<html'.length;
      patches.push({ start: at, end: at, text: ` lang="${options.lang}"` });
    }
  }
  patches.sort((a, b) => b.start - a.start);
  let out = html;
  let floor = Number.POSITIVE_INFINITY;
  for (const patch of patches) {
    if (patch.end > floor) throw new PageTextError('invalid_text', ['overlap']);
    out = out.slice(0, patch.start) + patch.text + out.slice(patch.end);
    floor = patch.start;
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
