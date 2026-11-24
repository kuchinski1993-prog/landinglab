// Story 17.6d · Prontidão do Atendimento de uma loja ("Pronto para receber clientes?").
//
// SÓ LEITURA: nada é criado, alterado ou enviado. Cada item é uma função isolada com try/catch —
// falha de banco ou do Resend vira `unknown` naquele item; os demais continuam calculados e a rota
// nunca responde 5xx por causa de um item (AC2). A resposta nunca traz a chave do Resend nem dado
// de cliente (só contagens/estados).
//
// Itens, na ordem da Decisão 1 da story:
//   1 module_enabled           (efetivo em store_modules; não bloqueia — desligar só esconde o menu)
//   2 primary_address          (endereço principal em store_support_addresses)        — BLOQUEIA
//   3 domain_routes_to_worker  (manual: o Cloudflare não é consultado → sempre unknown) — avisa
//   4 config_complete          (regra da 17.6c, Decisão 5)                             — BLOQUEIA
//   5 refund_templates         (as 4 chaves de reembolso da loja em email_templates)   — BLOQUEIA
//   6 sender_domain_verified   (API de domínios do Resend, chave do cofre, 3 s)        — avisa
//   7 automation_mode          (informativo: recomendado modo observação no início)
//   8 first_inbound_received   (informativo: já chegou ao menos 1 e-mail real)
//   9 fail_safe_active         (informativo: a loja está protegida enquanto 4 não fechar)
import { emailTemplates, inboundAutomationConfig, inboundEmails, storeSupportAddresses, stores } from '@blackshop/db';
import { createHttpClient } from '@blackshop/shared/http';
import { resolveAtendimentoConfig, emailDomain, type EffectiveAtendimento } from '@blackshop/shared';
import { VaultService } from '@blackshop/vault';
import { and, eq, inArray, notLike, ne, sql } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import { ATENDIMENTO_CONFIG_LINK } from './atendimento-config.js';
import { REFUND_TEMPLATE_KEYS } from './atendimento-templates.js';
import { getModuleStates, type ExecDb } from './store-modules.repo.js';

type Db = FastifyInstance['db'];

export type ReadinessStatus = 'ok' | 'missing' | 'unknown';

export const READINESS_ITEM_IDS = [
  'module_enabled',
  'primary_address',
  'domain_routes_to_worker',
  'config_complete',
  'refund_templates',
  'sender_domain_verified',
  'automation_mode',
  'first_inbound_received',
  'fail_safe_active',
] as const;
export type ReadinessItemId = (typeof READINESS_ITEM_IDS)[number];

export interface ReadinessItem {
  id: ReadinessItemId;
  label: string;
  status: ReadinessStatus;
  blocking: boolean;
  hint: string;
  /** Tela do painel (ou guia) onde se resolve; `null` quando não há tela. */
  link: string | null;
}

export interface ReadinessReport {
  storeId: string;
  isDefault: boolean;
  /** Todos os itens bloqueantes estão `ok` (regra do botão "Ligar o Atendimento desta loja"). */
  ready: boolean;
  /** Estado efetivo do módulo `atendimento` (null = não deu para ler). */
  moduleEnabled: boolean | null;
  items: ReadinessItem[];
}

/** Mesmo slot do cofre lido por packages/email/src/provider.ts (`RESEND_VAULT_KEY`) — só leitura. */
export const RESEND_VAULT_KEY = 'resend:api_key';
export const RESEND_DOMAINS_URL = 'https://api.resend.com/domains?limit=100';
export const RESEND_TIMEOUT_MS = 3_000;

export const ATENDIMENTO_GUIDE = 'docs/guides/atendimento-por-loja.md';
export const AUTOMATION_LINK = '/trustshield/config/automation';
export const EMAIL_TEMPLATES_LINK = '/trustshield/email-templates';
export const INBOX_LINK = '/trustshield/inbox';

/**
 * Dependências externas trocáveis nos testes (`vi.spyOn(atendimentoReadinessDeps, ...)`).
 * `resolveResendKey` devolve `null` quando não há chave (ou o cofre falhou) — nunca joga.
 */
export const atendimentoReadinessDeps = {
  async resolveResendKey(db: Db, vaultSecret: string): Promise<string | null> {
    if (!vaultSecret) return null;
    try {
      return await new VaultService(db as never, vaultSecret).getRaw(RESEND_VAULT_KEY);
    } catch {
      // Cofre indisponível/sem a credencial: tratado como "sem chave" (item 6 = unknown, não bloqueia).
      return null;
    }
  },
  fetchImpl: undefined as typeof fetch | undefined,
};

