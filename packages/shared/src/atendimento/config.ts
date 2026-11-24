// Story 17.6c · Configuração do Atendimento por loja (`stores.settings.atendimento`, jsonb, sem migration).
//
// Regra central (Decisões 2 e 5 da story):
//   - loja `default` (AuthenLondon): cada campo ausente cai no literal de HOJE — sem config, o
//     resultado é byte a byte o comportamento anterior (`usesDefaultLiterals = true`, nenhum
//     contexto de prompt, nenhum `from`/`replyTo` no job);
//   - loja ≠ `default`: NADA herda o literal da AuthenLondon. Ausente = "não configurado"; sem os
//     campos obrigatórios a loja não envia nada ao cliente (fail-safe — quem chama confere
//     `configured`). Config corrompida = "não configurado" (outras lojas) / padrão (default).
//
// Módulo puro (sem I/O). Não importa @blackshop/trustshield: o contexto de prompt é montado aqui com o
// mesmo formato estrutural de `AtendimentoPromptContext` (packages/trustshield/src/types.ts).
import { z } from 'zod';

export const DEFAULT_ATENDIMENTO_STORE_ID = 'default';

export const ATENDIMENTO_LANGUAGES = ['en-GB', 'pt-BR'] as const;
export type AtendimentoLanguage = (typeof ATENDIMENTO_LANGUAGES)[number];

export const ATENDIMENTO_TONES = ['default', 'formal', 'friendly'] as const;
export type AtendimentoTone = (typeof ATENDIMENTO_TONES)[number];

/** Chaves de `POLICY_FACTS` (packages/trustshield/src/policy-knowledge.ts) — mesmas strings. */
export const POLICY_FACT_KEYS = [
  'return_window',
  'return_process_no_pickup',
  'refund_timing',
  'faulty_items',
  'not_eligible_items',
  'shipping_processing',
  'shipping_delivery',
  'shipping_tracking',
  'ack_sla',
  'statutory_rights',
  'privacy_summary',
  'size_recommendations_process',
] as const;
export type PolicyFactKey = (typeof POLICY_FACT_KEYS)[number];

/** Campos obrigatórios para a loja ≠ `default` enviar algo ao cliente (Decisão 5). */
export const ATENDIMENTO_REQUIRED_FIELDS = [
  'language',
  'brand.name',
  'brand.supportEmail',
  'brand.postalAddress',
  'sender.fromAddress',
] as const;
export type AtendimentoRequiredField = (typeof ATENDIMENTO_REQUIRED_FIELDS)[number];

/** Literais de hoje da AuthenLondon (extraídos de analyze-inbound.processor.ts e inbound-response-guard.ts). */
export const DEFAULT_ATENDIMENTO_LITERALS = {
  language: 'en-GB' as AtendimentoLanguage,
  tone: 'default' as AtendimentoTone,
  brand: {
    name: 'AuthenLondon',
    supportEmail: 'support@authenlondon.com',
    postalAddress: '35 Weir Rd, London SW12 0NU, United Kingdom',
  },
  allowedLinkHosts: ['authenlondon.com', 'blackshop-storefront.vercel.app'] as readonly string[],
} as const;

/** Janela de SLA do ack por idioma (en-GB = literal de hoje). */
export const ACK_SLA_WINDOW: Readonly<Record<AtendimentoLanguage, string>> = {
  'en-GB': '1 business day',
  'pt-BR': '1 dia útil',
};

/** Mercado/país mostrado ao modelo no lugar de "(UK)" — derivado do idioma (v1). */
export const ATENDIMENTO_MARKET: Readonly<Record<AtendimentoLanguage, string>> = {
  'en-GB': 'UK',
  'pt-BR': 'Brazil',
};

/** Tem caractere de controle (exceto os permitidos)? */
function hasControlChar(v: string, allowed: readonly number[] = []): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if ((c < 32 || c === 127) && !allowed.includes(c)) return true;
  }
  return false;
}

