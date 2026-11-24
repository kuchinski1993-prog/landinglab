// Caixa de entrada estilo Gmail do TrustShield (Story 16.1).
//
// Pastas derivadas SÓ do status/categoria que o pipeline já grava em
// inbound_emails + as marcações de inbox_email_flags (lido/estrela/arquivado).
// Nenhuma decisão do TrustShield muda aqui — é uma forma de LER os dados.
//
// Regra das pastas de trabalho: cada e-mail cai em exatamente uma delas
// (Precisa de resposta | Aguardando cliente | Respondidos | Atualizações |
// Spam). "Caixa de entrada", "Com estrela", "Arquivados" e "Todos" são visões.
//
// Os fragmentos SQL assumem os aliases `e` (inbound_emails) e `f`
// (inbox_email_flags, LEFT JOIN).

import { sql, type SQL } from 'drizzle-orm';

export const MAIL_FOLDERS = [
  'inbox',
  'needs_reply',
  'awaiting_customer',
  'answered',
  'starred',
  'updates',
  'spam',
  'archived',
  'all',
] as const;
export type MailFolder = (typeof MAIL_FOLDERS)[number];

export function isMailFolder(value: unknown): value is MailFolder {
  return typeof value === 'string' && (MAIL_FOLDERS as readonly string[]).includes(value);
}

export const SPAM_STATUSES = ['spam_auto', 'spam_confirmed', 'pending_review_spam'] as const;
export const UPDATE_STATUSES = ['system_transactional', 'auto_filtered', 'auto_quarantined'] as const;
export const NEEDS_REPLY_STATUSES = ['received', 'classified', 'pending_human'] as const;
export const ANSWERED_STATUSES = [
  'answered_auto',
  'answered_human',
  'resolved',
  'converted_to_refund',
] as const;

/**
 * Pasta de trabalho de um e-mail (fonte da verdade em TS, espelhada no SQL
 * abaixo e coberta por teste). `pending_human` + categoria spam = a IA ficou
 * em dúvida se era spam → vai para Spam com o aviso "revisar".
 */
export function workFolderOf(row: { status: string; category: string | null }): MailFolder {
  const { status, category } = row;
  if ((SPAM_STATUSES as readonly string[]).includes(status)) return 'spam';
  if ((UPDATE_STATUSES as readonly string[]).includes(status)) return 'updates';
  if ((NEEDS_REPLY_STATUSES as readonly string[]).includes(status)) {
    return category === 'spam_commercial' ? 'spam' : 'needs_reply';
  }
  if (status === 'awaiting_customer') return 'awaiting_customer';
  if ((ANSWERED_STATUSES as readonly string[]).includes(status)) return 'answered';
  // Status desconhecido: aparece na caixa de entrada para não sumir.
  return 'needs_reply';
}

function inList(values: readonly string[]): SQL {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

// Montado sob demanda (não no carregamento do módulo): testes de outras rotas
// substituem o `sql` do drizzle por um mock sem `sql.join`.
let folderConditions: Record<MailFolder, SQL> | null = null;

function buildFolderConditions(): Record<MailFolder, SQL> {
  const IS_SPAM = sql`(e.status IN (${inList(SPAM_STATUSES)}) OR (e.status IN (${inList(NEEDS_REPLY_STATUSES)}) AND e.category IS NOT DISTINCT FROM 'spam_commercial'))`;
  const IS_UPDATE = sql`(e.status IN (${inList(UPDATE_STATUSES)}))`;
  const IS_ANSWERED = sql`(e.status IN (${inList(ANSWERED_STATUSES)}))`;
  const IS_AWAITING = sql`(e.status = 'awaiting_customer')`;
  // Tudo que não é spam/atualização/respondido/aguardando = precisa de
  // resposta (inclui status desconhecidos, igual a workFolderOf).
  const IS_NEEDS_REPLY = sql`(NOT ${IS_SPAM} AND NOT ${IS_UPDATE} AND NOT ${IS_ANSWERED} AND NOT ${IS_AWAITING})`;
  const IS_ARCHIVED = sql`(f.archived_at IS NOT NULL)`;
  const NOT_ARCHIVED = sql`(f.archived_at IS NULL)`;
  return {
    inbox: sql`(NOT ${IS_SPAM} AND NOT ${IS_UPDATE} AND ${NOT_ARCHIVED})`,
    needs_reply: sql`(${IS_NEEDS_REPLY} AND ${NOT_ARCHIVED})`,
    awaiting_customer: sql`(${IS_AWAITING} AND ${NOT_ARCHIVED})`,
    answered: sql`(${IS_ANSWERED} AND ${NOT_ARCHIVED})`,
    starred: sql`(COALESCE(f.starred, false))`,
    updates: sql`(${IS_UPDATE} AND ${NOT_ARCHIVED})`,
    spam: IS_SPAM,
    archived: sql`(${IS_ARCHIVED} AND NOT ${IS_SPAM})`,
    all: sql`(true)`,
  };
}

/** Condição SQL da pasta (aliases `e` e `f`). */
export function folderCondition(folder: MailFolder): SQL {
  folderConditions ??= buildFolderConditions();
  return folderConditions[folder];
}

/** Grupos de assunto do filtro (valores internos continuam em inglês). */
export const TOPIC_CATEGORIES = {
  orders: ['order_status', 'delivery_problem'],
  refunds: ['refund_request', 'exchange_request'],
  complaints: ['complaint_general', 'chargeback_threat'],
  questions: ['product_question_pre_purchase', 'policy_question'],
  unclear: ['unclear'],
} as const;
export type MailTopic = keyof typeof TOPIC_CATEGORIES;

export function isMailTopic(value: unknown): value is MailTopic {
  return typeof value === 'string' && Object.hasOwn(TOPIC_CATEGORIES, value);
}

export function topicCondition(topic: MailTopic): SQL {
  const cats = TOPIC_CATEGORIES[topic];
  const base = sql`e.category IN (${inList(cats)})`;
  return topic === 'unclear' ? sql`(${base} OR e.category IS NULL)` : sql`(${base})`;
}

/** Escapa curingas do ILIKE (%, _ e \). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function searchCondition(q: string): SQL {
  const pattern = `%${escapeLike(q)}%`;
  return sql`(e.from_address ILIKE ${pattern} OR e.from_name ILIKE ${pattern} OR e.subject ILIKE ${pattern} OR e.text_body ILIKE ${pattern})`;
}

/** Normaliza o trecho exibido na lista (sem HTML, espaços colapsados). */
export function buildSnippet(
  textBody: string | null,
  htmlBody: string | null,
  max = 160,
): string {
  let source = textBody ?? '';
  if (!source.trim() && htmlBody) {
    source = htmlBody
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&');
  }
  // Remove o texto citado de respostas ("> ...") para o trecho mostrar o novo.
  const withoutQuotes = source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('>'))
    .join(' ');
  const collapsed = withoutQuotes.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}
