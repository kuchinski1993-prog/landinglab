// Story 13.10 — validação do domínio digitado e geração de sugestões
// (puro, sem I/O — testável sem mocks).

import type { DomainQuote, TldPrice } from './client';

import { slugify } from '@/lib/slugify';

// ─── Domínio digitado (AC4) ──────────────────────────────────────────────

export type DomainInputResult = { ok: true; domain: string } | { ok: false; reason: string };

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE = /^[a-z]{2,63}$/;

/**
 * Valida um domínio digitado pelo operador: lowercase, sem esquema/caminho,
 * FQDN válido (labels 1–63, total ≤ 253, TLD alfabético). Não "conserta"
 * URLs — recusa com motivo para o operador corrigir.
 */
export function validateDomainInput(raw: unknown): DomainInputResult {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: 'Informe um domínio (ex.: nome.online)' };
  }
  const trimmed = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.includes('/')) {
    return { ok: false, reason: 'Digite só o domínio, sem http:// nem caminho (ex.: nome.online)' };
  }
  if (/[\s?#@:]/.test(trimmed)) {
    return { ok: false, reason: 'Domínio com caracteres inválidos' };
  }
  const domain = trimmed.toLowerCase().replace(/\.$/, '');
  if (domain.length > 253) return { ok: false, reason: 'Domínio longo demais' };
  const labels = domain.split('.');
  if (labels.length < 2) return { ok: false, reason: 'Falta o TLD (ex.: nome.online)' };
  const tld = labels[labels.length - 1]!;
  if (!TLD_RE.test(tld)) return { ok: false, reason: `TLD inválido: .${tld}` };
  for (const label of labels) {
    if (!LABEL_RE.test(label)) {
      return { ok: false, reason: `Parte inválida no domínio: "${label || '(vazia)'}"` };
    }
  }
  return { ok: true, domain };
}

// ─── Sugestões baseadas no produto (AC3) ─────────────────────────────────

export interface NamingContext {
  /** Nome do produto/marca de destino (brandTo, nome no checkout, título). */
  productNames: string[];
  /** Idioma/mercado (ISO-639-1: it, de, fr, es, en, pt). */
  language: string | null;
  /** Marca de origem do clone (brandFrom) — nunca sugerir o mesmo nome. */
  sourceBrand: string | null;
  /** URL de origem do clone — o nome do domínio de origem também é proibido. */
  sourceUrl: string | null;
}

const LANGUAGE_AFFIXES: Record<string, { suffixes: string[]; prefixes: string[] }> = {
  it: { suffixes: ['italia', 'shop', 'store', 'vita', 'casa', 'top', 'facile'], prefixes: ['il', 'mio', 'puro'] },
  de: { suffixes: ['shop', 'laden', 'welt', 'haus', 'direkt', 'plus'], prefixes: ['mein', 'das', 'pur'] },
  fr: { suffixes: ['boutique', 'france', 'maison', 'shop', 'vie', 'direct'], prefixes: ['mon', 'le', 'pur'] },
  es: { suffixes: ['tienda', 'shop', 'casa', 'vida', 'directo', 'top'], prefixes: ['mi', 'el', 'puro'] },
  pt: { suffixes: ['loja', 'shop', 'vida', 'casa', 'oficial', 'top'], prefixes: ['meu', 'o', 'puro'] },
  en: { suffixes: ['shop', 'store', 'hub', 'direct', 'life', 'co'], prefixes: ['get', 'try', 'my'] },
};

/** Palavras que não identificam o produto (não viram raiz). */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'per', 'con', 'und', 'mit', 'les', 'des', 'pour', 'para', 'por',
  'del', 'della', 'der', 'die', 'das', 'une', 'uno', 'una', 'offer', 'offerta', 'oferta', 'angebot',
  'offre', 'pack', 'kit', 'new', 'nuovo', 'neu', 'nouveau', 'nuevo', 'original', 'officiel',
  'official', 'ufficiale', 'oficial', 'shop', 'store', 'www', 'com', 'http', 'https',
]);

function compact(text: string): string {
  return slugify(text).replace(/-/g, '');
}

function tokens(text: string): string[] {
  return slugify(text)
    .split('-')
    .filter((t) => t.length >= 4 && !/^\d+$/.test(t) && !STOPWORDS.has(t));
}

/**
 * Nomes proibidos: marca de origem (inteira e por palavra) + nome do
 * domínio de origem (sem www/TLD/subdomínio).
 */
