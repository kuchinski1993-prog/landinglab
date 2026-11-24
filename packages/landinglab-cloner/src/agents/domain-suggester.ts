// Domain Suggester — gera candidatos de nome de domínio a partir do produto.
//
// Zero API — puro string manipulation. UI usa isso pra popular cards de
// sugestão no Step 6 (Domain picker) do Wizard. Cada sugestão passa depois
// por Spaceship checkAvailability() no backend.
//
// Estratégia:
//   1. Normaliza o nome (remove acentos, lowercase, kebab-case)
//   2. Extrai "core" (primeiras 1-2 palavras significativas)
//   3. Combina com sufixos comerciais (-store, -oficial, etc)
//   4. Distribui em TLDs alternativos (.com, .store, .shop)
//
// Retorna 5-8 candidatos ordenados por (relevância + preço estimado TLD).

const TLD_PRICE_USD: Record<string, number> = {
  '.com': 10,
  '.store': 4,
  '.shop': 5,
  '.online': 3,
  '.site': 2,
  '.io': 40,
  '.co': 30,
};

const COMMERCIAL_SUFFIXES = ['', '-store', '-shop', '-oficial', '-original', '-brasil'];

const STOP_WORDS = new Set([
  'a', 'o', 'e', 'de', 'da', 'do', 'em', 'no', 'na', 'para', 'com',
  'the', 'a', 'an', 'of', 'for', 'and', 'or', 'to', 'in', 'on',
  'il', 'lo', 'la', 'i', 'gli', 'le', 'di', 'da', 'in', 'per',
  'ソフトジェル', 'カプセル',
]);

export interface DomainSuggestion {
  domain: string;
  tld: string;
  /** Preço estimado em USD por ano. Confirmar via Spaceship. */
  estimatedPriceUsd: number;
  /** Explicação da lógica que gerou (útil pra debug + UX). */
  reason: string;
}

export interface SuggestDomainsOpts {
  /** Máximo de sugestões retornadas. Default 6. */
  limit?: number;
  /** TLDs preferidos em ordem. Default ['.com', '.store', '.shop']. */
  tlds?: string[];
}

/**
 * Normaliza texto pra virar parte de domínio: sem acentos, lowercase, só
 * a-z0-9. Truncado a maxLen. Retorna null se resultado vazio.
 */
export function slugifyForDomain(text: string, maxLen = 30): string | null {
  if (!text) return null;
  const normalized = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove diacríticos
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // remove tudo que não é alfanum/space/hyphen
    .trim();
  if (!normalized) return null;

  const words = normalized
    .split(/[\s-]+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w))
    .slice(0, 3); // no máximo 3 palavras

  if (words.length === 0) return null;

  const joined = words.join('-');
  return joined.length > maxLen ? joined.slice(0, maxLen).replace(/-+$/, '') : joined;
}

/**
 * Extrai o "núcleo" do nome: primeira palavra significativa curta (útil como
 * marca curta). Ex: "Vigoraxi Peperoncino di Cayenna Softgel" → "vigoraxi".
 */
export function extractCoreName(productName: string): string | null {
  const slug = slugifyForDomain(productName, 60);
  if (!slug) return null;
  const first = slug.split('-')[0];
  return first && first.length >= 3 ? first : slug;
}

/**
 * Gera 5-8 sugestões de domínio a partir do nome do produto.
 * Ordenação: primeiro base sem sufixo em .com, depois combinações.
 */
export function suggestDomains(
  productName: string,
  opts: SuggestDomainsOpts = {},
): DomainSuggestion[] {
  const limit = opts.limit ?? 6;
  const tlds = opts.tlds ?? ['.com', '.store', '.shop'];

  const base = slugifyForDomain(productName);
  const core = extractCoreName(productName);
  if (!base) return [];

  const seen = new Set<string>();
  const out: DomainSuggestion[] = [];

  const push = (name: string, tld: string, reason: string): void => {
    if (out.length >= limit) return;
    if (name.length < 3 || name.length > 63) return; // limite DNS
    const domain = `${name}${tld}`;
    if (seen.has(domain)) return;
    seen.add(domain);
    out.push({
      domain,
      tld,
      estimatedPriceUsd: TLD_PRICE_USD[tld] ?? 15,
      reason,
    });
  };

  // TLD "primário" pra sufixos comerciais e core alt (primeiro da lista).
  // Se caller passou tlds customizados, respeita — nunca cai em .com escondido.
  const primaryTld = tlds[0] ?? '.com';

  // Prioridade 1: nome base direto em cada TLD (o mais legível)
  for (const tld of tlds) {
    push(base, tld, `nome direto do produto em ${tld}`);
    if (out.length >= limit) return out;
  }

  // Prioridade 2: nome base + sufixos comerciais no TLD primário
  for (const suffix of COMMERCIAL_SUFFIXES.slice(1)) {
    push(`${base}${suffix}`, primaryTld, `com sufixo comercial ${suffix}`);
    if (out.length >= limit) return out;
  }

  // Prioridade 3: se tem core diferente do base, tenta core + sufixos
  if (core && core !== base) {
    for (const suffix of COMMERCIAL_SUFFIXES) {
      push(
        `${core}${suffix}`,
        primaryTld,
        `com nome curto (${core}) + ${suffix || 'direto'}`,
      );
      if (out.length >= limit) return out;
    }
  }

  return out;
}
