// Story 20.10a — lógica pura da lista de landings (`/landing-pages`): URL, argumentos da Server
// Action, rótulos de preço/progresso/erro, marcas e prévia do cartão. Sem DOM, testável em unidade.

import { deriveCloneLifecycle, isLegacyManualLanding } from '@/lib/clone-lifecycle';
import { FIDELITY_BADGE_CONFIG, parseFidelityFromCloneMetadata } from '@/lib/fidelity-badge';
import { AI_SQUADS, type AiSquad, type LandingPageSummary, type LandingStatus, type SquadStatus } from '@/lib/landing-types';

export const PAGE_SIZE = 24;
export const SEARCH_DEBOUNCE_MS = 300;
/** Busca maior que isto é cortada (a Server Action faz `ilike` com o termo inteiro). */
export const QUERY_MAX_LENGTH = 120;
/** Erro da IA acima disto aparece resumido (117 caracteres + "...") com o texto inteiro acessível. */
export const ERROR_SUMMARY_LENGTH = 120;

export type StatusFilter = LandingStatus | 'all';

export const STATUS_OPTIONS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'Todas' },
  { value: 'draft', label: 'Rascunho' },
  { value: 'published', label: 'Publicado' },
  { value: 'archived', label: 'Arquivado' },
];

export const STATUS_LABEL: Record<LandingStatus, string> = {
  draft: 'Rascunho',
  published: 'Publicado',
  archived: 'Arquivado',
};

export type BadgeTone = 'info' | 'success' | 'warning' | 'critical' | 'caution' | 'neutral';

const STATUS_TONE: Record<LandingStatus, BadgeTone> = {
  draft: 'info',
  published: 'success',
  archived: 'critical',
};

export interface ListParams {
  q: string;
  status: StatusFilter;
  page: number;
}

interface ParamSource {
  get(name: string): string | null;
}

function isStatusFilter(value: string | null): value is StatusFilter {
  return STATUS_OPTIONS.some((o) => o.value === value);
}

