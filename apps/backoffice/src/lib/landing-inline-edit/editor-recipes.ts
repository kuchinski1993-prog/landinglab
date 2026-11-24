// Receitas das marcas do editor (só no preview `?edit=inline`, nunca no HTML gravado). Os scripts da landing
// rodam no editor e redesenham blocos (cards de oferta, preço na moeda do visitante): o elemento novo não
// tem `data-ll-eid`, então o botão ORDER não abria o campo de link e o texto não era editável. Cada alvo
// marcado no servidor vira `{s, i}` (mesmo localizador das receitas do runtime) + os atributos de marca;
// o script do editor recoloca as marcas em quem perdeu. Textos e imagens têm guarda: só remarca se o
// texto (ou o `src`) ainda for o do HTML cru — senão o ID apontaria para outro conteúdo no salvar.

import { createLocator } from './manifest';
import { collectTextImageTargets } from './text-targets';

export const EDITOR_RECIPES_ID = 'll-editor-recipes';

const MARK_ATTRS = ['data-ll-eid', 'data-ll-kind', 'data-ll-label', 'data-ll-cur-text', 'data-ll-cur-href', 'data-ll-multi-text'];

export interface EditorRecipe {
  s: string;
  i: number;
  /** Atributos de marca a recolocar. */
  a: Record<string, string>;
  /** Guarda: texto (aparado) do HTML cru para `text`, `src` para `image`. */
  g?: string;
}

/**
 * Carimba `data-ll-eid`/`data-ll-kind` nos textos e imagens (IDs `e_` iguais aos do PATCH). Chamar sobre o
 * HTML cru, depois de `markInlineEditTargets`: texto de botão/preço continua no painel, não inline.
 */
export function markTextImageTargets(doc: Document, targets = collectTextImageTargets(doc)): Record<'text' | 'image', number> {
  const counts = { text: 0, image: 0 };
  for (const { id, kind, el } of targets) {
    if (el.hasAttribute('data-ll-eid') || el.closest('[data-ll-kind="button"],[data-ll-kind="price"]')) continue;
    el.setAttribute('data-ll-eid', id);
    el.setAttribute('data-ll-kind', kind);
    counts[kind]++;
  }
  return counts;
}

export function buildEditorRecipes(doc: Document): EditorRecipe[] {
  const locate = createLocator(doc);
  const out: EditorRecipe[] = [];
  for (const el of Array.from(doc.querySelectorAll('[data-ll-eid]'))) {
    const loc = locate(el);
    if (!loc) continue;
    const a: Record<string, string> = {};
    for (const name of MARK_ATTRS) {
      const v = el.getAttribute(name);
      if (v != null) a[name] = v;
    }
    const recipe: EditorRecipe = { s: loc.s, i: loc.i, a };
    if (a['data-ll-kind'] === 'text') recipe.g = (el.textContent ?? '').trim();
    else if (a['data-ll-kind'] === 'image') recipe.g = el.getAttribute('src') ?? '';
    out.push(recipe);
  }
  return out;
}

export function editorRecipesTag(recipes: EditorRecipe[]): string {
  // `<` e `/` escapados: o JSON não fecha a tag nem casa com os filtros de script do preview.
  const json = JSON.stringify(recipes).replace(/</g, '\\u003c').replace(/\//g, '\\/');
  return `<script type="application/json" id="${EDITOR_RECIPES_ID}">${json}</script>`;
}