export interface ReadinessContext {
  db: Db;
  storeId: string;
  vaultSecret: string;
  log?: Pick<FastifyBaseLogger, 'warn'>;
}

type ItemResult = Pick<ReadinessItem, 'status' | 'hint'> & { link?: string | null };

interface ItemDef {
  id: ReadinessItemId;
  label: string;
  blocking: boolean;
  link: string | null;
  unknownHint: string;
}

const ITEMS: Record<ReadinessItemId, ItemDef> = {
  module_enabled: {
    id: 'module_enabled',
    label: 'Módulo Atendimento ligado nesta loja',
    blocking: false,
    link: null,
    unknownHint: 'Não foi possível ler o estado do módulo. Desligado só esconde o menu: os e-mails continuam chegando.',
  },
  primary_address: {
    id: 'primary_address',
    label: 'Endereço de suporte principal cadastrado',
    blocking: true,
    link: `${ATENDIMENTO_CONFIG_LINK}#enderecos`,
    unknownHint: 'Não foi possível conferir os endereços de suporte agora. Clique em Atualizar.',
  },
  domain_routes_to_worker: {
    id: 'domain_routes_to_worker',
    label: 'Domínio encaminhando e-mails para a BlackShop (Cloudflare)',
    blocking: false,
    link: null,
    unknownHint: '',
  },
  config_complete: {
    id: 'config_complete',
    label: 'Configuração do Atendimento completa',
    blocking: true,
    link: ATENDIMENTO_CONFIG_LINK,
    unknownHint: 'Não foi possível ler a configuração agora. Clique em Atualizar.',
  },
  refund_templates: {
    id: 'refund_templates',
    label: 'Modelos de e-mail de reembolso criados',
    blocking: true,
    link: `${ATENDIMENTO_CONFIG_LINK}#modelos`,
    unknownHint: 'Não foi possível conferir os modelos de e-mail agora. Clique em Atualizar.',
  },
  sender_domain_verified: {
    id: 'sender_domain_verified',
    label: 'Domínio do remetente verificado no Resend',
    blocking: false,
    link: null,
    unknownHint: `Não foi possível consultar o Resend. Confira à mão no painel do Resend (Domains) que o domínio do remetente está "Verified" — passo a passo em ${ATENDIMENTO_GUIDE}.`,
  },
  automation_mode: {
    id: 'automation_mode',
    label: 'Modo das respostas automáticas',
    blocking: false,
    link: AUTOMATION_LINK,
    unknownHint: 'Não foi possível ler o modo da automação agora.',
  },
  first_inbound_received: {
    id: 'first_inbound_received',
    label: 'Primeiro e-mail real recebido',
    blocking: false,
    link: INBOX_LINK,
    unknownHint: 'Não foi possível conferir a caixa de entrada agora.',
  },
  fail_safe_active: {
    id: 'fail_safe_active',
    label: 'Proteção "não configurado não envia"',
    blocking: false,
    link: ATENDIMENTO_CONFIG_LINK,
    unknownHint: 'Não foi possível saber se a proteção está ativa (a configuração não pôde ser lida).',
  },
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Roda um item isolado: exceção vira `unknown` com a dica padrão do item (e um aviso no log, sem PII). */
async function runItem(
  ctx: ReadinessContext,
  id: ReadinessItemId,
  compute: () => Promise<ItemResult>,
): Promise<ReadinessItem> {
  const def = ITEMS[id];
  let result: ItemResult;
  try {
    result = await compute();
  } catch (err) {
    ctx.log?.warn({ storeId: ctx.storeId, item: id, err: errMessage(err) }, 'atendimento readiness item failed — unknown');
    result = { status: 'unknown', hint: def.unknownHint };
  }
  return {
    id,
    label: def.label,
    status: result.status,
    blocking: def.blocking,
    hint: result.hint,
    link: result.link !== undefined ? result.link : def.link,
  };
}

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : [];
}

// ── 1 · módulo ─────────────────────────────────────────────────────────────