export function forbiddenNames(ctx: Pick<NamingContext, 'sourceBrand' | 'sourceUrl'>): string[] {
  const out = new Set<string>();
  if (ctx.sourceBrand) {
    const whole = compact(ctx.sourceBrand);
    if (whole.length >= 3) out.add(whole);
    for (const t of tokens(ctx.sourceBrand)) if (t.length >= 4) out.add(t);
  }
  if (ctx.sourceUrl) {
    try {
      const url = new URL(/^[a-z]+:\/\//i.test(ctx.sourceUrl) ? ctx.sourceUrl : `https://${ctx.sourceUrl}`);
      const labels = url.hostname.toLowerCase().replace(/^www\./, '').split('.');
      // Nome registrável: penúltimo label (ignora shop.myshopify etc. só pelo nome).
      const name = labels.length >= 2 ? labels[labels.length - 2]! : labels[0]!;
      const c = compact(name);
      if (c.length >= 3 && c !== 'myshopify') out.add(c);
      if (labels.length >= 3 && labels[labels.length - 2] === 'myshopify') {
        const shop = compact(labels[0]!);
        if (shop.length >= 3) out.add(shop);
      }
    } catch {
      /* source_url inválida → ignora */
    }
  }
  return [...out];
}

/**
 * true se a raiz é o mesmo nome da marca de origem ou variação trivial
 * (mesmo nome com hífen/sufixo/prefixo — ex.: marca+"shop", "get"+marca).
 * Nomes apenas parecidos (ex.: prefixo da marca + sufixo novo) são permitidos.
 */
export function isForbiddenRoot(root: string, forbidden: string[]): boolean {
  const r = compact(root);
  return forbidden.some((f) => r === f || (f.length >= 4 && r.includes(f)));
}

const ROOT_MIN = 3;
const ROOT_MAX = 20;

/** Gera raízes (sem TLD) a partir do produto + idioma, sem a marca de origem. */
export function buildRoots(ctx: NamingContext, limit = 12): string[] {
  const forbidden = forbiddenNames(ctx);
  const lang = (ctx.language ?? 'en').slice(0, 2).toLowerCase();
  const affixes = LANGUAGE_AFFIXES[lang] ?? LANGUAGE_AFFIXES['en']!;

  const bases: string[] = [];
  for (const name of ctx.productNames) {
    if (!name) continue;
    const whole = compact(name);
    if (whole.length >= ROOT_MIN && whole.length <= 14) bases.push(whole);
    for (const t of tokens(name)) bases.push(t);
  }

  const seeds: string[] = [];
  for (const base of [...new Set(bases)]) {
    if (!isForbiddenRoot(base, forbidden)) {
      seeds.push(base);
    } else if (base.length >= 6) {
      // Mesmo nome da marca de origem → só variações "parecidas": prefixo encurtado.
      seeds.push(base.slice(0, Math.max(4, Math.ceil(base.length * 0.6))));
    }
  }

  const groups = seeds.map((seed) => [
    seed,
    ...affixes.suffixes.map((s) => `${seed}${s}`),
    ...affixes.prefixes.map((p) => `${p}${seed}`),
  ]);
  const width = groups[0]?.length ?? 0;

  const out: string[] = [];
  const seen = new Set<string>();
  // Intercala por afixo para não esgotar o limite com a mesma semente.
  for (let i = 0; i < width; i += 1) {
    for (const group of groups) {
      const candidate = group[i];
      if (!candidate || seen.has(candidate)) continue;
      if (candidate.length < ROOT_MIN || candidate.length > ROOT_MAX) continue;
      if (isForbiddenRoot(candidate, forbidden)) continue;
      seen.add(candidate);
      out.push(candidate);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Combina raízes com TLDs (todos os TLDs com preço; filtro opcional) e
 * escolhe até `max` candidatos para checar, priorizando o menor preço do
 * 1º ano com diversidade (máx. `perTld` por TLD e `perRoot` por raiz).
 */
export function pickCandidates(
  roots: string[],
  pricing: TldPrice[],
  opts: { tld?: string | null; max?: number; perTld?: number; perRoot?: number } = {},
): string[] {
  const max = opts.max ?? 25;
  const filter = opts.tld ? opts.tld.replace(/^\./, '').toLowerCase() : null;
  const tlds = filter ? pricing.filter((p) => p.tld === filter) : pricing;
  const perTld = filter ? max : (opts.perTld ?? 3);
  const perRoot = filter ? 1 : (opts.perRoot ?? 3);

  const pool: Array<{ domain: string; root: string; tld: string; cents: number; rank: number }> = [];
  roots.forEach((root, rank) => {
    for (const t of tlds) {
      pool.push({ domain: `${root}.${t.tld}`, root, tld: t.tld, cents: t.registrationCents, rank });
    }
  });
  pool.sort((a, b) => a.cents - b.cents || a.rank - b.rank || a.tld.localeCompare(b.tld));

  const byTld = new Map<string, number>();
  const byRoot = new Map<string, number>();
  const out: string[] = [];
  for (const c of pool) {
    if (out.length >= max) break;
    if ((byTld.get(c.tld) ?? 0) >= perTld || (byRoot.get(c.root) ?? 0) >= perRoot) continue;
    byTld.set(c.tld, (byTld.get(c.tld) ?? 0) + 1);
    byRoot.set(c.root, (byRoot.get(c.root) ?? 0) + 1);
    out.push(c.domain);
  }
  return [...new Set(out)];
}

// ─── Ordenação (AC5) ─────────────────────────────────────────────────────

const STATUS_ORDER: Record<DomainQuote['status'], number> = {
  available: 0,
  unknown: 1,
  premium: 2,
  unavailable: 3,
  invalid: 4,
};

/** Disponíveis por menor preço do 1º ano; indeterminados e indisponíveis ao final. */
export function sortQuotes(quotes: DomainQuote[]): DomainQuote[] {
  return [...quotes].sort((a, b) => {
    const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (s !== 0) return s;
    const pa = a.priceCents ?? Number.MAX_SAFE_INTEGER;
    const pb = b.priceCents ?? Number.MAX_SAFE_INTEGER;
    return pa - pb || a.domain.localeCompare(b.domain);
  });
}
