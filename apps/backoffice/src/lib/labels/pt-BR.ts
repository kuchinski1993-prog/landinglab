// TrustShield · Dicionário PT-BR (Fase A — Atlas 2026-07-03).
//
// Regras de contrato:
//   1. Valores internos (banco, API, URLs, filtros, matriz de decisão)
//      continuam em INGLÊS. Este arquivo mapeia apenas a EXIBIÇÃO.
//   2. Todos os helpers têm fallback seguro: valor desconhecido retorna o
//      valor cru como label (nunca undefined; UI nunca quebra). Em dev,
//      logamos um console.warn para pegar valores esquecidos.
//   3. Cada entrada mantém o `tone` semântico (Polaris) para as badges
//      aplicarem cor sem duplicar taxonomia. Componentes de badge lêem
//      daqui.
//   4. Estrutura preparada para i18n futura (o `PT_BR` de hoje amanhã vira
//      `{ 'pt-BR': {...}, 'en-GB': {...} }` sem breaking change dos
//      helpers).
//
// Decisões do dono aplicadas:
//   * "chargeback" permanece em inglês (termo natural do e-commerce)
//   * "acknowledgement / ack sent" → "Confirmação enviada"
//   * Referência de familiaridade: Gmail em português
//
// Escopo: só backoffice (UI operacional PT-BR). Emails ao cliente
// continuam inglês UK por design da marca AuthenLondon.

// ── Tipos & tone ────────────────────────────────────────────────────────

/**
 * Tom semântico Polaris. Reusado pelos componentes de badge (evita
 * duplicar taxonomia entre dicionário e badge).
 */
export type LabelTone = 'success' | 'warning' | 'critical' | 'info' | 'attention';

export interface LabelEntry {
  /** Texto exibido ao usuário em PT-BR. */
  label: string;
  /** Tone Polaris opcional. Undefined = badge neutra. */
  tone?: LabelTone;
  /** Tooltip opcional — útil para termos técnicos (ex.: "chargeback"). */
  description?: string;
}

// ── Categorias de email (InboundCategory) ───────────────────────────────

export const CATEGORY_PT_BR = {
  refund_request:                 { label: 'Reembolso', tone: 'info' },
  exchange_request:               { label: 'Troca', tone: 'info' },
  order_status:                   { label: 'Status do pedido', tone: 'info' },
  delivery_problem:               { label: 'Problema na entrega', tone: 'warning' },
  product_question_pre_purchase:  { label: 'Dúvida de produto', tone: 'info' },
  policy_question:                { label: 'Dúvida sobre política', tone: 'info' },
  complaint_general:              { label: 'Reclamação', tone: 'warning' },
  chargeback_threat:              {
    label: 'Ameaça de chargeback',
    tone: 'critical',
    description: 'Cliente ameaça contestar o pagamento junto ao banco (chargeback).',
  },
  thank_you_closed:               { label: 'Agradecimento', tone: 'success' },
  spam_commercial:                { label: 'Spam', tone: undefined },
  system_transactional:           { label: 'Notificação do sistema', tone: undefined },
  unclear:                        { label: 'Não classificado', tone: undefined },
} as const satisfies Record<string, LabelEntry>;

export type InternalCategory = keyof typeof CATEGORY_PT_BR;

// ── Status de email (inbound_emails.status) ─────────────────────────────

export const STATUS_PT_BR = {
  received:               { label: 'Recebido', tone: undefined },
  classified:             { label: 'Classificado', tone: 'info' },
  answered_auto:          { label: 'Respondido (automático)', tone: 'success' },
  answered_human:         { label: 'Respondido', tone: 'success' },
  awaiting_customer:      { label: 'Aguardando cliente', tone: 'info' },
  pending_human:          { label: 'Precisa de atenção', tone: 'warning' },
  converted_to_refund:    { label: 'Virou reembolso', tone: 'info' },
  spam_auto:              { label: 'Spam', tone: undefined },
  spam_confirmed:         { label: 'Spam confirmado', tone: undefined },
  pending_review_spam:    { label: 'Spam em revisão', tone: 'warning' },
  auto_filtered:          { label: 'Filtrado automaticamente', tone: undefined },
  auto_quarantined:       { label: 'Em quarentena', tone: 'warning' },
  system_transactional:   { label: 'Notificação do sistema', tone: undefined },
  resolved:               { label: 'Resolvido', tone: 'success' },
} as const satisfies Record<string, LabelEntry>;

export type InternalStatus = keyof typeof STATUS_PT_BR;

