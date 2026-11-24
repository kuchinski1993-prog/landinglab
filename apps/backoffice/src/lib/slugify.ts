// Slug helper — mesma heurística usada em apps/backoffice (products/pages/collections).
// Inline pra evitar dep extra (slugify npm) — regra é simples e estável.
//
// Ex: "Sereia — 4 potes" → "sereia-4-potes"
// Ex: "VigoraXi — Oferta Única" → "vigoraxi-oferta-unica"

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove diacríticos (acentos)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
