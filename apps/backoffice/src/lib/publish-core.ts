// publish-core — o ÚNICO publicador de landing em domínio (Story 0.6, AC8).
//
// Usado por:
//   - rota REST POST /api/landing-domains/publish-on-domain (PublishActions.tsx);
//   - server action publishLandingPage (PublishSection.tsx do editor);
//   - POST /api/landing-domains/publish-on-domain/verify ("Verificar novamente").
//
// Antes havia dois corpos com o mesmo defeito: gravavam `published` +
// `provisioned` ANTES de falar com a Vercel, sem timeout, sem transação,
// aceitavam domínio `pending_dns` como publicado e reapontavam em silêncio o
// binding de outra landing (playbook §13). Fluxo atual (Decisão 3 da story):
//
//   1. Validar: landing (loja l0i), HTML, fidelity gate, domínio (mesma loja),
//      slug livre (bindings E deployments), checklist de checkout (AC6).
//   2. Reservar (transação curta): deployment `provisioning`/`pending` +
//      binding inativo. Índice único = trava contra publicação simultânea.
//   3. Vercel add-domain com timeout (fora de transação).
//   4. Verificar: Vercel `verified` + sondagem HTTPS do hostname.
//   5. Finalizar (transação curta): `published`/`provisioned`, landing
//      `published`, current_deployment_id, binding ativo; apply-bundle.
//
// Falha em 3/4 deixa `publish_failed` ou `awaiting_ssl` — NUNCA `published`.
// Exceção (QA 0.6 F1): republicar um endereço que JÁ estava published com SSL
// não rebaixa nada — a tentativa vai para metadata e o conteúdo novo segue.
// `pending_dns` só publica com prova (Vercel verified + HTTPS) e então o
// domínio é promovido a `active` (QA 0.6 F2). Estados existentes no
// banco (0051) — sem migration.

import {
  blockingFailures,
  evaluatePublishCheck,
  type LandingPublishCheckItem,
} from './landing-publish-check';
import { enqueueApplyBundle } from './enqueue-apply-bundle';
import {
  addVercelDomain,
  probeHttps,
  VERCEL_TIMEOUT_MS,
  type HttpsProbeOutcome,
  type VercelDomainOutcome,
  type VercelErrorCode,
  type VercelVerificationRecord,
} from './publish-vercel';
import {
  createDrizzlePublishStore,
  isUniqueViolation,
  SlugTakenError,
  type HostOccupant,
  type PublishDomainRow,
  type PublishStore,
} from './publish-store';
import { normalizeSlug } from './slug-utils';

const DEFAULT_ROOT_DOMAIN = 'landinglab.app';
const PUBLISHABLE_ROLES = new Set(['active', 'pending_dns']);
const VERIFIABLE_STATUSES = new Set(['provisioning', 'awaiting_ssl', 'publish_failed', 'published']);

export interface PublishCoreInput {
  landingPageId: string;
  /**
   * Modo de publish:
   *   - 'subdomain': hostname = {slug}.{rootDomain}. Usa `domainId` (rota
   *     publish-on-domain) ou `rootDomain` ('landinglab.app' default).
   *   - 'custom_domain': hostname = customDomain FQDN completo.
   */
  mode: 'subdomain' | 'custom_domain';
  /** Só pra mode='subdomain': slug (parte antes do dot). Se vazio, deriva do landing.slug. */
  slug?: string;
  /** Só pra mode='subdomain': domínio raiz por nome. Default 'landinglab.app'. */
  rootDomain?: string;
  /** Só pra mode='subdomain': domínio raiz por id (landing_domains.id). Tem precedência. */
  domainId?: string;
  /** Só pra mode='custom_domain': FQDN completo (ex: 'minhaloja.com' ou 'blog.minhaloja.com'). */
  customDomain?: string;
  /**
   * Fidelity gate override (2026-09-28). Quando true, permite publish mesmo com
   * clone_metadata.fidelity_blocked=true. Default: false.
   */
  overrideFidelityBlock?: boolean;
  /** Quem chamou (log + apply-bundle). */
  source?: string;
}

/** Estado verdadeiro devolvido ao chamador. */
export type PublishOutcomeStatus =
  | 'published'
  | 'awaiting_ssl'
  | 'awaiting_dns'
  | 'publish_failed'
  /** Recusado na validação — nada foi gravado. */
  | 'rejected';

