// Slug normalization + validation — fonte única para o slug do subdomínio de
// publish (landing_deployments.hostname parte antes do dot).
//
// Coexiste com `slugify.ts` (produto/coleção/page) porque as regras são
// diferentes: aqui capamos em 40 chars e colapsamos hífens (URL segment de
// subdomínio, não title). Não substitua um pelo outro.
//
// Consumidores: PublishSection (client, live preview), publish-core (server,
// mode=subdomain), futuros callers de "gerar hostname". `landing-actions.ts`
// mantém sua própria validação (rejeita ao invés de sanitizar — comportamento
// intencional pra edição manual de row salva).

// Normaliza input livre pra slug válido. Retorna string vazia se não sobrar
// nada aproveitável (input só com pontuação).
export function normalizeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

// Regex pós-normalização. Mantém equivalência com landing-actions.ts §59
// (start/end alphanumeric, hifens permitidos no meio).
export const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_REGEX.test(slug);
}

// Op atômica: normaliza + valida. Handler único pra UI e server publish.
export function validateAndNormalizeSlug(
  raw: string,
): { ok: true; normalized: string } | { ok: false; error: string } {
  const normalized = normalizeSlug(raw);
  if (!normalized || normalized.length < 2) {
    return { ok: false, error: 'Slug precisa ter no mínimo 2 caracteres.' };
  }
  if (!isValidSlug(normalized)) {
    return { ok: false, error: 'Slug deve conter apenas letras minúsculas, números e hífens.' };
  }
  return { ok: true, normalized };
}
