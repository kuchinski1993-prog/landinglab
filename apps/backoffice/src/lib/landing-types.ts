// Tipos compartilhados entre server actions e componentes do form.
//
// Não é `use server` — pode ser importado em client components sem quebrar
// o boundary de server actions (que só aceita funções exportadas).

import { SUPPORTED_CURRENCIES } from '@blackshop/payments/markets';
import type { CheckoutProvider } from '@blackshop/shared/external-checkout';

// Story 15.2: lista única de moedas (antes recusava JPY e divergia das demais).
export const ALLOWED_CURRENCIES = SUPPORTED_CURRENCIES;
export type AllowedCurrency = (typeof ALLOWED_CURRENCIES)[number];

export const FULFILLMENT_TYPES = ['dropship', 'info_product', 'physical_own'] as const;
export type FulfillmentType = (typeof FULFILLMENT_TYPES)[number];

export const LANDING_STATUSES = ['draft', 'published', 'archived'] as const;
export type LandingStatus = (typeof LANDING_STATUSES)[number];

// Payload cru vindo do form — strings pra numeric, arrays já expandidos.
export interface LandingPageInput {
  title: string;
  slug: string;
  status: LandingStatus;
  currency: AllowedCurrency;
  fulfillmentType: FulfillmentType;
  htmlBody: string;
  price: string; // numeric — string pra evitar float precision
  customCss: string | null;
  compareAtPrice: string | null;
  mediaUrls: string[];
  videoUrls: string[];
  seoTitle: string | null;
  seoDescription: string | null;
  seoImage: string | null;
  manufacturer: string | null;
  productType: string | null;
  countryOfOrigin: string | null;
  tags: string[];
  disclaimerHtml: string | null;
  anvisaNotificationNumber: string | null;
  cofeprisRegistrationNumber: string | null;
  soldOutCounter: number;
}

// Row completa retornada por getLandingPage / getLandingPages.
// Numéricos ficam como string (retorno padrão do drizzle+postgres-js).
export interface LandingPageRow {
  id: string;
  storeId: string;
  slug: string;
  title: string;
  status: string;
  currency: string;
  fulfillmentType: string;
  htmlBody: string;
  customCss: string | null;
  mediaUrls: string[];
  videoUrls: string[];
  seoTitle: string | null;
  seoDescription: string | null;
  seoImage: string | null;
  manufacturer: string | null;
  productType: string | null;
  countryOfOrigin: string | null;
  tags: string[];
  price: string;
  compareAtPrice: string | null;
  soldOutCounter: number;
  disclaimerHtml: string | null;
  anvisaNotificationNumber: string | null;
  cofeprisRegistrationNumber: string | null;
  previewToken: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Autopilot fields (Story 13.3). Nullable pra rows manuais antigas.
  generationMode: 'manual' | 'autopilot' | 'cloned' | null;
  sourceType: 'aliexpress_link' | 'photo_upload' | 'other_url' | null;
  sourceUrl: string | null;
  sourceImageUrl: string | null;
  targetLanguage: 'de' | 'it' | 'en' | 'es' | 'fr' | null;
  // Story 13.4 AC17: array multi-idioma (EN + extras) usado pelo Squad 2 (Copy).
  // NULL em rows manuais ou landings pré-13.4. Squad 2 processor faz default.
  targetLanguages: Array<'de' | 'it' | 'en' | 'es' | 'fr'> | null;
  pirDocumentId: string | null;
  // Fase 5.A — Squad 0 Cloner. NULL em landings não-clonadas.
  clonedAt: string | null;
  cloneMetadata: Record<string, unknown> | null;
  // Migration 0062 — Wizard classification.
  // 'unknown' = default pra rows legadas ou recém-clonadas ainda não classificadas.
  landingKind: 'advertorial' | 'sales_page' | 'unknown';
  // FK opcional: advertorial → sua sales_page pai. Permite CTA "Continue lendo"
  // resolver URL da sales dinamicamente.
  parentSalesPageId: string | null;
  // Fase Q — brand swap: preenchidos via Wizard step "Marca & Idioma".
  // brandFrom aparece no clone origem (ex: "Cayenne Max"), brandTo é a marca
  // do dono (ex: "Vigorex"). Aplicado ANTES de tradução (texto+imagens).
  brandFrom: string | null;
  brandTo: string | null;
  // Fase R — descrição da demografia alvo pra Seedream adaptar rostos nas
  // imagens (ex: "Italian adults 40-55 years"). Preenchido opcionalmente no
  // Wizard. Se null/vazio, image-translator mantém rostos originais.
  targetDemographic: string | null;
  // Fase T (set/2026) — máquina de estado da tradução integrada ao clone.
  // Usado pela UI pra decidir se mostra barra de progresso e faz polling.
  translationStatus:
    | 'idle'
    | 'text_pending'
    | 'text_running'
    | 'images_pending'
    | 'images_running'
    | 'done'
    | 'done_with_warnings'
    | 'failed';
  translationProgress: Record<string, unknown>;
  initialTargetLanguage: string | null;
  initialTranslateImages: boolean;
  // Wizard V2 (migration 0065 — set/2026).
  wizardStep: WizardStep;
  wizardState: Record<string, unknown>;
  imageOcrMetadata: ImageOcrMetadataItem[] | null;
  displayCurrency: string | null;
  // Bundle Engine V2 flag (migration 0069). true = storefront lê landing_bundle_offers.
  // PriceSection usa pra mostrar banner contextual quando preço base está em 0.
  useNewBundleEngine: boolean;
  // GID Shopify do produto criado via publish-shopify (migration 0077).
  // null = produto nunca criado. Usado pra idempotência no retry.
  shopifyProductGid: string | null;
  // Story 15.2 (migration 0080) — mercado da landing (define a moeda) e
  // provider do checkout ('shopify' padrão | 'stripe' | 'external' — Story 16.3, migration 0110).
  marketId: string | null;
  checkoutProvider: CheckoutProvider;
}