export type PublishCoreCode =
  | 'landing_not_found'
  | 'landing_not_ready'
  | 'fidelity_blocked'
  | 'invalid_input'
  | 'domain_not_configured'
  | 'domain_not_ready'
  | 'deployment_not_found'
  | 'deployment_not_verifiable'
  | 'SLUG_IN_USE'
  | 'PUBLISH_CHECK_FAILED'
  | 'DOMAIN_PENDING_DNS'
  | 'SSL_PENDING'
  | 'PUBLISH_RESERVE_FAILED'
  | 'PUBLISH_IN_PROGRESS'
  | 'PUBLISH_INTERNAL'
  | 'PUBLISH_FINALIZE_FAILED'
  | VercelErrorCode;

export interface PublishCoreResult {
  /** `true` SOMENTE quando a landing está publicada com SSL comprovado. */
  ok: boolean;
  status: PublishOutcomeStatus;
  httpStatus: number;
  code?: PublishCoreCode;
  /** Mensagem em pt-BR com a ação a tomar. */
  message: string;
  /** Repetir a mesma ação ("Tentar de novo"/"Verificar novamente") pode resolver. */
  retryable: boolean;
  hostname?: string;
  publishedUrl?: string;
  deploymentId?: string;
  domain?: string;
  slug?: string;
  sslProvisioned: boolean;
  applyBundleQueued?: boolean;
  /**
   * Republicação de endereço já no ar cuja reverificação falhou: a landing
   * continua publicada (estado anterior mantido) e o conteúdo novo foi enviado.
   */
  warning?: { code: PublishCoreCode; message: string };
  details?: {
    items?: LandingPublishCheckItem[];
    conflict?: { landingId: string; landingTitle: string | null; hostname: string };
    dnsRecords?: unknown;
    verification?: VercelVerificationRecord[];
    /** Onde resolver na UI (ex.: domínio aguardando DNS). */
    fixUrl?: string;
  };
}

export interface PublishCoreDeps {
  store: PublishStore;
  addDomain: (hostname: string) => Promise<VercelDomainOutcome>;
  probe: (hostname: string) => Promise<HttpsProbeOutcome>;
  enqueueApplyBundle: (landingPageId: string, source: string) => Promise<{ queued: boolean }>;
  now: () => Date;
  /** Em produção, token da Vercel ausente é falha; em dev vira `awaiting_ssl`. */
  isProduction: () => boolean;
  log: (event: string, data: Record<string, unknown>) => void;
}

function defaultDeps(): PublishCoreDeps {
  return {
    store: createDrizzlePublishStore(),
    addDomain: (hostname) => addVercelDomain(hostname),
    probe: (hostname) => probeHttps(hostname),
    enqueueApplyBundle: (landingPageId, source) => enqueueApplyBundle(landingPageId, source),
    now: () => new Date(),
    isProduction: () => process.env['NODE_ENV'] === 'production',
    log: (event, data) => {
      const line = JSON.stringify({ event, ...data });
      if (event.endsWith('_FAILED') || event.endsWith('.failed')) console.error(line);
      else console.warn(line);
    },
  };
}

function resolveDeps(overrides?: Partial<PublishCoreDeps>): PublishCoreDeps {
  return { ...defaultDeps(), ...(overrides ?? {}) };
}

/**
 * Extrai (subdomínio, rootDomain) de um FQDN.
 *   'blog.minhaloja.com' → { subPrefix: 'blog', rootDomain: 'minhaloja.com' }
 *   'minhaloja.com' → { subPrefix: '', rootDomain: 'minhaloja.com' }
 */
function parseFqdn(fqdn: string): { subPrefix: string; rootDomain: string } {
  const parts = fqdn.toLowerCase().split('.');
  if (parts.length <= 2) return { subPrefix: '', rootDomain: parts.join('.') };
  return { subPrefix: parts[0]!, rootDomain: parts.slice(1).join('.') };
}

function rejected(
  httpStatus: number,
  code: PublishCoreCode,
  message: string,
  extra: Partial<PublishCoreResult> = {},
): PublishCoreResult {
  return { ok: false, status: 'rejected', httpStatus, code, message, retryable: false, sslProvisioned: false, ...extra };
}