// Texto de uma linha sem caracteres de controle nem os que quebram cabeçalho de e-mail.
const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !hasControlChar(v) && !/[<>"]/.test(v), { message: 'invalid_characters' });

// Texto com quebras de linha (\n, \r) permitidas; demais controles proibidos.
const multiLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !hasControlChar(v, [10, 13]), { message: 'invalid_characters' });

const emailField = z.string().trim().toLowerCase().max(254).email();

// Só o host (sem esquema, caminho, porta ou credenciais).
const hostField = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/, {
    message: 'host_only',
  });

export const AtendimentoConfigSchema = z
  .object({
    language: z.enum(ATENDIMENTO_LANGUAGES).optional(),
    tone: z.enum(ATENDIMENTO_TONES).optional(),
    toneNotes: multiLine(400).optional(),
    brand: z
      .object({
        name: singleLine(120).optional(),
        supportEmail: emailField.optional(),
        postalAddress: singleLine(300).optional(),
      })
      .strict()
      .optional(),
    sender: z
      .object({
        fromName: singleLine(120).optional(),
        fromAddress: emailField.optional(),
        replyTo: emailField.optional(),
      })
      .strict()
      .optional(),
    signature: multiLine(300).optional(),
    refundPolicy: z
      .object({
        facts: z.record(z.enum(POLICY_FACT_KEYS), multiLine(1200)),
      })
      .strict()
      .optional(),
    allowedLinkHosts: z.array(hostField).max(20).optional(),
  })
  .strict();

export type AtendimentoConfig = z.infer<typeof AtendimentoConfigSchema>;

export interface EffectiveAtendimento {
  storeId: string;
  isDefault: boolean;
  /** `default` sempre true; outras lojas só com todos os ATENDIMENTO_REQUIRED_FIELDS. */
  configured: boolean;
  missing: AtendimentoRequiredField[];
  /** `settings.atendimento` existia mas não passou na validação (tratado como ausente). */
  invalid: boolean;
  /** true = loja `default` sem nenhum campo diferente do literal de hoje (caminho literal). */
  usesDefaultLiterals: boolean;
  language: AtendimentoLanguage | null;
  tone: AtendimentoTone;
  toneNotes: string | null;
  brand: { name: string | null; supportEmail: string | null; postalAddress: string | null };
  sender: { fromName: string | null; fromAddress: string; replyTo: string | null } | null;
  signature: string | null;
  refundPolicyFacts: Partial<Record<PolicyFactKey, string>>;
  allowedLinkHosts: string[];
}

/** Formato estrutural de `AtendimentoPromptContext` (packages/trustshield/src/types.ts). */
export interface AtendimentoPromptContextShape {
  brandName: string;
  market: string;
  language: AtendimentoLanguage;
  tone: AtendimentoTone;
  toneNotes: string | null;
  signature: string | null;
  policyFacts: Readonly<Record<string, string>>;
  inheritDefaultPolicy: boolean;
}

export interface ResolveAtendimentoOptions {
  /** `stores.domain` — host permitido em links da loja ≠ default sem `allowedLinkHosts`. */
  storeDomain?: string | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Lê e valida `settings.atendimento`. Ausente → `{}`; formato inválido → `{}` + `invalid: true`. */
export function parseAtendimentoSettings(settings: unknown): { config: AtendimentoConfig; invalid: boolean } {
  const root = asRecord(settings);
  const raw = root ? root['atendimento'] : undefined;
  if (raw === undefined || raw === null) return { config: {}, invalid: false };
  const parsed = AtendimentoConfigSchema.safeParse(raw);
  if (!parsed.success) return { config: {}, invalid: true };
  return { config: parsed.data, invalid: false };
}

function isAuthenLondonHost(host: string): boolean {
  return host === 'authenlondon.com' || host.endsWith('.authenlondon.com');
}

function normalizeDomain(domain: string | null | undefined): string | null {
  if (!domain) return null;
  const host = domain.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0] ?? '';
  return hostField.safeParse(host).success ? host : null;
}

/**
 * Config EFETIVA da loja. `settings` = `stores.settings` inteiro (ou `null` quando a leitura
 * falhou — o fail-safe é o mesmo: `default` → literais; outras → "não configurado").
 */