// ── Verificação de identidade (verification_state) ──────────────────────

export const VERIFICATION_PT_BR = {
  verified_match:         { label: 'Cliente verificado', tone: 'success' },
  verified_via_order:     { label: 'Verificado pelo pedido', tone: 'success' },
  unknown_sender:         { label: 'Remetente desconhecido', tone: 'warning' },
  suspicious_claim:       {
    label: 'Suspeita de fraude',
    tone: 'critical',
    description: 'Remetente cita pedido cujo e-mail original não bate — vetor de engenharia social.',
  },
} as const satisfies Record<string, LabelEntry>;

export type InternalVerification = keyof typeof VERIFICATION_PT_BR;

// ── Filas do Inbox (InboxQueueId — Fase 3) ──────────────────────────────

export const QUEUE_PT_BR = {
  needs_attention:        { label: 'Precisa de atenção', tone: 'critical' },
  awaiting_customer:      { label: 'Aguardando cliente', tone: 'info' },
  refunds:                { label: 'Reembolsos', tone: 'warning' },
  open_threads:           { label: 'Conversas abertas', tone: 'info' },
  questions:              { label: 'Dúvidas', tone: 'info' },
  spam:                   { label: 'Spam', tone: undefined },
  system:                 { label: 'Notificações do sistema', tone: undefined },
  all:                    { label: 'Tudo', tone: undefined },
} as const satisfies Record<string, LabelEntry>;

export type InternalQueue = keyof typeof QUEUE_PT_BR;

// ── Ações (InboundAction — matriz de decisão) ───────────────────────────

export const ACTION_PT_BR = {
  auto_reply:             { label: 'Responder automático', tone: 'success' },
  propose_reply:          { label: 'Rascunho para revisão', tone: 'info' },
  request_info:           { label: 'Pedir informação', tone: 'info' },
  open_refund_ticket:     { label: 'Abrir ticket de reembolso', tone: 'info' },
  escalate_human:         { label: 'Encaminhar para atendente', tone: 'warning' },
  ignore_spam:            { label: 'Ignorar (spam)', tone: undefined },
  pending_review_spam:    { label: 'Enviar para revisão de spam', tone: 'warning' },
  mark_resolved:          { label: 'Marcar como resolvido', tone: 'success' },
  pending_human:          { label: 'Precisa de atenção', tone: 'warning' },
} as const satisfies Record<string, LabelEntry>;

export type InternalAction = keyof typeof ACTION_PT_BR;

// ── Status de refund_tickets ────────────────────────────────────────────
// Valores reais em uso: open, in_review, approved, denied, escalated,
// resolved (schema é text livre; observados no código).

export const REFUND_STATUS_PT_BR = {
  open:                   { label: 'Aberto', tone: 'warning' },
  in_review:              { label: 'Em análise', tone: 'warning' },
  approved:               { label: 'Aprovado', tone: 'success' },
  denied:                 { label: 'Recusado', tone: 'critical' },
  rejected:               { label: 'Recusado', tone: 'critical' }, // sinônimo defensivo
  escalated:              { label: 'Encaminhado para você', tone: 'warning' },
  resolved:               { label: 'Resolvido', tone: 'success' },
} as const satisfies Record<string, LabelEntry>;

export type InternalRefundStatus = keyof typeof REFUND_STATUS_PT_BR;

// ── Fontes (refund_tickets.source) ──────────────────────────────────────

export const SOURCE_PT_BR = {
  storefront_form:        { label: 'Portal do site', tone: undefined },
  inbound_email:          { label: 'E-mail', tone: 'info' },
  operator_manual:        { label: 'Manual', tone: undefined },
} as const satisfies Record<string, LabelEntry>;

export type InternalSource = keyof typeof SOURCE_PT_BR;

// ── Recomendação da IA no ticket de reembolso (refund_tickets.ai_recommendation)

export const REFUND_RECOMMENDATION_PT_BR = {
  approve:  { label: 'IA sugere aprovar', tone: 'success' },
  deny:     { label: 'IA sugere recusar', tone: 'critical' },
  escalate: { label: 'IA pede sua análise', tone: 'warning' },
} as const satisfies Record<string, LabelEntry>;

// ── Disputas / chargebacks da Shopify Payments (Story 16.2) ─────────────

export const DISPUTE_STATUS_PT_BR = {
  needs_response:  { label: 'Precisa de resposta', tone: 'critical' },
  under_review:    { label: 'Em análise pelo banco', tone: 'warning' },
  charge_refunded: { label: 'Valor devolvido', tone: undefined },
  accepted:        { label: 'Aceita (sem contestar)', tone: undefined },
  won:             { label: 'Ganha', tone: 'success' },
  lost:            { label: 'Perdida', tone: 'critical' },
} as const satisfies Record<string, LabelEntry>;