/** Enum das etapas do Wizard V2 (compat com migration 0065 CHECK constraint). */
export type WizardStep =
  | 'branding'
  | 'images_selection'
  | 'progress'
  | 'pricing'
  | 'product'
  | 'publish'
  | 'done';

/** Item do image_ocr_metadata cache — populado no clone processor. */
export interface ImageOcrMetadataItem {
  url: string;
  hasText: boolean;
  hasBrandOrigin: boolean;
  wordCount: number;
  ocrTextPreview: string;
  ocrConfidence: number;
  bytes: number;
  error?: string;
  // IA Vision (Wizard V2 — filtragem inteligente).
  // isRelevant = true → imagem elegível pra rebrand/tradução
  // isRelevant = false → ícone/bandeira/badge/background (esconde no grid)
  isRelevant?: boolean;
  category?:
    | 'product'
    | 'hero'
    | 'copy'
    | 'testimonial'
    | 'lifestyle'
    | 'icon'
    | 'flag'
    | 'badge'
    | 'background'
    | 'unknown';
  relevanceConfidence?: number;
  relevanceReason?: string;
}

export interface ListLandingsFilters {
  status?: LandingStatus | 'all';
  q?: string;
  limit?: number;
  offset?: number;
}

export interface ListLandingsResult {
  items: LandingPageRow[];
  total: number;
}

// Squad de geração IA. Ordem = ordem de execução no pipeline.
export const AI_SQUADS = ['product_research', 'copy', 'visual', 'build_html', 'deploy'] as const;
export type AiSquad = (typeof AI_SQUADS)[number];
export type SquadStatus = 'idle' | 'running' | 'completed' | 'failed';

// Sumário enxuto de uma landing pra grid de cards (Fase 1 redesign).
// Traz só o essencial: identidade + hero thumb + progresso IA por squad.
// Evita puxar htmlBody (kilobytes) da lista.
export interface LandingPageSummary {
  id: string;
  slug: string;
  title: string;
  status: LandingStatus;
  currency: string;
  price: string;
  fulfillmentType: string;
  generationMode: 'manual' | 'autopilot' | 'cloned' | null;
  createdAt: string;
  updatedAt: string;
  // Hero thumbnail: URL da imagem hero desktop (visual_assets.assets.hero.urls_by_size.desktop).
  // null se Squad 3 ainda não rodou.
  heroImageUrl: string | null;
  // Progresso IA: status agregado de cada squad. 'idle' = nunca rodou; 'running'/'completed'/'failed' vem de landing_generation_runs.
  squadProgress: Record<AiSquad, SquadStatus>;
  // Última mensagem de erro (se algum squad falhou). Ajuda usuário a diagnosticar sem abrir landing.
  lastError: string | null;
  // URL pública da landing publicada (ex: 'https://vigoraxi.cubipiccanti.online').
  // NULL se ainda não foi publicada. Usado pelo botão "Ver landing" abrir o
  // domínio real ao invés do /preview interno.
  publishedUrl: string | null;
  // Story 20.10a: a landing já tem HTML (`html_body` não vazio)? Decide se o cartão da lista
  // mostra a prévia da página ou a imagem hero / placeholder.
  hasHtml: boolean;
  // JSONB `clone_metadata` completo — expõe `fidelity_verdict`, `fidelity_findings`,
  // `fidelity_blocked` persistidos em PR#144. Consumidor: marca de fidelidade do
  // cartão da lista (`landing-pages/_lib/landing-list.ts`). NULL em landings não-clonadas ou pré-fidelity-gate.
  // Read-only: nunca escrito a partir do backoffice.
  cloneMetadata: Record<string, unknown> | null;
}

export interface ListLandingsSummaryResult {
  items: LandingPageSummary[];
  total: number;
}

// Resultado tipado das mutations — evita jogar Error genérico no client.
// { ok: true, ... } vs { ok: false, code, message }.
export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: 'validation' | 'duplicate_slug' | 'unknown'; message: string };