export function resolveAtendimentoConfig(
  storeId: string,
  settings: unknown,
  options: ResolveAtendimentoOptions = {},
): EffectiveAtendimento {
  const isDefault = storeId === DEFAULT_ATENDIMENTO_STORE_ID;
  const { config, invalid } = parseAtendimentoSettings(settings);
  const L = DEFAULT_ATENDIMENTO_LITERALS;

  if (isDefault) {
    const facts = { ...(config.refundPolicy?.facts ?? {}) };
    const hosts = config.allowedLinkHosts ?? [...L.allowedLinkHosts];
    const sender = config.sender?.fromAddress
      ? { fromName: config.sender.fromName ?? null, fromAddress: config.sender.fromAddress, replyTo: config.sender.replyTo ?? null }
      : null;
    const effective: EffectiveAtendimento = {
      storeId,
      isDefault,
      configured: true,
      missing: [],
      invalid,
      usesDefaultLiterals: false,
      language: config.language ?? L.language,
      tone: config.tone ?? L.tone,
      toneNotes: config.toneNotes ?? null,
      brand: {
        name: config.brand?.name ?? L.brand.name,
        supportEmail: config.brand?.supportEmail ?? L.brand.supportEmail,
        postalAddress: config.brand?.postalAddress ?? L.brand.postalAddress,
      },
      sender,
      signature: config.signature ?? null,
      refundPolicyFacts: facts,
      allowedLinkHosts: hosts,
    };
    effective.usesDefaultLiterals =
      effective.language === L.language &&
      effective.tone === L.tone &&
      effective.toneNotes === null &&
      effective.brand.name === L.brand.name &&
      effective.brand.supportEmail === L.brand.supportEmail &&
      effective.brand.postalAddress === L.brand.postalAddress &&
      effective.sender === null &&
      effective.signature === null &&
      Object.keys(facts).length === 0 &&
      hosts.length === L.allowedLinkHosts.length &&
      hosts.every((h, i) => h === L.allowedLinkHosts[i]);
    return effective;
  }

  const root = asRecord(settings);
  const contactAddress =
    root && typeof root['contactAddress'] === 'string' && root['contactAddress'].trim().length > 0
      ? root['contactAddress'].trim()
      : null;
  const brand = {
    name: config.brand?.name ?? null,
    supportEmail: config.brand?.supportEmail ?? null,
    postalAddress: config.brand?.postalAddress ?? contactAddress,
  };
  const sender = config.sender?.fromAddress
    ? { fromName: config.sender.fromName ?? null, fromAddress: config.sender.fromAddress, replyTo: config.sender.replyTo ?? null }
    : null;
  const storeDomain = normalizeDomain(options.storeDomain);
  const hosts = (config.allowedLinkHosts ?? (storeDomain ? [storeDomain] : [])).filter((h) => !isAuthenLondonHost(h));

  const missing: AtendimentoRequiredField[] = [];
  if (!config.language) missing.push('language');
  if (!brand.name) missing.push('brand.name');
  if (!brand.supportEmail) missing.push('brand.supportEmail');
  if (!brand.postalAddress) missing.push('brand.postalAddress');
  if (!sender) missing.push('sender.fromAddress');

  return {
    storeId,
    isDefault,
    configured: missing.length === 0,
    missing,
    invalid,
    usesDefaultLiterals: false,
    language: config.language ?? null,
    tone: config.tone ?? 'default',
    toneNotes: config.toneNotes ?? null,
    brand,
    sender,
    signature: config.signature ?? null,
    refundPolicyFacts: { ...(config.refundPolicy?.facts ?? {}) },
    allowedLinkHosts: hosts,
  };
}

/**
 * Contexto para os prompts do TrustShield. `undefined` no caminho literal da `default` (prompt =
 * string de hoje) e para loja não configurada (quem chama não deve gerar nada ao cliente).
 * `brandNameFallback` só é usado para rascunho interno de loja ≠ default sem marca configurada.
 */
