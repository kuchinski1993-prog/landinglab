// Checklist de publicação G3: usado pela UI (GET /vsl/projects/:id/publish-check) e pelo publish.
// Cada item tem `code` estável que identifica a verificação (o mesmo com ok=true ou false).
// `severity: 'blocking'` (ok=false impede o publish) | `'warning'` (avisos do runtime F2, nunca bloqueiam).
import type { Sql } from 'postgres';

import { effectiveSteps, type PublishProject, type PublishStep } from './draft-state.js';
import { vslError } from './errors.js';
import { validateFunnelGraph } from './funnels.js';
import {
  collectStepPublishWarnings, validateCheckoutConfig, validateCtaConfig, validateCtaTargets, validatePlayerConfig, validateTrackingConfig,
  type VslCtaConfig, type VslPublishWarningCode,
} from './funnel-config.js';
import { normalizeVslPathname } from './pathnames.js';
import type { Manifest, VslStorage } from './storage.js';
import { validateVideoPlacement, type VslVideoPlacement } from './video-placement.js';

export type PublishCheckCode =
  | 'domain_selected' | 'domain_verified' | 'domain_not_landinglab' | 'domain_legacy_free'
  | 'has_steps' | 'funnel_valid' | 'paths_available' | 'stream_configured'
  | 'step_content' | 'step_video_ready' | 'step_video_placement' | 'step_player' | 'step_checkout' | 'step_tracking' | 'step_cta'
  | VslPublishWarningCode;

export type PublishCheckSeverity = 'blocking' | 'warning';

export interface PublishCheckItem {
  code: PublishCheckCode;
  ok: boolean;
  severity: PublishCheckSeverity;
  message: string;
  fixHint?: string;
  stepId?: string;
  stepName?: string;
  ctaId?: string;
  selector?: string;
}
export interface PublishCheckResult { projectId: string; ready: boolean; items: PublishCheckItem[] }

/** Itens que impedem o publish (`ready=false`, `publish_check_failed.details.items`). Avisos nunca entram. */
export const blockingPublishItems = (items: PublishCheckItem[]) => items.filter((item) => !item.ok && item.severity === 'blocking');

const isEmpty = (value: unknown) => !value || typeof value !== 'object' || !Object.keys(value as object).length;

export interface PublishCheckOptions { env?: NodeJS.ProcessEnv }

