'use server';

// Story 13.8 AC7/AC8 — Server Actions para Squad 5 (Deploy).
//
// Módulo separado de `src/lib/landing-actions.ts` (que continua sendo o dono
// dos CRUDs legados de landing_pages). Aqui vivem só as ações relacionadas
// ao ciclo de deployment que a story 13.8 introduz:
//
//   - publishLandingPage(landingPageId, deploymentType, customDomain?)
//       Cria row em landing_deployments (status='queued') + enfileira job
//       BullMQ 'landinglab.squad5.deploy'. Consumido pelo botão "Publicar"
//       do componente PublishActions.tsx.
//
//   - unpublishLandingPage(landingPageId)
//       Marca deployment ativo como 'unpublished', reseta
//       landing_pages.current_deployment_id + status='ready_for_review'.
//       NÃO remove DNS records (custo Spaceship + ausência de reversão
//       automática — ver Risk #3 da story).
//
//   - suggestDomains(landingPageId)
//       Consulta Spaceship (via @blackshop/landinglab-domains) por até 5
//       sugestões de domínio com base no nome/slug da landing. Retorna
//       lista pra alimentar DomainPurchaseModal.
//
//   - fetchDeploymentStatus(landingPageId)
//       Retorna estado atual do deployment mais recente + último run de
//       squad='deploy'. Alimenta polling do PublishActions.tsx.
//
// Não confundir com `landing-actions.ts` (que tem publish/unpublish legados
// de 1 arg — usados pelo LandingPageForm.tsx do CRUD manual). Aqui as
// assinaturas são diferentes e o comportamento é diferente (dispara Squad 5).