async function moduleEnabledItem(ctx: ReadinessContext): Promise<{ item: ReadinessItem; enabled: boolean | null }> {
  let enabled: boolean | null = null;
  const item = await runItem(ctx, 'module_enabled', async () => {
    const states = await getModuleStates(ctx.db as unknown as ExecDb, ctx.storeId);
    const state = states?.find((s) => s.id === 'atendimento');
    if (!state) throw new Error('module state not found');
    enabled = state.enabled;
    return state.enabled
      ? { status: 'ok', hint: 'O menu do Atendimento aparece nesta loja. Loja nova já nasce com o módulo ligado.' }
      : {
          status: 'missing',
          hint: 'O módulo está desligado: o menu do Atendimento fica escondido, mas os e-mails continuam chegando e sendo gravados. Ligue quando os itens obrigatórios estiverem prontos.',
        };
  });
  return { item, enabled };
}

// ── 2 · endereço principal ────────────────────────────────────────────────

async function primaryAddressItem(ctx: ReadinessContext): Promise<ReadinessItem> {
  return runItem(ctx, 'primary_address', async () => {
    const rows = rowsOf<{ pattern: string; isPrimary: boolean }>(
      await ctx.db
        .select({ pattern: storeSupportAddresses.pattern, isPrimary: storeSupportAddresses.isPrimary })
        .from(storeSupportAddresses)
        .where(eq(storeSupportAddresses.storeId, ctx.storeId)),
    );
    const primary = rows.find((r) => r.isPrimary);
    if (primary) return { status: 'ok', hint: `E-mails para ${primary.pattern} chegam nesta loja.` };
    return {
      status: 'missing',
      hint:
        rows.length > 0
          ? 'Há endereços cadastrados, mas nenhum principal. Marque um endereço exato (nome@dominio) como principal.'
          : 'Cadastre o endereço de suporte da loja (ex.: suporte@dominio-da-loja). É por ele que o e-mail do cliente chega na loja certa.',
    };
  });
}

// ── 3 · roteamento do domínio (manual) ─────────────────────────────────────

async function domainRoutesItem(ctx: ReadinessContext): Promise<ReadinessItem> {
  return runItem(ctx, 'domain_routes_to_worker', async () => ({
    status: 'unknown',
    hint: `Conferência manual: no Cloudflare, Email → Email Routing do domínio da loja, a regra do endereço de suporte (ou o catch-all) precisa enviar para o Worker "blackshop-email-worker". A BlackShop não consulta o Cloudflare. Passo a passo em ${ATENDIMENTO_GUIDE}.`,
  }));
}

// ── 4 · configuração (+ base dos itens 6 e 9) ──────────────────────────────

async function loadEffective(ctx: ReadinessContext): Promise<EffectiveAtendimento> {
  const rows = rowsOf<{ settings: unknown; domain: string | null }>(
    await ctx.db
      .select({ settings: stores.settings, domain: stores.domain })
      .from(stores)
      .where(eq(stores.id, ctx.storeId))
      .limit(1),
  );
  // Leitura OK: settings corrompido vira "não configurado" (resolveAtendimentoConfig nunca joga).
  return resolveAtendimentoConfig(ctx.storeId, rows[0]?.settings ?? null, { storeDomain: rows[0]?.domain ?? null });
}

const REQUIRED_LABELS: Record<string, string> = {
  language: 'idioma',
  'brand.name': 'nome da marca',
  'brand.supportEmail': 'e-mail de suporte',
  'brand.postalAddress': 'endereço postal',
  'sender.fromAddress': 'e-mail do remetente',
};

function configCompleteItem(ctx: ReadinessContext, effective: EffectiveAtendimento | null): Promise<ReadinessItem> {
  return runItem(ctx, 'config_complete', async () => {
    if (!effective) throw new Error('config unavailable');
    if (effective.configured) {
      return {
        status: 'ok',
        hint: effective.isDefault
          ? 'Loja padrão: campos em branco usam os valores atuais da AuthenLondon.'
          : 'Idioma, marca, endereço postal e remetente preenchidos.',
      };
    }
    const missing = effective.missing.map((m) => REQUIRED_LABELS[m] ?? m).join(', ');
    return {
      status: 'missing',
      hint: `${effective.invalid ? 'A configuração gravada estava num formato inválido e foi ignorada. ' : ''}Falta: ${missing}.`,
    };
  });
}

// ── 5 · modelos de reembolso ──────────────────────────────────────────────

