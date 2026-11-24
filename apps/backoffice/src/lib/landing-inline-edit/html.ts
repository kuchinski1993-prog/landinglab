// Story 26.1 — ponte jsdom para os alvos do editor visual (preview `?edit=inline` e `PATCH edit-inline`).

import { buildEditorRecipes, markTextImageTargets, type EditorRecipe } from './editor-recipes';
import { markInlineEditTargets } from './targets';
import { collectTextImageTargets } from './text-targets';

// jsdom não expõe types próprios no repo — mesmo padrão de `api/landing-pages/[id]/edit-inline/route.ts`.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM } = require('jsdom') as {
  JSDOM: new (html: string, opts?: unknown) => { window: { document: Document }; serialize(): string };
};

export type JsdomInstance = InstanceType<typeof JSDOM>;

export function parseLandingHtml(html: string): JsdomInstance {
  return new JSDOM(html, { includeNodeLocations: false });
}

export function isFullDocument(html: string): boolean {
  const head = html.trimStart().slice(0, 200);
  return /^<!doctype/i.test(head) || /^<html/i.test(head);
}

export interface EditableHtml {
  doc: Document;
  /** Documento completo volta completo; fragmento volta fragmento. */
  serialize(): string;
}

/** Parse usado no preview e no PATCH — mesma estrutura dos dois lados, então os IDs batem. */
export function parseEditableHtml(html: string): EditableHtml {
  if (isFullDocument(html)) {
    const dom = parseLandingHtml(html);
    return { doc: dom.window.document, serialize: () => dom.serialize() };
  }
  // <body> explícito: <style>/<link> do começo do fragmento ficam no lugar (não sobem para o <head>).
  const dom = parseLandingHtml(`<!DOCTYPE html><html><head></head><body>${html}</body></html>`);
  return { doc: dom.window.document, serialize: () => dom.window.document.body.innerHTML };
}

/**
 * Marca seções, botões, preços, textos e imagens no HTML cru (mesmos IDs do PATCH) e devolve as receitas
 * para o editor remarcar o que os scripts da landing redesenharem. Fragmento continua fragmento.
 */
export function prepareInlineEditorHtml(html: string): { html: string; recipes: EditorRecipe[] } {
  const page = parseEditableHtml(html);
  // IDs `e_` calculados antes de qualquer marca (o caminho não muda, mas o PATCH calcula sobre o HTML puro).
  const textImage = collectTextImageTargets(page.doc);
  markInlineEditTargets(page.doc);
  markTextImageTargets(page.doc, textImage);
  const recipes = buildEditorRecipes(page.doc);
  return { html: page.serialize(), recipes };
}

export function markInlineEditTargetsInHtml(html: string): string {
  return prepareInlineEditorHtml(html).html;
}