function conflictResult(occupant: HostOccupant | null, hostname: string): PublishCoreResult {
  const who = occupant?.landingTitle ? `pela landing "${occupant.landingTitle}"` : 'por outra landing';
  return rejected(
    409,
    'SLUG_IN_USE',
    `O endereço ${hostname} já é usado ${who}. Nada foi alterado nela. Escolha outro slug para esta landing.`,
    {
      hostname,
      ...(occupant
        ? { details: { conflict: { landingId: occupant.landingId, landingTitle: occupant.landingTitle, hostname } } }
        : {}),
    },
  );
}

function fidelityGate(cloneMetadata: unknown, override: boolean | undefined): PublishCoreResult | null {
  const meta = (cloneMetadata ?? null) as {
    fidelity_blocked?: boolean;
    fidelity_verdict?: string | null;
    fidelity_findings?: string[];
  } | null;
  if (meta?.fidelity_blocked !== true || override) return null;
  const findings = Array.isArray(meta.fidelity_findings)
    ? meta.fidelity_findings.slice(0, 3).join('; ')
    : 'sem detalhes';
  return rejected(
    400,
    'fidelity_blocked',
    `Clone marcado FIDELITY_BLOCKED (${meta.fidelity_verdict ?? 'BLOCKED'}): ${findings}. Revise clone_metadata.fidelity_findings e re-clone, ou passe overrideFidelityBlock=true pra publicar mesmo assim.`,
  );
}

const VERCEL_FAILURE_HTTP: Record<VercelErrorCode, number> = {
  VERCEL_TIMEOUT: 504,
  VERCEL_UNAVAILABLE: 503,
  VERCEL_TOKEN_MISSING: 503,
  VERCEL_TOKEN_INVALID: 502,
  VERCEL_PROJECT_NOT_ACCESSIBLE: 502,
  VERCEL_DOMAIN_CONFLICT: 409,
  VERCEL_DOMAIN_REJECTED: 422,
};

/** Frase de "não está no ar" — numa republicação, o que já estava no ar continua servindo. */
function notLiveText(wasLive: boolean): string {
  return wasLive
    ? 'A republicação NÃO foi concluída (o que já estava no ar continua no ar).'
    : 'A landing NÃO foi publicada.';
}

function vercelFailureMessage(code: VercelErrorCode, hostname: string, httpStatus?: number, wasLive = false): string {
  const notPublished = notLiveText(wasLive);
  switch (code) {
    case 'VERCEL_TIMEOUT':
      return `A Vercel não respondeu em ${VERCEL_TIMEOUT_MS / 1000}s. ${notPublished} Clique em "Verificar novamente": se a Vercel tiver aceitado o endereço, a publicação é concluída sem duplicar nada.`;
    case 'VERCEL_UNAVAILABLE':
      return `A Vercel está indisponível no momento${httpStatus ? ` (HTTP ${httpStatus})` : ''}. ${notPublished} Clique em "Tentar de novo" em alguns minutos.`;
    case 'VERCEL_TOKEN_MISSING':
      return `O token da Vercel (VERCEL_API_TOKEN) não está configurado no backoffice — sem ele o SSL de ${hostname} não é emitido. ${notPublished} Configure a variável no projeto do backoffice na Vercel e clique em "Tentar de novo".`;
    case 'VERCEL_TOKEN_INVALID':
      return `A Vercel recusou o token (revogado ou sem permissão). ${notPublished} Gere um token novo em vercel.com/account/tokens, atualize VERCEL_API_TOKEN e clique em "Tentar de novo" (playbook K12).`;
    case 'VERCEL_PROJECT_NOT_ACCESSIBLE':
      return `O projeto do storefront não foi encontrado na Vercel com este token. ${notPublished} Confira VERCEL_STOREFRONT_PROJECT_ID e VERCEL_TEAM_ID e clique em "Tentar de novo".`;
    case 'VERCEL_DOMAIN_CONFLICT':
      return `O endereço ${hostname} já está cadastrado em OUTRO projeto da Vercel. ${notPublished} Remova-o de lá (ou escolha outro slug) e clique em "Tentar de novo".`;
    case 'VERCEL_DOMAIN_REJECTED':
      return `A Vercel recusou o endereço ${hostname}${httpStatus ? ` (HTTP ${httpStatus})` : ''}. ${notPublished} Confira o slug e o domínio e tente de novo.`;
  }
}