/** `?page=` inteiro ≥ 1 (senão 1) — nunca `NaN` no offset. */
export function parsePage(raw: string | null): number {
  const n = Number(raw ?? '1');
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** Busca aparada e limitada a `QUERY_MAX_LENGTH`. */
export function normalizeQuery(raw: string | null): string {
  return (raw ?? '').trim().slice(0, QUERY_MAX_LENGTH);
}

/** Lê `?q=&status=&page=` sem confiar na URL: status desconhecido → `all`, página inválida → 1. */
export function parseListParams(params: ParamSource): ListParams {
  const status = params.get('status');
  return {
    q: normalizeQuery(params.get('q')),
    status: isStatusFilter(status) ? status : 'all',
    page: parsePage(params.get('page')),
  };
}

/** Endereço da tela: `q` só quando há busca, `status` só quando ≠ all, `page` só quando > 1. */
export function landingsUrl(q: string, status: StatusFilter, page: number): string {
  const url = new URLSearchParams();
  const term = normalizeQuery(q);
  if (term) url.set('q', term);
  if (status !== 'all') url.set('status', status);
  if (page > 1) url.set('page', String(page));
  return `/landing-pages${url.size ? `?${url}` : ''}`;
}

/** Argumentos de `getLandingPagesSummary` — os mesmos de antes da migração. */
export function summaryArgs(
  q: string,
  status: StatusFilter,
  page: number,
): { status: StatusFilter; q: string | undefined; limit: number; offset: number } {
  const term = normalizeQuery(q);
  return { status, q: term || undefined, limit: PAGE_SIZE, offset: (parsePage(String(page)) - 1) * PAGE_SIZE };
}

/** "EUR 69.95"; preço ausente, inválido ou zero → "EUR —". */
export function priceLabel(currency: string, price: string): string {
  const num = Number(price);
  if (!Number.isFinite(num) || num === 0) return `${currency} —`;
  return `${currency} ${num.toFixed(2)}`;
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return n === 1 ? singular : pluralForm;
}

/** "1 landing" / "9 landings". */
export function countLabel(total: number): string {
  return `${total} ${plural(total, 'landing')}`;
}

const SQUAD_LABEL: Record<AiSquad, string> = {
  product_research: '1. Research',
  copy: '2. Copy',
  visual: '3. Visual',
  build_html: '4. Build',
  deploy: '5. Deploy',
};

const SQUAD_STATUS_LABEL: Record<SquadStatus, string> = {
  idle: 'não iniciada',
  running: 'em andamento',
  completed: 'concluída',
  failed: 'falhou',
};

export interface ProgressInfo {
  /** "IA 3/5" ou "IA falhou". */
  text: string;
  failed: boolean;
  /** Etapa por etapa, para leitor de tela e dica ("1. Research: concluída · 2. Copy: falhou · …"). */
  detail: string;
}

/** Progresso da geração por IA, em texto (antes era só bolinhas coloridas). */
export function progressInfo(progress: Record<AiSquad, SquadStatus>): ProgressInfo {
  const statuses = AI_SQUADS.map((s) => progress[s] ?? 'idle');
  const failed = statuses.includes('failed');
  const done = statuses.filter((s) => s === 'completed').length;
  return {
    text: failed ? 'IA falhou' : `IA ${done}/${AI_SQUADS.length}`,
    failed,
    detail: AI_SQUADS.map((s) => `${SQUAD_LABEL[s]}: ${SQUAD_STATUS_LABEL[progress[s] ?? 'idle']}`).join(' · '),
  };
}

/** Resumo do último erro (o mesmo corte de antes); `truncated` diz se o texto inteiro precisa de dica. */
export function errorSummary(error: string): { summary: string; truncated: boolean } {
  if (error.length <= ERROR_SUMMARY_LENGTH) return { summary: error, truncated: false };
  return { summary: `${error.slice(0, ERROR_SUMMARY_LENGTH - 3)}...`, truncated: true };
}

export interface LandingBadge {
  key: string;
  label: string;
  tone: BadgeTone;
  icon?: 'magic';
  /** Dica da marca (fidelidade: descrição, achados e bloqueio de publicação). */
  hint?: string;
}

function fidelityHint(cloneMetadata: LandingPageSummary['cloneMetadata']): { label: string; tone: BadgeTone; hint: string } | null {
  const info = parseFidelityFromCloneMetadata(cloneMetadata);
  if (info.verdict === 'UNKNOWN') return null;
  const cfg = FIDELITY_BADGE_CONFIG[info.verdict];
  const parts = [cfg.description];
  if ((info.verdict === 'DEGRADED' || info.verdict === 'BLOCKED') && info.findings.length > 0) {
    const shown = info.findings.slice(0, 3).join('; ');
    const more = info.findings.length > 3 ? ` (+${info.findings.length - 3} mais…)` : '';
    parts.push(`Findings (${info.findings.length}): ${shown}${more}`);
  }
  if (cfg.blocksPublish) parts.push('Publish automático está bloqueado.');
  return { label: cfg.label, tone: cfg.tone, hint: parts.join(' ') };
}

/**
 * Marcas da linha, na ordem e com o texto de antes: Legacy | estado do clone (Clonando…,
 * Processando…, Falhou, Clonada) | IA | fidelidade (só clone pronto, sem UNKNOWN) | status.
 */
export function landingBadges(landing: LandingPageSummary): LandingBadge[] {
  const badges: LandingBadge[] = [];
  const isLegacy = isLegacyManualLanding(landing.generationMode, landing.cloneMetadata);
  // O resumo não traz `clonedAt` nem `htmlBody`: o `clone_metadata` basta (mesma chamada do cartão antigo).
  const clone = landing.generationMode === 'cloned' ? deriveCloneLifecycle(landing.generationMode, landing.cloneMetadata, null, '') : null;

  if (isLegacy) badges.push({ key: 'legacy', label: 'Legacy', tone: 'warning' });
  if (!isLegacy && clone?.status === 'cloning') badges.push({ key: 'clone', label: 'Clonando…', tone: 'warning' });
  if (!isLegacy && clone?.status === 'processing') badges.push({ key: 'clone', label: 'Processando…', tone: 'info' });
  if (!isLegacy && clone?.status === 'failed') badges.push({ key: 'clone', label: 'Falhou', tone: 'critical' });
  if (!isLegacy && clone?.status === 'ready') badges.push({ key: 'clone', label: 'Clonada', tone: 'caution' });
  if (landing.generationMode === 'autopilot') badges.push({ key: 'ai', label: 'IA', tone: 'neutral', icon: 'magic' });
  if (clone?.status === 'ready') {
    const fidelity = fidelityHint(landing.cloneMetadata);
    if (fidelity) badges.push({ key: 'fidelity', ...fidelity });
  }
  badges.push({ key: 'status', label: STATUS_LABEL[landing.status], tone: STATUS_TONE[landing.status] });
  return badges;
}

/** Link "Abrir site" (publicada) ou "Ver preview" (rascunho), sempre em nova aba. */
export function siteLink(landing: Pick<LandingPageSummary, 'id' | 'publishedUrl'>): { label: string; href: string; hint: string } {
  return landing.publishedUrl
    ? { label: 'Abrir site', href: landing.publishedUrl, hint: `Publicada em ${landing.publishedUrl}` }
    : { label: 'Ver preview', href: `/api/landing-preview/${landing.id}`, hint: 'Preview público (landing ainda não publicada)' };
}

export function editorHref(id: string): string {
  return `/landing-pages/${id}/editor`;
}

/** Grade: quantos cartões de pelo menos 280px couberem (como a grade antiga), todos da mesma largura. */
export const LANDING_GRID_COLUMNS = 'repeat(auto-fill, minmax(280px, 1fr))';

/** Id do link do título do cartão. */
export function landingLinkId(id: string): string {
  return `landing-link-${id}`;
}

/** A prévia é a página renderizada numa "tela" de 1280×800 (16:10), reduzida à largura do cartão. */
export const PREVIEW_VIEWPORT = { width: 1280, height: 800 } as const;
export const PREVIEW_ASPECT_RATIO = `${PREVIEW_VIEWPORT.width} / ${PREVIEW_VIEWPORT.height}`;

export type PreviewKind = 'page' | 'hero' | 'placeholder';

/**
 * O que o topo do cartão mostra: a página (já tem HTML), senão a imagem hero, senão um placeholder.
 * A prévia é sempre o HTML salvo (o mesmo do "Ver preview"), também nas publicadas — o domínio
 * publicado é de terceiros, mais lento, e o HTML salvo é o que vai para ele.
 */
export function previewKind(landing: Pick<LandingPageSummary, 'hasHtml' | 'heroImageUrl'>): PreviewKind {
  if (landing.hasHtml) return 'page';
  if (landing.heroImageUrl) return 'hero';
  return 'placeholder';
}

/** Miniatura da página: o preview do sistema em modo miniatura (sem scripts nem pixels, CSP fechada). */
export function previewThumbHref(id: string): string {
  return `/api/landing-preview/${id}?thumb=1`;
}

/** Iniciais do placeholder ("Sérum Vitamina C" → "SV"); título vazio → "—". */
export function titleInitials(title: string): string {
  const letters = title
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w))
    .slice(0, 2)
    .map((w) => (w.match(/[\p{L}\p{N}]/u)?.[0] ?? '').toUpperCase())
    .join('');
  return letters || '—';
}