export async function runPublishCheck(sql: Sql, storage: VslStorage, projectId: string, options: PublishCheckOptions = {}): Promise<PublishCheckResult & { project: PublishProject; steps: PublishStep[]; rawSteps: PublishStep[]; hostname: string | null }> {
  const env = options.env ?? process.env;
  const [project] = await sql<PublishProject[]>`SELECT * FROM vsl_projects WHERE id=${projectId} AND store_id='l0i'`;
  if (!project) throw vslError('project_not_found');
  if (project.status === 'archived') throw vslError('project_not_editable');
  const items: PublishCheckItem[] = [];
  const add = (code: PublishCheckCode, ok: boolean, message: string, fixHint?: string, step?: PublishStep) =>
    items.push({ code, ok, severity: 'blocking', message, ...(ok || !fixHint ? {} : { fixHint }), ...(step ? { stepId: step.id, stepName: step.name } : {}) });
  const warn = (step: PublishStep, warning: ReturnType<typeof collectStepPublishWarnings>[number]) =>
    items.push({ code: warning.code, ok: false, severity: 'warning', message: warning.message, fixHint: WARNING_HINTS[warning.code],
      stepId: step.id, stepName: step.name, ...(warning.ctaId ? { ctaId: warning.ctaId } : {}), ...(warning.selector ? { selector: warning.selector } : {}) });

  // Domínio
  let hostname: string | null = null;
  const [domain] = project.domain_id
    ? await sql`SELECT id,hostname,dns_status,ssl_status,lifecycle_status FROM blackshop_domains WHERE id=${project.domain_id}` : [];
  add('domain_selected', Boolean(domain && domain.lifecycle_status !== 'archived'),
    domain && domain.lifecycle_status !== 'archived' ? `Domínio ${domain.hostname} selecionado.` : 'Nenhum domínio selecionado.',
    'Escolha um domínio na aba Domínio do projeto.');
  if (domain && domain.lifecycle_status !== 'archived') {
    hostname = String(domain.hostname);
    const verified = domain.dns_status === 'verified' && domain.ssl_status === 'provisioned' && domain.lifecycle_status === 'active';
    add('domain_verified', verified, verified ? 'DNS e SSL do domínio verificados.' : 'O domínio ainda não foi verificado (DNS/SSL).',
      'Configure o DNS conforme as instruções e clique em "Verificar agora" na tela de Domínios.');
    const [landing] = await sql`SELECT id FROM landing_domains WHERE lower(domain)=lower(${hostname}) LIMIT 1`;
    add('domain_not_landinglab', !landing, landing ? 'Este domínio é usado pelo LandingLab.' : 'Domínio exclusivo do VSL.',
      'Use outro domínio ou subdomínio para o VSL.');
    const [legacy] = await sql`SELECT id FROM vsl_domain_bindings WHERE domain_id=${domain.id} AND publication_status='published' LIMIT 1`;
    if (legacy) add('domain_legacy_free', false, 'O domínio ainda serve uma página VSL antiga.', 'Despublique a página antiga antes de usar o funil.');
  }

  // Etapas
  const rawSteps = await sql<PublishStep[]>`SELECT * FROM vsl_steps WHERE project_id=${projectId} AND status<>'archived' ORDER BY position`;
  const steps = effectiveSteps(project, rawSteps);
  add('has_steps', steps.length > 0, steps.length ? `${steps.length} etapa(s) no funil.` : 'O funil não tem etapas.', 'Adicione pelo menos uma etapa.');
  let graphOk = true;
  try { validateFunnelGraph(steps.map((step) => ({ id: step.id, pathname: step.pathname, nextStepId: step.next_step_id }))); }
  catch { graphOk = false; }
  if (steps.length) add('funnel_valid', graphOk, graphOk ? 'Sequência de etapas válida.' : 'A sequência de etapas tem ciclo ou caminho repetido.',
    'Revise o "segue para" e os caminhos das etapas.');

  if (domain && steps.length) {
    const taken: string[] = [];
    const owners = new Map<string, string[]>();
    for (const step of steps) {
      let pathname: string;
      try { pathname = normalizeVslPathname(step.pathname); } catch { continue; }
      const [route] = await sql`SELECT r.project_id, p.name FROM vsl_public_routes r JOIN vsl_projects p ON p.id = r.project_id
        WHERE r.domain_id=${domain.id} AND r.pathname=${pathname} AND r.publication_status='published' AND r.project_id<>${projectId}`;
      const [legacy] = await sql`SELECT id FROM vsl_domain_bindings WHERE domain_id=${domain.id} AND normalized_pathname=${pathname} AND publication_status='published' LIMIT 1`;
      if (route || legacy) {
        taken.push(pathname);
        const owner = route ? `"${String(route['name'])}"` : 'uma página do editor antigo';
        owners.set(owner, [...(owners.get(owner) ?? []), pathname]);
      }
    }
    const who = [...owners.entries()].map(([owner, paths]) => `${paths.join(', ')} (${owner})`).join('; ');
    add('paths_available', !taken.length, taken.length ? `Caminho(s) já publicado(s) neste domínio por outro projeto: ${who}.` : 'Caminhos livres no domínio.',
      taken.length ? `Despublique ${[...owners.keys()].join(' e ')} ou mude o caminho dessas etapas.` : 'Mude o caminho das etapas em conflito ou despublique o outro projeto.');
  }

  if (steps.some((step) => step.video_asset_id)) {
    const configured = Boolean(env['VSL_STREAM_ACCOUNT_ID'] && env['VSL_STREAM_API_TOKEN']);
    add('stream_configured', configured, configured ? 'Cloudflare Stream configurado.' : 'Cloudflare Stream não está configurado no servidor.',
      'Configure VSL_STREAM_ACCOUNT_ID e VSL_STREAM_API_TOKEN na API.');
  }

  for (const step of steps) await checkStep(sql, storage, step, add, warn);
  return { projectId, ready: !blockingPublishItems(items).length, items, project, steps, rawSteps, hostname };
}

const WARNING_HINTS: Record<VslPublishWarningCode, string> = {
  CTA_SELECTOR_DYNAMIC: 'Se o botão é criado por JavaScript (quiz/SPA), pode publicar. Senão, marque o botão de novo no editor da etapa.',
  CTA_TIMED_WITHOUT_VIDEO: 'Adicione um vídeo à etapa ou defina o CTA para aparecer imediatamente (0 s).',
};