export const DISPUTE_TYPE_PT_BR = {
  chargeback: {
    label: 'Chargeback',
    tone: 'critical',
    description: 'O cliente contestou o pagamento no banco; o valor fica retido até a decisão.',
  },
  inquiry: {
    label: 'Consulta do banco',
    tone: 'warning',
    description: 'O banco pediu informações antes de abrir um chargeback.',
  },
} as const satisfies Record<string, LabelEntry>;

export const DISPUTE_REASON_PT_BR = {
  bank_cannot_process:       { label: 'Banco não conseguiu processar' },
  credit_not_processed:      { label: 'Reembolso não recebido' },
  customer_initiated:        { label: 'Aberta pelo cliente' },
  debit_not_authorized:      { label: 'Débito não autorizado' },
  duplicate:                 { label: 'Cobrança duplicada' },
  fraudulent:                { label: 'Fraude (cliente não reconhece)' },
  general:                   { label: 'Outro motivo' },
  incorrect_account_details: { label: 'Dados da conta incorretos' },
  insufficient_funds:        { label: 'Saldo insuficiente' },
  product_not_received:      { label: 'Produto não recebido' },
  product_unacceptable:      { label: 'Produto com defeito ou diferente' },
  subscription_canceled:     { label: 'Assinatura cancelada' },
  unrecognized:              { label: 'Cobrança não reconhecida' },
} as const satisfies Record<string, LabelEntry>;

// ── Rótulos de KPI / UI genérica ────────────────────────────────────────

// ── Tipos de notificação do sino (notifications.type) ──────────────────
//
// notifications.type é text livre (schema Fase D permite extensão sem
// migration). Este dicionário existe para os componentes que quiserem
// renderizar um badge com tone consistente (ex.: cards de auditoria).
// O sino em si exibe o `title` já em PT-BR gravado com a notificação —
// este mapa é complementar.
export const NOTIFICATION_TYPE_PT_BR = {
  chargeback_threat: {
    label: 'Ameaça de chargeback',
    tone: 'critical',
    description: 'Cliente ameaça abrir chargeback junto ao banco.',
  },
  suspicious_claim: {
    label: 'Suspeita de fraude',
    tone: 'warning',
    description: 'Identidade não verificada por DMARC/pedido.',
  },
  refund_pending_approval: {
    label: 'Reembolso aguardando aprovação',
    tone: 'warning',
    description: 'Ticket de reembolso aberto; requer decisão do dono.',
  },
  // Fase E — engenharia social.
  security_alert: {
    label: 'Tentativa de acesso a dados',
    tone: 'critical',
    description:
      'Remetente pediu dados pessoais de um cliente/terceiro. Nunca compartilhar PII.',
  },
  // Story 0.7 — câmbio com variação acima do limite da loja.
  fx_rate_pending_approval: {
    label: 'Câmbio aguardando aprovação',
    tone: 'warning',
    description:
      'A nova taxa de câmbio passou do limite de variação; os preços só mudam depois da aprovação.',
  },
} as const satisfies Record<string, LabelEntry>;

// ── Risk signals (classification.riskSignals) ──────────────────────────
export const RISK_SIGNAL_PT_BR = {
  monetary_value_claimed: {
    label: 'Valor monetário citado',
    tone: 'warning',
  },
  urgency_pressure: { label: 'Pressão de urgência', tone: 'warning' },
  legal_threat: { label: 'Ameaça legal', tone: 'critical' },
  multiple_orders_mentioned: {
    label: 'Vários pedidos citados',
    tone: 'info',
  },
  suspicious_link: { label: 'Link suspeito', tone: 'critical' },
  // Fase E — engenharia social.
  data_exfiltration_attempt: {
    label: 'Pedido de dados de terceiro',
    tone: 'critical',
    description:
      'Remetente tentou obter dados pessoais de um cliente que não é ele.',
  },
} as const satisfies Record<string, LabelEntry>;

export const KPI_PT_BR = {
  ackSent:                'Confirmação enviada',
  ackRate:                'Taxa de confirmação',
  autoAnswered:           'Respondido automático',
  autoAnsweredRate:       'Taxa de resposta automática',
  escalated:              'Encaminhados',
  escalatedRate:          'Taxa de encaminhamento',
  aiCost:                 'Custo de IA',
  aiCost24h:              'Custo de IA (24h)',
  volume24h:              'Volume (24h)',
  pendingHuman:           'Precisam de atenção',
  spam:                   'Spam',
  convertedRefund:        'Viraram reembolso',
} as const;