interface CompletionContext {
  landingPageId: string;
  deploymentId: string;
  hostname: string;
  domain: PublishDomainRow;
  slug: string;
  source: string;
  /** A landing já estava publicada antes desta tentativa (republicação). */
  wasLive: boolean;
  /**
   * O próprio endereço já estava `published`/`provisioned` (republicação no
   * mesmo host). Falha na nova prova NÃO rebaixa o estado (QA 0.6 F1): só
   * registra a tentativa e o conteúdo novo segue (apply-bundle).
   */
  liveDeployment: boolean;
}

function baseOf(ctx: CompletionContext) {
  return {
    hostname: ctx.hostname,
    publishedUrl: `https://${ctx.hostname}`,
    deploymentId: ctx.deploymentId,
    domain: ctx.domain.domain,
    slug: ctx.slug,
  };
}

/** Caminho na UI para resolver DNS do domínio (QA 0.6 F2). */
export function domainFixUrl(domainId: string): string {
  return `/landing-pages/domains/${domainId}`;
}

/** Orientação extra quando o domínio ainda está `pending_dns`. */
function pendingDnsHint(ctx: CompletionContext): string {
  if (ctx.domain.role !== 'pending_dns') return '';
  return ` O domínio ${ctx.domain.domain} ainda está como "aguardando DNS": abra Landing pages › Domínios › ${ctx.domain.domain} (${domainFixUrl(ctx.domain.id)}), confira se os registros DNS mostrados lá estão no registrador e então clique em "Verificar novamente" aqui — quando a Vercel verificar e o HTTPS responder, o domínio passa a ativo sozinho.`;
}

const SHORT_REASON: Partial<Record<PublishCoreCode, string>> = {
  VERCEL_TIMEOUT: 'a Vercel não respondeu a tempo',
  VERCEL_UNAVAILABLE: 'a Vercel está indisponível',
  VERCEL_TOKEN_MISSING: 'o token da Vercel não está configurado',
  VERCEL_TOKEN_INVALID: 'a Vercel recusou o token',
  VERCEL_PROJECT_NOT_ACCESSIBLE: 'o projeto do storefront não foi encontrado na Vercel',
  VERCEL_DOMAIN_CONFLICT: 'o endereço está em outro projeto da Vercel',
  VERCEL_DOMAIN_REJECTED: 'a Vercel recusou o endereço',
  DOMAIN_PENDING_DNS: 'a Vercel ainda não verificou o DNS',
  SSL_PENDING: 'o HTTPS não respondeu na sondagem',
  PUBLISH_FINALIZE_FAILED: 'erro ao gravar a confirmação no banco',
};

