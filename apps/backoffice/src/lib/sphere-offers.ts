// LandingLab → Ofertas (Story 16.1) — tipos do contrato /admin/offers e helpers de exibição.
// Valores monetários vêm como string numeric (ex.: "42.50") + moeda do programa; sem câmbio.

export const SPHERE_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

export type SphereOfferKind = 'vsl' | 'dtc';
export type SphereMaterialType = 'vsl' | 'file' | 'checkout';

export interface SphereOfferListItem {
  id: string;
  slug: string;
  title: string;
  niche: string | null;
  country: string | null;
  currency: string | null;
  refCode: string | null;
  commission: string | null;
  kind: SphereOfferKind;
  funnelCount: number;
  importedAt: string;
  updatedAt: string;
}

export interface SphereOfferListResponse {
  items: SphereOfferListItem[];
  total: number;
  page: number;
  pageSize: number;
  facets: { niches: string[]; countries: string[] };
}

export interface SphereOfferMaterial {
  id: string;
  type: SphereMaterialType;
  title: string | null;
  url: string;
  pots: 1 | 3 | 5 | null;
  fn: string | null;
  position: number;
  /** Story 16.2 — URL da página com ?ref (só vsl/file de página; null em checkout e Drive). Montada pela API. */
  pageUrl?: string | null;
  pageUrlWarning?: string | null;
  /** Link do Google Drive (vídeo/criativos): só exibido/copiável. */
  isDrive?: boolean;
}

export interface SphereOfferFunnel {
  id: string;
  externalId: string | null;
  name: string;
  commission: string | null;
  expectedCpa: string | null;
  avgPaidOrderRate: string | null;
  position: number;
  materials: SphereOfferMaterial[];
}

export interface SphereOfferDetail extends Omit<SphereOfferListItem, 'funnelCount'> {
  externalId: string | null;
  defaultLandingPageUrl: string | null;
  createdAt: string;
  funnels: SphereOfferFunnel[];
}

export interface SphereImportRejection {
  index: number;
  slug: string | null;
  path: string;
  reason: string;
}

export interface SphereImportReport {
  totals: { imported: number; updated: number; unchanged: number; rejected: number };
  imported: Array<{ slug: string; title: string }>;
  updated: Array<{ slug: string; title: string }>;
  unchanged: Array<{ slug: string; title: string }>;
  rejected: SphereImportRejection[];
}

export function kindLabel(kind: string): string {
  return kind === 'vsl' ? 'VSL' : kind === 'dtc' ? 'DTC' : kind;
}

export const MATERIAL_TYPE_LABELS: Record<SphereMaterialType, string> = {
  vsl: 'VSL',
  file: 'Arquivos',
  checkout: 'Checkouts',
};

/** "42.50" + "EUR" → "€ 42,50"; sem moeda válida → número formatado. */
export function formatMoney(value: string | null, currency: string | null): string {
  if (value === null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(n);
    } catch {
      // moeda desconhecida pelo Intl: cai no formato numérico
    }
  }
  return `${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ''}`;
}

/** Taxa média de pedidos pagos: 0..1 → percentual; acima de 1 assume que já veio em %. */
export function formatRate(value: string | null): string {
  if (value === null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const pct = n <= 1 ? n * 100 : n;
  return `${pct.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
}

export type PreValidation = { ok: true; data: unknown } | { ok: false; error: string };

/** Pré-validação no navegador: tamanho, JSON válido e estrutura mínima (o servidor valida tudo de novo). */
export function preValidateImportFile(text: string, sizeBytes: number): PreValidation {
  if (sizeBytes > SPHERE_IMPORT_MAX_BYTES) return { ok: false, error: 'Arquivo acima do limite de 5 MB.' };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'O arquivo não é um JSON válido.' };
  }
  const programs = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { programs?: unknown }).programs)
      ? (data as { programs: unknown[] }).programs
      : null;
  if (!programs) {
    return { ok: false, error: 'Formato inválido: esperado { "schemaVersion": 1, "programs": [...] } ou um array de programas.' };
  }
  if (programs.length === 0) return { ok: false, error: 'Arquivo sem programas.' };
  return { ok: true, data };
}

// ─── Story 16.2 — ações "Rodar no VSL Hosting" e "Clonar" ─────────────────────────────

export type PendingCtaReason = 'missing' | 'invalid_url' | 'no_selector' | 'import_failed' | 'import_pending' | 'config_rejected';

export interface RunVslResponse {
  projectId: string;
  pageUrl: string | null;
  importJobId: string | null;
  ctas: Array<{ id: string; pots: 1 | 3 | 5; url: string; selector: string }>;
  pendingCtas: Array<{ pots: 1 | 3 | 5; reason: PendingCtaReason }>;
  warnings: Array<{ code: string; message: string }>;
  driveLinks: Array<{ title: string | null; url: string }>;
  replayed: boolean;
}

export const PENDING_CTA_LABELS: Record<PendingCtaReason, string> = {
  missing: 'funil sem esse checkout',
  invalid_url: 'URL do checkout inválida (precisa ser https)',
  no_selector: 'nenhum botão sugerido na página para esse checkout',
  import_failed: 'página não importada',
  import_pending: 'importação da página ainda em andamento',
  config_rejected: 'configuração recusada pelo VSL Hosting',
};

export function potsLabel(pots: number): string {
  return `${pots} ${pots === 1 ? 'pote' : 'potes'}`;
}

/** Story 16.3 (AC 15-16) — resposta de `POST /admin/offers/:slug/apply-external-checkout`. */
export interface ApplyExternalCheckoutResponse {
  landingPageId: string;
  checkoutProvider: 'external';
  applied: Array<{ pots: number; url: string }>;
  pending: Array<{ pots: number; reason: 'missing' | 'invalid_url'; detail?: string }>;
}

export function applyExternalCheckoutPath(slug: string): string {
  return `/admin/offers/${encodeURIComponent(slug)}/apply-external-checkout`;
}

/** Kits pendentes em português (não bloqueiam: o operador completa no editor). */
export function externalPendingMessages(pending: ApplyExternalCheckoutResponse['pending']): string[] {
  return pending.map((p) => `${potsLabel(p.pots)}: ${p.detail ?? PENDING_CTA_LABELS[p.reason]}`);
}

/** Checkouts do funil por pote (1/3/5), exatamente como no catálogo (nunca com ?ref). */
export function funnelCheckouts(funnel: SphereOfferFunnel): SphereOfferMaterial[] {
  return funnel.materials
    .filter((m) => m.type === 'checkout')
    .sort((a, b) => (a.pots ?? 99) - (b.pots ?? 99) || a.position - b.position);
}

export function funnelVslMaterials(funnel: SphereOfferFunnel): SphereOfferMaterial[] {
  return funnel.materials.filter((m) => m.type === 'vsl').sort((a, b) => a.position - b.position);
}

/** Materiais `file` de página clonáveis: URL de página https montada pela API (Drive fica de fora). */
export function funnelClonableFiles(funnel: SphereOfferFunnel): SphereOfferMaterial[] {
  return funnel.materials
    .filter((m) => m.type === 'file' && !m.isDrive && typeof m.pageUrl === 'string' && m.pageUrl.startsWith('https://'))
    .sort((a, b) => a.position - b.position);
}

export function funnelDriveLinks(funnel: SphereOfferFunnel): SphereOfferMaterial[] {
  return funnel.materials.filter((m) => m.type === 'file' && m.isDrive === true);
}

/** Chave de idempotência por tentativa de clique (a mesma em reenvios da mesma tentativa). */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `run-${c.randomUUID()}`;
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