async function refundTemplatesItem(ctx: ReadinessContext): Promise<ReadinessItem> {
  return runItem(ctx, 'refund_templates', async () => {
    const rows = rowsOf<{ eventKey: string }>(
      await ctx.db
        .select({ eventKey: emailTemplates.eventKey })
        .from(emailTemplates)
        .where(and(eq(emailTemplates.storeId, ctx.storeId), inArray(emailTemplates.eventKey, [...REFUND_TEMPLATE_KEYS]))),
    );
    const have = new Set(rows.map((r) => r.eventKey));
    const absent = REFUND_TEMPLATE_KEYS.filter((k) => !have.has(k));
    if (absent.length === 0) return { status: 'ok', hint: 'Os 4 e-mails de reembolso desta loja existem.' };
    return {
      status: 'missing',
      hint: `Faltam ${absent.length} de 4 modelos (${absent.join(', ')}). Use "Criar modelos iniciais" nesta tela e revise os textos antes de liberar para clientes.`,
    };
  });
}

// ── 6 · domínio do remetente no Resend ────────────────────────────────────

interface ResendDomain {
  name: string;
  status: string;
}

function parseDomains(body: unknown): { domains: ResendDomain[]; hasMore: boolean } | null {
  const b = body as { data?: unknown; has_more?: unknown } | null;
  if (!b || !Array.isArray(b.data)) return null;
  const domains = (b.data as Array<Record<string, unknown>>)
    .filter((d) => d && typeof d['name'] === 'string')
    .map((d) => ({ name: String(d['name']).toLowerCase(), status: typeof d['status'] === 'string' ? String(d['status']) : '' }));
  return { domains, hasMore: b.has_more === true };
}

function senderDomainItem(ctx: ReadinessContext, effective: EffectiveAtendimento | null): Promise<ReadinessItem> {
  const def = ITEMS.sender_domain_verified;
  return runItem(ctx, 'sender_domain_verified', async () => {
    if (!effective) return { status: 'unknown', hint: def.unknownHint };
    const fromAddress = effective.sender?.fromAddress ?? null;
    if (!fromAddress) {
      return effective.isDefault
        ? { status: 'unknown', hint: 'A loja padrão usa o remetente geral da conta. Nada a conferir aqui.' }
        : { status: 'unknown', hint: 'Preencha o e-mail do remetente na configuração para conferir o domínio no Resend.', link: ATENDIMENTO_CONFIG_LINK };
    }
    const domain = emailDomain(fromAddress);
    if (!domain) return { status: 'unknown', hint: def.unknownHint };

    const apiKey = await atendimentoReadinessDeps.resolveResendKey(ctx.db, ctx.vaultSecret);
    if (!apiKey) {
      return {
        status: 'unknown',
        hint: `Sem chave do Resend no cofre para consultar. Confira à mão que ${domain} está "Verified" no Resend (Domains).`,
      };
    }

    const http = createHttpClient({
      label: 'resend-domains',
      timeoutMs: RESEND_TIMEOUT_MS,
      retry: { attempts: 1 },
      httpErrors: 'return',
      ...(atendimentoReadinessDeps.fetchImpl ? { fetchImpl: atendimentoReadinessDeps.fetchImpl } : {}),
    });
    let status: number;
    let body: unknown;
    try {
      const { response } = await http.request(RESEND_DOMAINS_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      });
      status = response.status;
      body = response.ok ? await response.json() : null;
    } catch (err) {
      // Timeout (3 s) / rede: nunca trava a rota nem vira 5xx.
      ctx.log?.warn({ storeId: ctx.storeId, item: 'sender_domain_verified', err: errMessage(err) }, 'resend domains lookup failed');
      return { status: 'unknown', hint: `O Resend não respondeu a tempo. ${def.unknownHint}` };
    }
    if (status === 401 || status === 403) {
      return {
        status: 'unknown',
        hint: `A chave do Resend não tem permissão para listar domínios (chave só de envio). Confira à mão que ${domain} está "Verified" e que a chave cobre todos os domínios das lojas.`,
      };
    }
    const parsed = status >= 200 && status < 300 ? parseDomains(body) : null;
    if (!parsed) return { status: 'unknown', hint: `O Resend respondeu de um jeito inesperado. ${def.unknownHint}` };
    const found = parsed.domains.find((d) => d.name === domain);
    if (!found) {
      if (parsed.hasMore) return { status: 'unknown', hint: `A conta do Resend tem muitos domínios para conferir aqui. Confira à mão que ${domain} está "Verified".` };
      return { status: 'missing', hint: `${domain} não está cadastrado no Resend. Adicione o domínio e os registros DNS (SPF/DKIM) — ${ATENDIMENTO_GUIDE}.` };
    }
    if (found.status === 'verified') return { status: 'ok', hint: `${domain} está verificado no Resend.` };
    return {
      status: 'missing',
      hint: `${domain} está cadastrado no Resend, mas ainda não verificado (estado: ${found.status || 'desconhecido'}). Confira os registros DNS e clique em Verify no Resend.`,
    };
  });
}