import { and, desc, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import {
  landingCopyDecks,
  landingDeployments,
  landingDomainBindings,
  landingDomains,
  landingGenerationRuns,
  landingPages,
} from '@blackshop/db';
import { createSpaceshipClient } from '@blackshop/landinglab-deploy';

import { enqueueJob } from '@/lib/api-queue';
import { getDb } from '@/lib/landing-db';
import { pickLiveHost, type LiveHost } from '@/lib/landing-live-host';
import type { LandingPublishCheckItem } from '@/lib/landing-publish-check';
import type { PublishCoreCode, PublishCoreInput, PublishOutcomeStatus } from '@/lib/publish-core';
import { requireSession } from '@/lib/session';

const SQUAD5_QUEUE_NAME = 'landinglab.squad5.deploy';
const SQUAD5_JOB_NAME = 'DeployLandingJob';
const ROOT_DOMAIN = 'landinglab.app';

// ─── Public types ─────────────────────────────────────────────────────────

export type DeploymentType = 'subdomain' | 'custom_domain';

export type DeploymentStatus =
  | 'queued'
  | 'provisioning'
  | 'awaiting_ssl'
  | 'published'
  | 'publish_failed'
  | 'unpublished';

export interface PublishLandingPageResult {
  /** `true` SOMENTE quando a landing está publicada com SSL comprovado (Story 0.6). */
  ok: boolean;
  /**
   * Códigos do publicador único (lib/publish-core.ts). Os 6 primeiros são os
   * históricos; os demais vêm da Story 0.6 (estado verdadeiro + modos de falha).
   */
  code?:
    | 'landing_not_found'
    | 'landing_not_ready'
    | 'invalid_input'
    | 'custom_domain_required'
    | 'enqueue_failed'
    | 'unknown'
    | Exclude<PublishCoreCode, 'landing_not_found' | 'landing_not_ready' | 'invalid_input'>;
  message?: string;
  /** Estado verdadeiro: published | awaiting_ssl | awaiting_dns | publish_failed | rejected. */
  status?: PublishOutcomeStatus;
  /** "Tentar de novo"/"Verificar novamente" pode resolver sem mudar nada. */
  retryable?: boolean;
  deploymentId?: string;
  jobId?: string;
  /** SSL comprovado (Vercel verificada + HTTPS respondeu). Só `true` quando publicada. */
  sslProvisioned?: boolean;
  hostname?: string;
  /** Checklist de checkout quando code='PUBLISH_CHECK_FAILED'. */
  checkItems?: LandingPublishCheckItem[];
  /** Registros DNS esperados quando code='DOMAIN_PENDING_DNS'. */
  dnsRecords?: unknown;
  /** Republicação de endereço já no ar com reverificação falhando (continua publicada). */
  warning?: { code: string; message: string };
  /** Landing dona do endereço quando code='SLUG_IN_USE'. */
  conflict?: { landingId: string; landingTitle: string | null; hostname: string };
}

export interface UnpublishLandingPageResult {
  ok: boolean;
  code?: 'no_active_deployment' | 'unknown';
  message?: string;
}

export interface DomainSuggestion {
  domain: string;
  available: boolean;
  price: number | null;
}

export interface SuggestDomainsResult {
  ok: boolean;
  suggestions: DomainSuggestion[];
  code?: 'no_landing' | 'spaceship_unavailable' | 'unknown';
  message?: string;
}

export interface DeploymentStatusView {
  deploymentId: string | null;
  deploymentType: DeploymentType | null;
  hostname: string | null;
  deploymentStatus: DeploymentStatus | null;
  sslStatus: 'pending' | 'provisioned' | 'failed' | null;
  publishedUrl: string | null;
  errorReason: string | null;
  /** Story 0.6 — código estável da última falha (ex.: VERCEL_TIMEOUT, SSL_PENDING). */
  errorCode: string | null;
  errorAgent: string | null;
  costUsd: string | null;
  runStatus: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | null;
  runStartedAt: string | null;
  runCompletedAt: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** RFC 1034 FQDN validator (subset). Rejects paths/schemes/wildcards. */
function isValidFqdn(domain: string): boolean {
  if (!domain || domain.length > 253) return false;
  return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain);
}

// Helper subdomainFor removido — substituído por languageAwareSlug (linha ~304)
// que retorna só o prefix (publish-core adiciona rootDomain).

// ─── publishLandingPage ────────────────────────────────────────────────────

/**
 * Story 13.8 AC7 — Cria row em landing_deployments + enfileira Squad 5.
 * Requer landing existente com html_body populado (Squad 4 concluído).
 * Aceita status='draft' ou 'ready_for_review' — 'ready_for_review' é
 * semântico (Squad 4 completo, aguardando publicação) mas o DB CHECK
 * constraint atual (migration 0045) permite apenas draft/published/archived.
 * Adoção literal do valor 'ready_for_review' depende de migration futura.
 */
export async function publishLandingPage(
  landingPageId: string,
  deploymentType: DeploymentType,
  customDomain?: string,
): Promise<PublishLandingPageResult> {
  // REFACTOR set/2026: elimina fluxo antigo baseado em worker Squad 5 (deadlock
  // verifier ↔ status='published'). Agora chama publishLandingCore direto —
  // atômico, sem worker, com binding + Vercel add-domain + status update.
  //
  // Squad 5 continua rodando pra recibos históricos mas NÃO É MAIS ENFILEIRADO
  // por esta função. Ver apps/backoffice/src/lib/publish-core.ts.
  //
  // Assinatura pública preservada (não quebra callers). jobId retornado como
  // undefined — sem worker, não há job.

  requireSession(`/landing-pages/${landingPageId}`);

  if (!landingPageId) {
    return { ok: false, code: 'invalid_input', message: 'landingPageId é obrigatório.' };
  }
  if (deploymentType !== 'subdomain' && deploymentType !== 'custom_domain') {
    return {
      ok: false,
      code: 'invalid_input',
      message: `deploymentType inválido: ${String(deploymentType)}`,
    };
  }
  if (deploymentType === 'custom_domain') {
    if (!customDomain || !isValidFqdn(customDomain)) {
      return {
        ok: false,
        code: 'custom_domain_required',
        message: 'customDomain deve ser um FQDN válido para custom_domain (ex.: whiteningpro.com).',
      };
    }
  }

  // Delega pra publish-core (fluxo A funcional). Precisa buscar slug + language
  // pra passar como subdomain slug se mode='subdomain'.
  const db = getDb();
  const [landing] = await db
    .select({
      slug: landingPages.slug,
      contentLanguage: landingPages.contentLanguage,
    })
    .from(landingPages)
    .where(eq(landingPages.id, landingPageId))
    .limit(1);
  if (!landing) {
    return { ok: false, code: 'landing_not_found', message: 'Landing page não encontrada.' };
  }

  const publishInput: PublishCoreInput =
    deploymentType === 'subdomain'
      ? {
          landingPageId,
          mode: 'subdomain',
          slug: languageAwareSlug(landing.slug, landing.contentLanguage),
          rootDomain: ROOT_DOMAIN,
          source: 'publish-action',
        }
      : {
          landingPageId,
          mode: 'custom_domain',
          customDomain: customDomain!,
          source: 'publish-action',
        };

  // Story 0.6: mesmo publicador da rota publish-on-domain (estado verdadeiro,
  // reserva transacional, Vercel com timeout, checklist, apply-bundle).
  const { publishLandingCore } = await import('@/lib/publish-core');
  const result = await publishLandingCore(publishInput);

  // Qualquer gravação (reserva, awaiting_ssl, published) muda o painel.
  if (result.deploymentId) {
    revalidatePath('/landing-pages');
    revalidatePath(`/landing-pages/${landingPageId}`);
  }

  return {
    ok: result.ok,
    ...(result.code ? { code: result.code } : {}),
    message: result.message,
    status: result.status,
    retryable: result.retryable,
    sslProvisioned: result.sslProvisioned,
    ...(result.deploymentId ? { deploymentId: result.deploymentId } : {}),
    ...(result.hostname ? { hostname: result.hostname } : {}),
    ...(result.details?.items ? { checkItems: result.details.items } : {}),
    ...(result.details?.dnsRecords !== undefined ? { dnsRecords: result.details.dnsRecords } : {}),
    ...(result.details?.conflict ? { conflict: result.details.conflict } : {}),
    ...(result.warning ? { warning: result.warning } : {}),
    // jobId undefined — sem worker (Squad 5 deprecated)
  };
}

/**
 * Combina slug + content_language pra formar sub-prefix único quando idiomas
 * múltiplos. EN base fica sem sufixo. Ex:
 *   ('vigorex', 'en') → 'vigorex'
 *   ('vigorex', 'it') → 'vigorex-it'
 */
function languageAwareSlug(slug: string, language: string | null): string {
  const lang = (language ?? 'en').toLowerCase();
  const base = slug.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  return lang === 'en' ? base : `${base}-${lang}`;
}

// ─── unpublishLandingPage ──────────────────────────────────────────────────

/**
 * Story 13.8 AC8 — Marca deployment ativo como 'unpublished', reseta
 * landing_pages.current_deployment_id + status='ready_for_review'.
 * NÃO remove DNS records (Risk #3 — Spaceship API paga por deleção).
 */
export async function unpublishLandingPage(
  landingPageId: string,
): Promise<UnpublishLandingPageResult> {
  requireSession(`/landing-pages/${landingPageId}`);

  if (!landingPageId) {
    return { ok: false, code: 'unknown', message: 'landingPageId é obrigatório.' };
  }
  const db = getDb();

  const [landing] = await db
    .select({ currentDeploymentId: landingPages.currentDeploymentId })
    .from(landingPages)
    .where(eq(landingPages.id, landingPageId))
    .limit(1);

  if (!landing || !landing.currentDeploymentId) {
    return {
      ok: false,
      code: 'no_active_deployment',
      message: 'Landing não tem deployment ativo para despublicar.',
    };
  }

  try {
    const now = new Date();
    await db
      .update(landingDeployments)
      .set({
        deploymentStatus: 'unpublished',
        unpublishedAt: now,
        updatedAt: now,
      })
      .where(eq(landingDeployments.id, landing.currentDeploymentId));

    // Reset status para 'draft' (constraint atual permite draft/published/archived).
    // Semanticamente representa 'pronto pra republicar' — html_body persiste.
    await db
      .update(landingPages)
      .set({
        currentDeploymentId: null,
        status: 'draft',
        updatedAt: now,
      })
      .where(eq(landingPages.id, landingPageId));

    revalidatePath('/landing-pages');
    revalidatePath(`/landing-pages/${landingPageId}`);
    return { ok: true };
  } catch (err) {
    console.error('[publish-actions] unpublishLandingPage failed', err);
    return {
      ok: false,
      code: 'unknown',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── suggestDomains ────────────────────────────────────────────────────────

/**
 * Story 13.8 AC9 — Consulta Spaceship por sugestões de domínio.
 * Deriva 5 candidatos a partir do slug + copy deck (brand name se existir).
 * Fallback resiliente: se Spaceship falhar, retorna candidatos com
 * `available=false` e `price=null` para o operador ver o que foi tentado.
 */
export async function suggestDomains(landingPageId: string): Promise<SuggestDomainsResult> {
  const db = getDb();

  const [landing] = await db
    .select({
      id: landingPages.id,
      slug: landingPages.slug,
      title: landingPages.title,
      contentLanguage: landingPages.contentLanguage,
    })
    .from(landingPages)
    .where(eq(landingPages.id, landingPageId))
    .limit(1);

  if (!landing) {
    return { ok: false, suggestions: [], code: 'no_landing', message: 'Landing não encontrada.' };
  }

  // Tenta enriquecer com brand.name do copy deck (Squad 2). Fallback pro slug.
  let brandHint = landing.slug;
  try {
    const [deck] = await db
      .select({ content: landingCopyDecks.content })
      .from(landingCopyDecks)
      .where(eq(landingCopyDecks.landingPageId, landingPageId))
      .orderBy(desc(landingCopyDecks.version))
      .limit(1);
    if (deck?.content && typeof deck.content === 'object') {
      const c = deck.content as { brand?: { name?: string } };
      if (typeof c.brand?.name === 'string' && c.brand.name.length > 0) {
        brandHint = c.brand.name;
      }
    }
  } catch {
    /* copy deck lookup best-effort — brandHint fallback já cobre */
  }

  const base = brandHint.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  const candidates = Array.from(
    new Set([
      `${base}.com`,
      `${base}pro.com`,
      `${base}shop.com`,
      `get${base}.com`,
      `${base}.store`,
    ]),
  ).slice(0, 5);

  const spaceship = createSpaceshipClient();
  const suggestions: DomainSuggestion[] = [];
  let anyError = false;
  for (const domain of candidates) {
    try {
      const result = await spaceship.checkAvailability(domain);
      suggestions.push({
        domain,
        available: result.available === true,
        price: typeof result.price === 'number' ? result.price : null,
      });
    } catch (err) {
      // Fail-soft: registra o domínio como indisponível pra UI mostrar
      // que foi tentado. Loga pro backend investigar.
      anyError = true;
      console.warn('[publish-actions] suggestDomains: spaceship check failed', {
        domain,
        err: err instanceof Error ? err.message : String(err),
      });
      suggestions.push({ domain, available: false, price: null });
    }
  }

  if (anyError && suggestions.every((s) => !s.available && s.price == null)) {
    return {
      ok: false,
      suggestions,
      code: 'spaceship_unavailable',
      message: 'Spaceship API indisponível — tente novamente em instantes.',
    };
  }

  return { ok: true, suggestions };
}

// ─── getLiveLandingHost (E2E Stripe B-1) ───────────────────────────────────

/**
 * Host em que a landing está no ar hoje (binding ativo — o que o storefront
 * resolve). Usado pelo "Republicar landing" de landings Stripe para republicar
 * no host real em vez do slug interno da landing (que pode ser o do clone).
 */
export async function getLiveLandingHost(landingPageId: string): Promise<LiveHost | null> {
  requireSession(`/landing-pages/${landingPageId}`);
  if (!landingPageId) return null;
  const db = getDb();
  const rows = await db
    .select({
      domainId: landingDomainBindings.domainId,
      domain: landingDomains.domain,
      slug: landingDomainBindings.slug,
      role: landingDomains.role,
      updatedAt: landingDomainBindings.updatedAt,
    })
    .from(landingDomainBindings)
    .innerJoin(landingDomains, eq(landingDomains.id, landingDomainBindings.domainId))
    .where(eq(landingDomainBindings.landingPageId, landingPageId));
  const [current] = await db
    .select({ hostname: landingDeployments.hostname })
    .from(landingPages)
    .innerJoin(landingDeployments, eq(landingDeployments.id, landingPages.currentDeploymentId))
    .where(eq(landingPages.id, landingPageId))
    .limit(1);
  return pickLiveHost(rows, current?.hostname ?? null);
}

// ─── fetchDeploymentStatus ─────────────────────────────────────────────────

/**
 * Story 13.8 AC6 — Consumido pelo polling do PublishActions.tsx.
 * Retorna estado consolidado do deployment mais recente + run de squad='deploy'.
 * Todos os campos nullable pra UI representar "ainda não iniciou".
 */
export async function fetchDeploymentStatus(
  landingPageId: string,
): Promise<DeploymentStatusView> {
  const db = getDb();

  const [deployment] = await db
    .select({
      id: landingDeployments.id,
      deploymentType: landingDeployments.deploymentType,
      hostname: landingDeployments.hostname,
      deploymentStatus: landingDeployments.deploymentStatus,
      sslStatus: landingDeployments.sslStatus,
      verificationUrl: landingDeployments.verificationUrl,
      deploymentMetadata: landingDeployments.deploymentMetadata,
      costUsd: landingDeployments.costUsd,
    })
    .from(landingDeployments)
    .where(eq(landingDeployments.landingPageId, landingPageId))
    .orderBy(desc(landingDeployments.createdAt))
    .limit(1);

  const [run] = await db
    .select({
      status: landingGenerationRuns.status,
      startedAt: landingGenerationRuns.startedAt,
      completedAt: landingGenerationRuns.completedAt,
    })
    .from(landingGenerationRuns)
    .where(
      and(
        eq(landingGenerationRuns.landingPageId, landingPageId),
        eq(landingGenerationRuns.squad, 'deploy'),
      ),
    )
    .orderBy(desc(landingGenerationRuns.createdAt))
    .limit(1);

  const metadata =
    deployment?.deploymentMetadata && typeof deployment.deploymentMetadata === 'object'
      ? (deployment.deploymentMetadata as {
          error_agent?: string | null;
          error_reason?: string | null;
          error_code?: string | null;
        })
      : null;

  return {
    deploymentId: deployment?.id ?? null,
    deploymentType: (deployment?.deploymentType as DeploymentType | undefined) ?? null,
    hostname: deployment?.hostname ?? null,
    deploymentStatus:
      (deployment?.deploymentStatus as DeploymentStatus | undefined) ?? null,
    sslStatus:
      (deployment?.sslStatus as 'pending' | 'provisioned' | 'failed' | undefined) ?? null,
    publishedUrl: deployment?.verificationUrl ?? null,
    errorReason: metadata?.error_reason ?? null,
    errorCode: metadata?.error_code ?? null,
    errorAgent: metadata?.error_agent ?? null,
    costUsd: deployment?.costUsd ?? null,
    runStatus:
      (run?.status as 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | undefined) ??
      null,
    runStartedAt: run?.startedAt ? run.startedAt.toISOString() : null,
    runCompletedAt: run?.completedAt ? run.completedAt.toISOString() : null,
  };
}

// ─── Internal: enqueue Squad 5 job ─────────────────────────────────────────

interface DeployJobPayload {
  landingPageId: string;
  deploymentId: string;
  deploymentType: DeploymentType;
  hostname: string;
  customDomain?: string;
}

async function enqueueDeployJob(payload: DeployJobPayload): Promise<string> {
  const jobId = `lp-deploy-${payload.deploymentId}`;
  await enqueueJob(SQUAD5_QUEUE_NAME, SQUAD5_JOB_NAME, { ...payload }, {
    jobId,
    // 1 attempt only: Squad 5 mutates external state (DNS records,
    // Spaceship purchase). BullMQ retry would double-charge. If job
    // fails, operator retries via UI "Tentar novamente" button.
    attempts: 1,
    removeOnComplete: { age: 7 * 24 * 3600, count: 500 },
    removeOnFail: { age: 30 * 24 * 3600 },
  });
  return jobId;
}

// ─── publishToExistingDomain (Fase 5.D — Task #29) ─────────────────────
// Novo fluxo M:N: em vez de comprar domínio novo pra cada landing, usuário
// escolhe um dos domínios que JÁ tem cadastrados (landing_domains) e sistema
// cria binding em landing_domain_bindings + dispara Squad 5.
//
// Diferenças vs publishLandingPage(custom_domain):
//   - NÃO chama Spaceship pra comprar (assume já foi comprado)
//   - Cria row em landing_domain_bindings pra permitir M:N (várias landings
//     no mesmo domínio)
//   - Aceita slug opcional (auto-gera do título se vazio) OU marca como root
//     do domínio (dominio.com/ sem slug)

export interface PublishToExistingDomainInput {
  landingPageId: string;
  domainId: string;
  slug?: string;
  isDefaultRoot?: boolean;
  /**
   * Fidelity gate override (2026-09-28). Quando true, permite publish mesmo
   * com clone_metadata.fidelity_blocked=true. Mesma semântica do
   * PublishCoreInput.overrideFidelityBlock — operator precisa revisar
   * clone_metadata.fidelity_findings antes de setar.
   */
  overrideFidelityBlock?: boolean;
}

export type PublishToExistingDomainResult =
  | {
      ok: true;
      deploymentId: string;
      jobId: string;
      bindingId: string;
      hostname: string;
    }
  | {
      ok: false;
      code:
        | 'landing_not_found'
        | 'landing_not_ready'
        | 'fidelity_blocked'
        | 'domain_not_found'
        | 'binding_conflict'
        | 'invalid_input'
        | 'enqueue_failed'
        | 'unknown';
      message: string;
      /** Só populado quando code='fidelity_blocked' — findings truncadas pro UI. */
      findings?: string[];
    };

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

async function autoGenerateSlug(
  db: ReturnType<typeof getDb>,
  domainId: string,
  landingTitle: string,
): Promise<string> {
  const base =
    landingTitle
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'landing';

  const existing = await db
    .select({ slug: landingDomainBindings.slug })
    .from(landingDomainBindings)
    .where(eq(landingDomainBindings.domainId, domainId));

  const taken = new Set(existing.map((e) => e.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * @deprecated Squad 5 path — ativo apenas no wizard legacy (ExistingDomainModal.tsx).
 * Novo path (editor V2): publishLandingCore em lib/publish-core.ts + PublishSection.tsx.
 * NÃO remover ainda: wizard legacy ainda referencia esta função via
 * ExistingDomainModal, LandingWizard, EditWorkspace, PublishActions.tsx,
 * wizard-v2/Step6Publish.tsx. Remover quando wizard legacy for aposentado
 * (tracked em backlog: Product Ops Block 4).
 */
export async function publishToExistingDomain(
  input: PublishToExistingDomainInput,
): Promise<PublishToExistingDomainResult> {
  requireSession(`/landing-pages/${input.landingPageId ?? ''}`);

  const { landingPageId, domainId } = input;
  if (!landingPageId || !domainId) {
    return {
      ok: false,
      code: 'invalid_input',
      message: 'landingPageId e domainId são obrigatórios.',
    };
  }

  const db = getDb();

  // 1. Valida landing (existe + status válido + html populado).
  const [landing] = await db
    .select({
      id: landingPages.id,
      title: landingPages.title,
      status: landingPages.status,
      htmlBody: landingPages.htmlBody,
      cloneMetadata: landingPages.cloneMetadata,
    })
    .from(landingPages)
    .where(eq(landingPages.id, landingPageId))
    .limit(1);
  if (!landing) {
    return { ok: false, code: 'landing_not_found', message: 'Landing não encontrada.' };
  }
  if (landing.status !== 'draft' && landing.status !== 'ready_for_review') {
    return {
      ok: false,
      code: 'landing_not_ready',
      message: `Landing precisa estar em 'draft' ou 'ready_for_review' (atual: '${landing.status}').`,
    };
  }
  if (!landing.htmlBody || landing.htmlBody.trim().length < 10) {
    return {
      ok: false,
      code: 'landing_not_ready',
      message: 'Landing precisa ter html_body populado.',
    };
  }

  // 1.5. Fidelity gate (2026-09-28) — mesma policy de publish-core e
  // publish-on-domain/route.ts. Bloqueia publish se cloner marcou BLOCKED
  // (browser-extension scripts, CSS missing, etc). Landings legacy sem
  // clone_metadata continuam liberadas. Operator override explícito via
  // input.overrideFidelityBlock=true após revisar findings.
  const cloneMeta = (landing.cloneMetadata ?? null) as {
    fidelity_blocked?: boolean;
    fidelity_verdict?: string | null;
    fidelity_findings?: string[];
  } | null;
  if (cloneMeta?.fidelity_blocked === true && !input.overrideFidelityBlock) {
    const findings = Array.isArray(cloneMeta.fidelity_findings)
      ? cloneMeta.fidelity_findings.slice(0, 3)
      : [];
    return {
      ok: false,
      code: 'fidelity_blocked',
      message: `Clone marcado FIDELITY_BLOCKED (${cloneMeta.fidelity_verdict ?? 'BLOCKED'}): ${
        findings.length > 0 ? findings.join('; ') : 'sem detalhes'
      }. Revise clone_metadata.fidelity_findings e re-clone, ou passe overrideFidelityBlock=true pra publicar mesmo assim.`,
      findings,
    };
  }

  // 2. Valida domínio (existe + role != blocked).
  const [domainRow] = await db
    .select({
      id: landingDomains.id,
      domain: landingDomains.domain,
      role: landingDomains.role,
    })
    .from(landingDomains)
    .where(eq(landingDomains.id, domainId))
    .limit(1);
  if (!domainRow) {
    return {
      ok: false,
      code: 'domain_not_found',
      message: 'Domínio não encontrado. Cadastre em /landing-pages/domains.',
    };
  }
  if (domainRow.role === 'blocked') {
    return {
      ok: false,
      code: 'domain_not_found',
      message: `Domínio ${domainRow.domain} está bloqueado. Escolha outro.`,
    };
  }

  // 3. Resolve slug (root ou custom ou auto-gerado).
  const isDefaultRoot = input.isDefaultRoot ?? false;
  let slug = (input.slug ?? '').trim();
  if (isDefaultRoot) {
    slug = ''; // Root = vazio.
  } else if (!slug) {
    slug = await autoGenerateSlug(db, domainId, landing.title);
  }
  if (slug && !SLUG_REGEX.test(slug)) {
    return {
      ok: false,
      code: 'invalid_input',
      message: 'Slug deve conter apenas letras minúsculas, números e hífens.',
    };
  }

  // 4. Cria binding (constraint unique domain+slug e default_root único por domain).
  let bindingId: string;
  try {
    const [inserted] = await db
      .insert(landingDomainBindings)
      .values({ domainId, landingPageId, slug, isDefaultRoot })
      .returning({ id: landingDomainBindings.id });
    if (!inserted) {
      return { ok: false, code: 'unknown', message: 'Falha ao criar vínculo.' };
    }
    bindingId = inserted.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('idx_landing_domain_bindings_default_root')) {
      return {
        ok: false,
        code: 'binding_conflict',
        message:
          'Já existe uma landing como página inicial deste domínio. Remova o vínculo anterior antes de definir esta como raiz.',
      };
    }
    if (message.includes('idx_landing_domain_bindings_domain_slug')) {
      return {
        ok: false,
        code: 'binding_conflict',
        message: `Slug "${slug}" já usado neste domínio. Escolha outro.`,
      };
    }
    console.error('[publish-actions] publishToExistingDomain binding error', err);
    return { ok: false, code: 'unknown', message: 'Erro ao criar vínculo.' };
  }

  // 5. Cria deployment row + enfileira job (mesmo padrão do custom_domain,
  //    mas deployment_type='custom_domain' porque Squad 5 já entende esse
  //    fluxo — a diferença é que agora existe binding no DB pro middleware
  //    do storefront resolver hostname+slug → landingPageId).
  //    hostname vai ser o próprio dominio (não slug) porque Squad 5
  //    configura DNS/SSL/Vercel domain no nível do domínio inteiro.
  //    O slug fica no binding, storefront resolve.
  const hostname = domainRow.domain;

  try {
    const now = new Date();
    const [inserted] = await db
      .insert(landingDeployments)
      .values({
        landingPageId,
        deploymentType: 'custom_domain',
        hostname,
        dnsProvider: 'spaceship', // ou o registrar cadastrado; simplifica pra Spaceship por default
        deploymentStatus: 'queued',
        costUsd: '0',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: landingDeployments.id });
    if (!inserted) {
      // Best effort: remove binding pra não deixar orphan.
      await db.delete(landingDomainBindings).where(eq(landingDomainBindings.id, bindingId));
      return { ok: false, code: 'unknown', message: 'Falha ao criar deployment.' };
    }
    const deploymentId = inserted.id;

    // Marca landing.current_deployment_id + status.
    await db
      .update(landingPages)
      .set({ currentDeploymentId: deploymentId, updatedAt: now })
      .where(eq(landingPages.id, landingPageId));

    const jobId = await enqueueDeployJob({
      landingPageId,
      deploymentId,
      deploymentType: 'custom_domain',
      hostname,
      customDomain: hostname,
    });

    revalidatePath('/landing-pages');
    revalidatePath(`/landing-pages/${landingPageId}`);
    revalidatePath('/landing-pages/domains');
    revalidatePath(`/landing-pages/domains/${domainId}`);

    return { ok: true, deploymentId, jobId, bindingId, hostname };
  } catch (err) {
    // Se falhou depois do binding, limpa o binding pra não ficar orfão.
    try {
      await db.delete(landingDomainBindings).where(eq(landingDomainBindings.id, bindingId));
    } catch {
      // silêncio — melhor esforço
    }
    console.error('[publish-actions] publishToExistingDomain deploy error', err);
    return { ok: false, code: 'enqueue_failed', message: 'Falha ao enfileirar deploy.' };
  }
}

// ─── listAvailableDomains — dropdown do PublishActions ────────────────
// Lista domínios ATIVOS/RESERVE (não bloqueados) pra selecionar no publish.
// Retorna com contagem de bindings pra usuário decidir se compartilha.

export async function listAvailableDomains(): Promise<
  Array<{
    id: string;
    domain: string;
    nickname: string | null;
    role: DeploymentStatus | string;
    landingsCount: number;
    hasDefaultRoot: boolean;
  }>
> {
  const db = getDb();
  const rows = await db
    .select({
      id: landingDomains.id,
      domain: landingDomains.domain,
      nickname: landingDomains.nickname,
      role: landingDomains.role,
      landingsCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${landingDomainBindings}
        WHERE ${landingDomainBindings.domainId} = ${landingDomains.id}
      )`,
      hasDefaultRoot: sql<boolean>`EXISTS (
        SELECT 1 FROM ${landingDomainBindings}
        WHERE ${landingDomainBindings.domainId} = ${landingDomains.id}
          AND ${landingDomainBindings.isDefaultRoot} = true
      )`,
    })
    .from(landingDomains)
    .where(sql`${landingDomains.role} != 'blocked' AND ${landingDomains.role} != 'disabled'`)
    .orderBy(desc(landingDomains.createdAt));

  return rows.map((r) => ({
    id: r.id,
    domain: r.domain,
    nickname: r.nickname,
    role: r.role,
    landingsCount: r.landingsCount ?? 0,
    hasDefaultRoot: r.hasDefaultRoot,
  }));
}