export function buildAtendimentoPromptContext(
  effective: EffectiveAtendimento,
  brandNameFallback?: string,
): AtendimentoPromptContextShape | undefined {
  if (effective.usesDefaultLiterals) return undefined;
  const language = effective.language ?? DEFAULT_ATENDIMENTO_LITERALS.language;
  const brandName = effective.brand.name ?? brandNameFallback ?? effective.storeId;
  return {
    brandName,
    market: ATENDIMENTO_MARKET[language],
    language,
    tone: effective.tone,
    toneNotes: effective.toneNotes,
    signature: effective.signature,
    policyFacts: { ...effective.refundPolicyFacts },
    inheritDefaultPolicy: effective.isDefault,
  };
}

/**
 * Campos de remetente para o job do `email-queue` (`send-email` já os repassa ao provider).
 * Sem `sender` → `{}` (nenhuma chave nova no payload — golden da `default`).
 */
export function atendimentoSendFields(effective: EffectiveAtendimento): { from?: string; replyTo?: string } {
  if (!effective.sender) return {};
  const { fromName, fromAddress, replyTo } = effective.sender;
  return {
    from: fromName ? `${fromName} <${fromAddress}>` : fromAddress,
    ...(replyTo ? { replyTo } : {}),
  };
}

/** Domínio de um endereço (`nome@dominio` → `dominio`), minúsculo. */
export function emailDomain(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 0) return null;
  const d = address.slice(at + 1).trim().toLowerCase();
  return d.length > 0 ? d : null;
}

export type AtendimentoMergeResult =
  | { ok: true; config: AtendimentoConfig }
  | { ok: false; field: string; reason: string };

const OBJECT_KEYS = new Set(['brand', 'sender', 'refundPolicy']);

/**
 * Merge parcial do PUT: chaves ausentes ficam como estão; `null` remove a chave; `brand`, `sender`
 * e `refundPolicy.facts` fazem merge campo a campo. O resultado é validado inteiro.
 */
export function mergeAtendimentoPatch(current: AtendimentoConfig, patch: unknown): AtendimentoMergeResult {
  const p = asRecord(patch);
  if (!p) return { ok: false, field: '(body)', reason: 'body_must_be_object' };
  const next: Record<string, unknown> = { ...(current as Record<string, unknown>) };
  for (const [key, value] of Object.entries(p)) {
    if (value === null) {
      delete next[key];
      continue;
    }
    if (OBJECT_KEYS.has(key)) {
      const v = asRecord(value);
      if (!v) return { ok: false, field: key, reason: 'must_be_object' };
      const base = { ...(asRecord(next[key]) ?? {}) };
      if (key === 'refundPolicy') {
        const facts = v['facts'];
        if (facts === null) {
          delete next[key];
          continue;
        }
        const f = asRecord(facts);
        if (!f) return { ok: false, field: 'refundPolicy.facts', reason: 'must_be_object' };
        const mergedFacts: Record<string, unknown> = { ...(asRecord(base['facts']) ?? {}) };
        for (const [fk, fv] of Object.entries(f)) {
          if (fv === null) delete mergedFacts[fk];
          else mergedFacts[fk] = fv;
        }
        const extra = Object.keys(v).filter((k) => k !== 'facts');
        if (extra.length > 0) return { ok: false, field: `refundPolicy.${extra[0]}`, reason: 'unexpected_field' };
        next[key] = { facts: mergedFacts };
        continue;
      }
      for (const [sk, sv] of Object.entries(v)) {
        if (sv === null) delete base[sk];
        else base[sk] = sv;
      }
      if (Object.keys(base).length === 0) delete next[key];
      else next[key] = base;
      continue;
    }
    next[key] = value;
  }
  const parsed = AtendimentoConfigSchema.safeParse(next);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue ? issue.path.map(String) : [];
    if (issue?.code === 'unrecognized_keys') {
      return { ok: false, field: [...path, issue.keys[0] ?? ''].join('.'), reason: 'unexpected_field' };
    }
    return { ok: false, field: path.length > 0 ? path.join('.') : '(body)', reason: issue?.message ?? 'invalid' };
  }
  return { ok: true, config: parsed.data };
}