// ── 7 · modo da automação ─────────────────────────────────────────────────

async function automationModeItem(ctx: ReadinessContext): Promise<ReadinessItem> {
  return runItem(ctx, 'automation_mode', async () => {
    const rows = rowsOf<{ automationEnabled: boolean }>(
      await ctx.db
        .select({ automationEnabled: inboundAutomationConfig.automationEnabled })
        .from(inboundAutomationConfig)
        .where(eq(inboundAutomationConfig.storeId, ctx.storeId))
        .limit(1),
    );
    // Sem linha = padrão da tabela (desligado = modo observação).
    const on = rows[0]?.automationEnabled === true;
    return on
      ? {
          status: 'missing',
          hint: 'A IA está respondendo sozinha. Recomendado nos primeiros dias: modo observação (ela só sugere), até conferir as primeiras respostas.',
        }
      : { status: 'ok', hint: 'Modo observação: a IA só sugere respostas; você aprova. Recomendado nos primeiros dias.' };
  });
}

// ── 8 · primeiro e-mail real ──────────────────────────────────────────────

async function firstInboundItem(ctx: ReadinessContext): Promise<ReadinessItem> {
  return runItem(ctx, 'first_inbound_received', async () => {
    const rows = rowsOf<{ n: number }>(
      await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(inboundEmails)
        .where(
          and(
            eq(inboundEmails.storeId, ctx.storeId),
            ne(inboundEmails.status, 'auto_filtered'),
            notLike(inboundEmails.messageId, 'portal-%'),
          ),
        ),
    );
    const n = Number(rows[0]?.n ?? 0);
    return n > 0
      ? { status: 'ok', hint: n === 1 ? 'Já chegou 1 e-mail de cliente nesta loja.' : `Já chegaram ${n} e-mails de clientes nesta loja.` }
      : { status: 'missing', hint: 'Nenhum e-mail de cliente chegou ainda. Envie um teste de uma conta externa para o endereço de suporte.' };
  });
}

// ── 9 · fail-safe ─────────────────────────────────────────────────────────

function failSafeItem(ctx: ReadinessContext, effective: EffectiveAtendimento | null): Promise<ReadinessItem> {
  return runItem(ctx, 'fail_safe_active', async () => {
    if (!effective) throw new Error('config unavailable');
    if (effective.configured) {
      return { status: 'ok', hint: 'Configuração completa: a loja já pode enviar avisos, respostas e e-mails de reembolso ao cliente.' };
    }
    return {
      status: 'missing',
      hint: 'A loja está protegida: os e-mails chegam e são classificados, mas nada é enviado ao cliente até a configuração ficar completa.',
    };
  });
}

/** Calcula a prontidão da loja. Nunca joga (cada item vira `unknown` na falha). */
export async function computeAtendimentoReadiness(ctx: ReadinessContext): Promise<ReadinessReport> {
  let effective: EffectiveAtendimento | null = null;
  try {
    effective = await loadEffective(ctx);
  } catch (err) {
    ctx.log?.warn({ storeId: ctx.storeId, err: errMessage(err) }, 'atendimento readiness: config read failed — items unknown');
  }

  const [mod, primary, domainRoutes, config, templates, sender, automation, firstInbound, failSafe] = await Promise.all([
    moduleEnabledItem(ctx),
    primaryAddressItem(ctx),
    domainRoutesItem(ctx),
    configCompleteItem(ctx, effective),
    refundTemplatesItem(ctx),
    senderDomainItem(ctx, effective),
    automationModeItem(ctx),
    firstInboundItem(ctx),
    failSafeItem(ctx, effective),
  ]);
  const items = [mod.item, primary, domainRoutes, config, templates, sender, automation, firstInbound, failSafe];
  return {
    storeId: ctx.storeId,
    isDefault: effective?.isDefault ?? ctx.storeId === 'default',
    ready: items.every((i) => !i.blocking || i.status === 'ok'),
    moduleEnabled: mod.enabled,
    items,
  };
}