async function checkStep(sql: Sql, storage: VslStorage, step: PublishStep,
  add: (code: PublishCheckCode, ok: boolean, message: string, fixHint: string | undefined, step: PublishStep) => void,
  warn: (step: PublishStep, warning: ReturnType<typeof collectStepPublishWarnings>[number]) => void) {
  let checkout: ReturnType<typeof validateCheckoutConfig> = null;
  let checkoutOk = true;
  try { checkout = validateCheckoutConfig(step.checkout_config); } catch { checkoutOk = false; }
  if (!checkoutOk || step.render_mode === 'REDIRECT' || checkout)
    add('step_checkout', checkoutOk && (step.render_mode !== 'REDIRECT' || Boolean(checkout)),
      !checkoutOk ? 'URL de checkout inválida (precisa ser HTTPS).' : step.render_mode === 'REDIRECT' && !checkout ? 'Etapa de redirecionamento sem URL de checkout.' : 'Checkout válido.',
      'Informe uma URL HTTPS de checkout no projeto ou na etapa.', step);
  try { validateTrackingConfig(step.tracking_config); }
  catch { add('step_tracking', false, 'Configuração de pixels inválida.', 'Revise os IDs de Meta/Google/TikTok.', step); }

  // Conteúdo da etapa
  let html: string | null = null;
  if (step.render_mode === 'IMPORTED_PAGE') {
    if (!step.page_revision_id) add('step_content', false, 'Etapa sem página.', 'Escolha uma página importada para a etapa.', step);
    else {
      const [page] = await sql`SELECT r.manifest,r.storage_prefix,r.status FROM vsl_page_revisions r JOIN vsl_pages p ON p.id=r.page_id
        WHERE r.id=${step.page_revision_id} AND p.store_id='l0i'`;
      let ok = Boolean(page && page.status === 'ready');
      if (ok) {
        try {
          ok = await storage.isSealed(String(page!.storage_prefix), page!.manifest as Manifest);
          if (ok) html = (await storage.read(`${page!.storage_prefix}/${(page!.manifest as Manifest).entryPath}`)).toString('utf8');
        } catch { ok = false; }
      }
      add('step_content', ok, ok ? 'Página pronta.' : 'A página desta etapa está indisponível.', 'Reimporte a página ou escolha outra versão.', step);
    }
  } else if (step.render_mode === 'NATIVE_VIDEO') {
    add('step_content', Boolean(step.video_asset_id), step.video_asset_id ? 'Vídeo definido.' : 'Etapa de vídeo sem vídeo.', 'Escolha um vídeo da biblioteca.', step);
  } else if (step.render_mode === 'REDIRECT') {
    add('step_content', Boolean(checkout), checkout ? 'Redirecionamento configurado.' : 'Redirecionamento sem destino.', 'Informe a URL de checkout.', step);
  }

  // Vídeo
  if (step.video_asset_id) {
    const [video] = await sql`SELECT status FROM vsl_video_assets WHERE id=${step.video_asset_id} AND store_id='l0i'`;
    const ready = video?.status === 'ready';
    add('step_video_ready', ready, ready ? 'Vídeo pronto.' : video?.status === 'failed' ? 'O vídeo falhou no processamento.' : 'O vídeo ainda está processando.',
      video?.status === 'failed' ? 'Envie o vídeo novamente.' : 'Aguarde o processamento do vídeo terminar.', step);
    const placement = step.video_placement as { strategy?: unknown; selector?: unknown } | null;
    let placementOk = true;
    if (step.render_mode === 'NATIVE_VIDEO') placementOk = !placement?.strategy || placement.strategy === 'DEDICATED';
    else if (!placement || !['PLACEHOLDER', 'SELECTOR'].includes(String(placement.strategy)) ||
      (placement.strategy === 'SELECTOR' && (typeof placement.selector !== 'string' || !placement.selector.trim()))) placementOk = false;
    else if (html !== null) {
      try { validateVideoPlacement(html, step.video_placement as VslVideoPlacement); } catch { placementOk = false; }
    }
    add('step_video_placement', placementOk, placementOk ? 'Posição do vídeo definida.' : 'Não está definido onde o vídeo aparece na página.',
      'No editor da etapa, use "clique para escolher" e marque onde vai o vídeo.', step);
  }

  // Player (F2: `video_placement.player`, validação estrita — o runtime cairia nos defaults em silêncio).
  const player = (step.video_placement as { player?: unknown } | null)?.player;
  if (player !== undefined && player !== null) {
    let playerOk = true;
    try { validatePlayerConfig(player); } catch { playerOk = false; }
    add('step_player', playerOk, playerOk ? 'Configuração do player válida.' : 'Configuração do player inválida.',
      'Revise as opções do player (cores #RRGGBB, proporção, idioma, textos e capa HTTPS).', step);
  }

  // CTA
  if (!isEmpty(step.cta_config)) {
    let cta: VslCtaConfig | null = null;
    try { cta = validateCtaConfig(step.cta_config, Boolean(step.next_step_id), Boolean(checkout)); } catch { /* inválido */ }
    // Seletor ausente do HTML estático NÃO bloqueia (CTA dinâmico, aviso abaixo); só seletor que não dá para interpretar.
    let targetsOk = Boolean(cta);
    if (cta && html !== null) {
      try { validateCtaTargets(html, cta); } catch { targetsOk = false; }
    }
    add('step_cta', Boolean(cta) && targetsOk, !cta ? 'Configuração do CTA inválida (destino ausente ou seletor inválido).' : !targetsOk ? 'Um seletor do CTA não pôde ser interpretado.' : 'CTA válido.',
      !cta ? 'Revise a ação do CTA (próxima etapa, checkout ou URL).' : 'Marque novamente o botão do CTA no editor da etapa.', step);
    if (cta && targetsOk)
      for (const warning of collectStepPublishWarnings({ ctaConfig: cta, html, hasVideo: Boolean(step.video_asset_id) })) warn(step, warning);
  }
}