// ── Domínio-neutro: helper genérico ─────────────────────────────────────

const IS_DEV =
  typeof process !== 'undefined' &&
  process.env['NODE_ENV'] !== 'production' &&
  process.env['NODE_ENV'] !== 'test';

/**
 * Lookup base com fallback seguro. Nunca throw. Em dev, warn 1x por
 * valor faltante (para descobrirmos gaps sem poluir o console).
 */
const warnedMissing = new Set<string>();
function lookup(
  dict: Record<string, LabelEntry>,
  domain: string,
  value: string | null | undefined,
): LabelEntry {
  if (value == null || value === '') return { label: '—' };
  const entry = dict[value];
  if (entry) return entry;
  const key = `${domain}:${value}`;
  if (IS_DEV && !warnedMissing.has(key)) {
    warnedMissing.add(key);
    // eslint-disable-next-line no-console
    console.warn(`[labels/pt-BR] Missing translation for ${domain}="${value}"`);
  }
  return { label: value };
}

// ── Helpers públicos ────────────────────────────────────────────────────

export function categoryLabel(v: string | null | undefined): LabelEntry {
  return lookup(CATEGORY_PT_BR, 'category', v);
}

export function statusLabel(v: string | null | undefined): LabelEntry {
  return lookup(STATUS_PT_BR, 'status', v);
}

export function verificationLabel(v: string | null | undefined): LabelEntry {
  return lookup(VERIFICATION_PT_BR, 'verification', v);
}

export function queueLabel(v: string | null | undefined): LabelEntry {
  return lookup(QUEUE_PT_BR, 'queue', v);
}

export function actionLabel(v: string | null | undefined): LabelEntry {
  return lookup(ACTION_PT_BR, 'action', v);
}

export function refundStatusLabel(v: string | null | undefined): LabelEntry {
  return lookup(REFUND_STATUS_PT_BR, 'refund_status', v);
}

export function sourceLabel(v: string | null | undefined): LabelEntry {
  return lookup(SOURCE_PT_BR, 'source', v);
}

export function refundRecommendationLabel(v: string | null | undefined): LabelEntry {
  return lookup(REFUND_RECOMMENDATION_PT_BR, 'refund_recommendation', v);
}

export function disputeStatusLabel(v: string | null | undefined): LabelEntry {
  return lookup(DISPUTE_STATUS_PT_BR, 'dispute_status', v);
}

export function disputeTypeLabel(v: string | null | undefined): LabelEntry {
  return lookup(DISPUTE_TYPE_PT_BR, 'dispute_type', v);
}

export function disputeReasonLabel(v: string | null | undefined): LabelEntry {
  return lookup(DISPUTE_REASON_PT_BR, 'dispute_reason', v);
}

/** Rótulo de tipo de notificação (chargeback_threat, security_alert, ...). */
export function notificationTypeLabel(v: string | null | undefined): LabelEntry {
  return lookup(NOTIFICATION_TYPE_PT_BR, 'notification_type', v);
}

/** Rótulo de risk signal (data_exfiltration_attempt, legal_threat, ...). */
export function riskSignalLabel(v: string | null | undefined): LabelEntry {
  return lookup(RISK_SIGNAL_PT_BR, 'risk_signal', v);
}

/** Rótulo de KPI genérico. Retorna string simples (KPI não tem tone). */
export function kpiLabel(key: keyof typeof KPI_PT_BR): string {
  return KPI_PT_BR[key];
}

// ── Preferido: usar helpers → mas exportamos dicionários para snapshot ──
// tests / cobertura.

export const _DICTIONARIES = {
  category: CATEGORY_PT_BR,
  status: STATUS_PT_BR,
  verification: VERIFICATION_PT_BR,
  queue: QUEUE_PT_BR,
  action: ACTION_PT_BR,
  refundStatus: REFUND_STATUS_PT_BR,
  source: SOURCE_PT_BR,
  notificationType: NOTIFICATION_TYPE_PT_BR,
  riskSignal: RISK_SIGNAL_PT_BR,
  refundRecommendation: REFUND_RECOMMENDATION_PT_BR,
  disputeStatus: DISPUTE_STATUS_PT_BR,
  disputeType: DISPUTE_TYPE_PT_BR,
  disputeReason: DISPUTE_REASON_PT_BR,
} as const;