/** Grava estado intermediário; se a gravação falhar, o estado fica `provisioning` (ainda honesto). */
async function markSafely(
  deps: PublishCoreDeps,
  ctx: CompletionContext,
  deploymentStatus: 'provisioning' | 'awaiting_ssl' | 'publish_failed',
  code: PublishCoreCode,
  message: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await deps.store.markDeployment(ctx.deploymentId, {
      deploymentStatus,
      sslStatus: 'pending',
      metadata: {
        error_code: code,
        error_reason: message,
        error_agent: 'publish-core',
        last_attempt_at: deps.now().toISOString(),
        ...extra,
      },
      now: deps.now(),
    });
  } catch (err) {
    deps.log('publish.mark_failed', {
      deployment_id: ctx.deploymentId,
      hostname: ctx.hostname,
      target_status: deploymentStatus,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function enqueueSafely(deps: PublishCoreDeps, ctx: CompletionContext): Promise<boolean> {
  try {
    return (await deps.enqueueApplyBundle(ctx.landingPageId, ctx.source)).queued;
  } catch {
    return false;
  }
}

/**
 * Falha de uma tentativa. Se o endereço já estava publicado (republicação no
 * mesmo host), o estado publicado é mantido: registra a tentativa em metadata,
 * enfileira o apply-bundle (o conteúdo novo vai ao ar) e responde 200 com aviso.
 * Senão, grava o estado intermediário honesto e devolve a falha.
 */
async function failAttempt(
  deps: PublishCoreDeps,
  ctx: CompletionContext,
  failure: PublishCoreResult,
  markStatus: 'provisioning' | 'awaiting_ssl' | 'publish_failed' | null,
  extra: Record<string, unknown> = {},
): Promise<PublishCoreResult> {
  const code = failure.code!;
  if (ctx.liveDeployment) {
    try {
      await deps.store.noteAttempt(
        ctx.deploymentId,
        {
          last_attempt_at: deps.now().toISOString(),
          last_attempt_error_code: code,
          last_attempt_error_reason: failure.message,
          ...extra,
        },
        deps.now(),
      );
    } catch (err) {
      deps.log('publish.note_attempt_failed', {
        deployment_id: ctx.deploymentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const applyBundleQueued = await enqueueSafely(deps, ctx);
    const reason = SHORT_REASON[code] ?? code;
    const warningMessage = `A reverificação de ${ctx.hostname} não passou (${reason}). O endereço continua com a publicação anterior; se ele abrir normalmente no navegador, pode ignorar — senão clique em "Verificar novamente".`;
    return {
      ok: true,
      status: 'published',
      httpStatus: 200,
      message: `Landing republicada: continua no ar em https://${ctx.hostname} e o conteúdo novo foi enviado. Atenção: ${warningMessage}`,
      retryable: false,
      sslProvisioned: true,
      applyBundleQueued,
      warning: { code, message: warningMessage },
      ...baseOf(ctx),
    };
  }
  if (markStatus) await markSafely(deps, ctx, markStatus, code, failure.message, extra);
  return failure;
}

/** Passos 3-5: Vercel → verificação → finalização. Compartilhado por publicar e "Verificar novamente". */
async function completePublication(deps: PublishCoreDeps, ctx: CompletionContext): Promise<PublishCoreResult> {
  const base = baseOf(ctx);
  const hint = pendingDnsHint(ctx);
  const fixDetails = ctx.domain.role === 'pending_dns' ? { fixUrl: domainFixUrl(ctx.domain.id) } : {};
  const vercel = await deps.addDomain(ctx.hostname);

  if (!vercel.ok) {
    if (vercel.code === 'VERCEL_TOKEN_MISSING' && !deps.isProduction()) {
      const message = `Ambiente de desenvolvimento sem VERCEL_API_TOKEN: o endereço ${ctx.hostname} foi reservado, mas o SSL não foi pedido à Vercel. ${notLiveText(ctx.wasLive)}`;
      return failAttempt(
        deps,
        ctx,
        {
          ok: false,
          status: 'awaiting_ssl',
          httpStatus: 202,
          code: 'VERCEL_TOKEN_MISSING',
          message,
          retryable: false,
          sslProvisioned: false,
          ...base,
        },
        'awaiting_ssl',
      );
    }
    const message = vercelFailureMessage(vercel.code, ctx.hostname, vercel.httpStatus, ctx.wasLive) + hint;
    deps.log('publish.vercel_failed', {
      code: vercel.code,
      hostname: ctx.hostname,
      deployment_id: ctx.deploymentId,
      http_status: vercel.httpStatus ?? null,
      detail: vercel.detail.slice(0, 300),
    });
    return failAttempt(
      deps,
      ctx,
      {
        ok: false,
        status: 'publish_failed',
        httpStatus: VERCEL_FAILURE_HTTP[vercel.code],
        code: vercel.code,
        message,
        retryable: vercel.retryable,
        sslProvisioned: false,
        ...base,
        ...(hint ? { details: { ...fixDetails } } : {}),
      },
      'publish_failed',
      { vercel_http_status: vercel.httpStatus ?? null },
    );
  }

  if (!vercel.verified) {
    const message =
      `A Vercel aceitou o endereço ${ctx.hostname}, mas ainda não conseguiu verificá-lo (DNS pendente). ${notLiveText(ctx.wasLive)}` +
      (hint || ' Confira os registros DNS abaixo e clique em "Verificar novamente".');
    return failAttempt(
      deps,
      ctx,
      {
        ok: false,
        status: 'awaiting_dns',
        httpStatus: 409,
        code: 'DOMAIN_PENDING_DNS',
        message,
        retryable: true,
        sslProvisioned: false,
        ...base,
        details: { verification: vercel.verification, dnsRecords: ctx.domain.dnsRecords ?? null, ...fixDetails },
      },
      'awaiting_ssl',
      { vercel_verification: vercel.verification },
    );
  }

  const probe = await deps.probe(ctx.hostname);
  if (!probe.ok) {
    const message =
      `A Vercel aceitou o endereço, mas o certificado SSL de ${ctx.hostname} ainda não responde. ${notLiveText(ctx.wasLive)} O painel tenta de novo sozinho por alguns minutos; se preferir, aguarde 1 a 2 minutos e clique em "Verificar novamente".` +
      hint;
    return failAttempt(
      deps,
      ctx,
      {
        ok: false,
        status: 'awaiting_ssl',
        httpStatus: 202,
        code: 'SSL_PENDING',
        message,
        retryable: true,
        sslProvisioned: false,
        ...base,
        ...(hint ? { details: { ...fixDetails } } : {}),
      },
      'awaiting_ssl',
      { https_probe: { reason: probe.reason, detail: probe.detail } },
    );
  }

  const now = deps.now();
  try {
    await deps.store.finalize({
      deploymentId: ctx.deploymentId,
      landingPageId: ctx.landingPageId,
      domainId: ctx.domain.id,
      slug: ctx.slug,
      publishedUrl: base.publishedUrl,
      metadata: {
        error_code: null,
        error_reason: null,
        error_agent: null,
        last_attempt_error_code: null,
        last_attempt_error_reason: null,
        verified_at: now.toISOString(),
        https_probe_status: probe.status,
      },
      now,
    });
  } catch (err) {
    deps.log('PUBLISH_FINALIZE_FAILED', {
      hostname: ctx.hostname,
      deployment_id: ctx.deploymentId,
      landing_page_id: ctx.landingPageId,
      error: err instanceof Error ? err.message : String(err),
    });
    return failAttempt(
      deps,
      ctx,
      {
        ok: false,
        status: 'publish_failed',
        httpStatus: 500,
        code: 'PUBLISH_FINALIZE_FAILED',
        message: `A Vercel aceitou ${ctx.hostname} e o HTTPS responde, mas houve erro ao gravar a publicação. A landing ainda não aparece como publicada — clique em "Verificar novamente" para concluir (não duplica nada).`,
        retryable: true,
        sslProvisioned: false,
        ...base,
      },
      // Sem gravação extra: o estado fica o da reserva (`provisioning`), honesto.
      null,
    );
  }

  // Domínio `pending_dns` comprovadamente no ar (Vercel verified + HTTPS) → ativo.
  let domainPromoted = false;
  if (ctx.domain.role === 'pending_dns') {
    try {
      await deps.store.promoteDomain(ctx.domain.id, now);
      domainPromoted = true;
    } catch (err) {
      deps.log('publish.promote_domain_failed', {
        domain_id: ctx.domain.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Re-enfileira apply-bundle: garante que o HTML servido tem todos os fixes
  // universais (accordions, PSS, moeda, pixel Meta, cards ligados às variantes).
  const applyBundleQueued = await enqueueSafely(deps, ctx);

  return {
    ok: true,
    status: 'published',
    httpStatus: 200,
    message:
      `Landing publicada em ${base.publishedUrl} (SSL ativo).` +
      (domainPromoted ? ` O domínio ${ctx.domain.domain} foi confirmado e passou a ativo.` : ''),
    retryable: false,
    sslProvisioned: true,
    applyBundleQueued,
    ...base,
  };
}

/**
 * Publica a landing num endereço. Só devolve `ok: true` (e só grava
 * `published`/`provisioned`) depois de a Vercel aceitar o domínio e o HTTPS
 * responder. Ver cabeçalho do arquivo para a ordem completa.
 */
export async function publishLandingCore(
  input: PublishCoreInput,
  overrides?: Partial<PublishCoreDeps>,
): Promise<PublishCoreResult> {
  const deps = resolveDeps(overrides);
  const { store } = deps;
  const source = input.source ?? 'publish-core';

  // 1a. Landing (mesma loja).
  const landing = await store.getLanding(input.landingPageId);
  if (!landing) return rejected(404, 'landing_not_found', 'Landing não encontrada.');
  if (!landing.htmlBody || landing.htmlBody.trim().length < 10) {
    return rejected(
      422,
      'landing_not_ready',
      'Landing sem HTML populado — clone/build precisa concluir antes de publicar.',
    );
  }

  // 1b. Fidelity gate (2026-09-28).
  const blocked = fidelityGate(landing.cloneMetadata, input.overrideFidelityBlock);
  if (blocked) return blocked;

  // 1c. Endereço.
  let subPrefix: string;
  let domain: PublishDomainRow | null;
  if (input.mode === 'subdomain') {
    const rawSlug = input.slug?.trim() || landing.slug;
    subPrefix = normalizeSlug(rawSlug);
    if (!subPrefix || subPrefix.length < 2) {
      return rejected(400, 'invalid_input', 'Slug inválido (mínimo 2 caracteres, apenas a-z 0-9 -).');
    }
    domain = input.domainId
      ? await store.getDomainById(input.domainId)
      : await store.getDomainByName((input.rootDomain ?? DEFAULT_ROOT_DOMAIN).toLowerCase());
  } else {
    if (!input.customDomain) {
      return rejected(400, 'invalid_input', 'customDomain obrigatório para mode=custom_domain.');
    }
    const parsed = parseFqdn(input.customDomain.trim());
    subPrefix = parsed.subPrefix;
    domain = await store.getDomainByName(parsed.rootDomain);
  }
  if (!domain) {
    return rejected(
      404,
      'domain_not_configured',
      'Domínio não encontrado nesta loja. Cadastre-o em Landing pages › Domínios antes de publicar.',
    );
  }
  if (!PUBLISHABLE_ROLES.has(domain.role)) {
    return rejected(
      409,
      'domain_not_ready',
      `O domínio ${domain.domain} não pode receber landings agora (situação: ${domain.role}). Escolha um domínio ativo.`,
    );
  }
  const hostname = subPrefix ? `${subPrefix}.${domain.domain}` : domain.domain;
  const publishedUrl = `https://${hostname}`;

  // 1d. Slug livre — bindings E deployments de OUTRA landing (AC5).
  const occupant = await store.findOccupant({
    hostname,
    domainId: domain.id,
    slug: subPrefix,
    landingPageId: landing.id,
  });
  if (occupant) return conflictResult(occupant, hostname);

  // 1e. Checklist de checkout (AC6) — antes de qualquer gravação.
  const snapshot = await store.loadCheckSnapshot(landing.id);
  if (!snapshot) return rejected(404, 'landing_not_found', 'Landing não encontrada.');
  const check = evaluatePublishCheck(snapshot);
  const failures = blockingFailures(check.items);
  if (failures.length > 0) {
    return rejected(
      422,
      'PUBLISH_CHECK_FAILED',
      `A landing ainda não está pronta para vender: ${failures.length} item(ns) bloqueante(s). ${failures[0]!.message} Corrija os itens da lista e publique de novo.`,
      { hostname, details: { items: check.items } },
    );
  }

  // 2. Reserva (transação curta).
  const now = deps.now();
  let deploymentId: string;
  let liveDeployment = false;
  try {
    const reserved = await store.reserve({
      landingPageId: landing.id,
      hostname,
      domainId: domain.id,
      slug: subPrefix,
      deploymentType: input.mode,
      dnsProvider: input.mode === 'custom_domain' ? 'spaceship' : 'porkbun',
      verificationUrl: publishedUrl,
      metadata: {
        publish_flow: 'publish-core-v2',
        source,
        domain_id: domain.id,
        root_domain: domain.domain,
        sub_prefix: subPrefix,
        reserved_at: now.toISOString(),
        error_code: null,
        error_reason: null,
      },
      now,
    });
    deploymentId = reserved.deploymentId;
    liveDeployment = reserved.wasPublished;
  } catch (err) {
    if (err instanceof SlugTakenError || isUniqueViolation(err)) {
      // Corrida: outra landing reservou o mesmo endereço entre a checagem e a reserva.
      const winner = await store
        .findOccupant({ hostname, domainId: domain.id, slug: subPrefix, landingPageId: landing.id })
        .catch(() => null);
      if (winner) return conflictResult(winner, hostname);
      // Ninguém de fora ocupa: é a MESMA landing publicando em paralelo (duplo
      // clique/duas abas) — QA 0.6 F7.
      return {
        ...rejected(
          409,
          'PUBLISH_IN_PROGRESS',
          `Já há uma publicação desta landing em andamento em ${hostname}. Aguarde alguns segundos e confira o status (ou clique em "Verificar novamente").`,
          { hostname },
        ),
        retryable: true,
      };
    }
    deps.log('PUBLISH_RESERVE_FAILED', {
      hostname,
      landing_page_id: landing.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ...rejected(
        500,
        'PUBLISH_RESERVE_FAILED',
        'Erro ao reservar o endereço no banco. Nada foi publicado — clique em "Tentar de novo".',
        { hostname },
      ),
      retryable: true,
    };
  }

  const ctx: CompletionContext = {
    landingPageId: landing.id,
    deploymentId,
    hostname,
    domain,
    slug: subPrefix,
    source,
    wasLive: landing.status === 'published',
    liveDeployment,
  };

  // 3-5. Domínio `pending_dns` também tenta (QA 0.6 F2): só vira publicada com
  // Vercel verified + HTTPS — e aí o domínio é promovido a ativo.
  return completePublication(deps, ctx);
}

export interface VerifyPublicationInput {
  deploymentId: string;
  source?: string;
}

/**
 * "Verificar novamente" (Decisão 8): reexecuta só Vercel → verificação →
 * finalização para um deployment existente. Idempotente — a Vercel responde
 * 409 "já existe" e isso é sucesso; reconcilia o resultado incerto de um
 * timeout e corrige deployments antigos marcados `published` sem prova.
 */
export async function verifyLandingPublication(
  input: VerifyPublicationInput,
  overrides?: Partial<PublishCoreDeps>,
): Promise<PublishCoreResult> {
  const deps = resolveDeps(overrides);
  const { store } = deps;

  const deployment = await store.getDeployment(input.deploymentId);
  if (!deployment) return rejected(404, 'deployment_not_found', 'Publicação não encontrada.');
  if (!VERIFIABLE_STATUSES.has(deployment.deploymentStatus)) {
    return rejected(
      409,
      'deployment_not_verifiable',
      `Esta publicação está "${deployment.deploymentStatus}" e não pode ser verificada. Publique de novo pelo formulário.`,
      { hostname: deployment.hostname, deploymentId: deployment.id },
    );
  }

  const meta = deployment.deploymentMetadata ?? {};
  const hostname = deployment.hostname.toLowerCase();
  const metaDomainId = typeof meta['domain_id'] === 'string' ? meta['domain_id'] : null;
  const metaRoot =
    typeof meta['root_domain'] === 'string'
      ? meta['root_domain']
      : typeof meta['wildcard_domain'] === 'string'
        ? meta['wildcard_domain']
        : null;
  let domain: PublishDomainRow | null = null;
  if (metaDomainId) domain = await store.getDomainById(metaDomainId);
  if (!domain && metaRoot) domain = await store.getDomainByName(metaRoot.toLowerCase());
  if (!domain) domain = await store.getDomainByName(hostname);
  if (!domain) domain = await store.getDomainByName(parseFqdn(hostname).rootDomain);
  if (!domain) {
    return rejected(404, 'domain_not_configured', 'O domínio desta publicação não está cadastrado nesta loja.', {
      hostname,
      deploymentId: deployment.id,
    });
  }
  const slug =
    hostname === domain.domain ? '' : hostname.endsWith(`.${domain.domain}`) ? hostname.slice(0, -(domain.domain.length + 1)) : '';

  const occupant = await store.findOccupant({
    hostname,
    domainId: domain.id,
    slug,
    landingPageId: deployment.landingPageId,
  });
  if (occupant) return conflictResult(occupant, hostname);

  const ctx: CompletionContext = {
    landingPageId: deployment.landingPageId,
    deploymentId: deployment.id,
    hostname,
    domain,
    slug,
    source: input.source ?? 'publish-verify',
    wasLive: deployment.deploymentStatus === 'published',
    liveDeployment: deployment.deploymentStatus === 'published' && deployment.sslStatus === 'provisioned',
  };

  if (!PUBLISHABLE_ROLES.has(domain.role)) {
    return rejected(
      409,
      'domain_not_ready',
      `O domínio ${domain.domain} não pode receber landings agora (situação: ${domain.role}).`,
      { hostname, deploymentId: deployment.id },
    );
  }

  return completePublication(deps, ctx);
}

/**
 * Reenvia o hostname para a Vercel (botão legado "Reprovisionar SSL").
 * Reaproveita o MESMO cliente da publicação (AC8). Não grava estado — o
 * "Verificar novamente" é quem confirma e grava `published`.
 */
export async function reprovisionSsl(
  hostname: string,
): Promise<{ ok: boolean; reason?: string; message: string }> {
  const result = await addVercelDomain(hostname);
  if (!result.ok) {
    return {
      ok: false,
      reason: result.code,
      message: vercelFailureMessage(result.code, hostname, result.httpStatus),
    };
  }
  return {
    ok: true,
    message: result.verified
      ? `A Vercel aceitou ${hostname}. Aguarde 30-60s e use "Verificar novamente" para confirmar o SSL.`
      : `A Vercel recebeu ${hostname}, mas o DNS ainda não foi verificado. Confira os registros DNS e use "Verificar novamente".`,
  };
}
