// Story 21.6 — contrato da tela do assistente com a API (/assistant/*) e textos fixos em pt-BR.
// Também usado pela caixa do Início (Story 21.5): GET /assistant/status (404 = ainda não implantado)
// e /assistente?q=… para abrir uma conversa nova com a pergunta.

export const ASSISTANT_STATUS_PATH = '/assistant/status';
export const ASSISTANT_SETTINGS_PATH = '/assistant/settings';
export const ASSISTANT_CONVERSATIONS_PATH = '/assistant/conversations';
export const ASSISTANT_PAGE_PATH = '/assistente';
export const ASSISTANT_MAX_CHARS = 2000;
export const ASSISTANT_MAX_CAP_USD = 50;

export const ASSISTANT_TITLE = 'Assistente de negócios';
export const ASSISTANT_DISCLAIMER = 'O assistente consulta números do painel e pode errar. Confira valores importantes.';
export const ASSISTANT_PRIVACY_HINT = 'Não cole dados de clientes (nome, e-mail, telefone, endereço). O que parecer dado pessoal é mascarado antes de sair do painel.';

export const EXAMPLE_QUESTIONS: readonly string[] = [
  'Como foram as vendas essa semana?',
  'O que precisa da minha atenção hoje?',
  'Quais produtos mais vendem?',
  'Como está o lucro deste mês?',
];

export type AssistantUnavailableReason = 'disabled' | 'no_key' | 'unavailable';

export interface AssistantStatus {
  enabled: boolean;
  reason?: AssistantUnavailableReason;
  canManage?: boolean;
  model?: string;
  promptVersion?: string;
  settingsEnabled?: boolean;
  envEnabled?: boolean;
  dailyCapUsd?: number | null;
  usedTodayUsd?: number | null;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolsUsed: string[];
  toolLabels: string[];
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolLabels: string[];
  /** Resposta ainda chegando. */
  streaming?: boolean;
  /** Erro fixo (pt-BR) desta resposta. */
  error?: { code: string; message: string } | null;
}

/** Texto de cada motivo de indisponibilidade (nunca erro genérico — B12). */
export function unavailableText(
  reason: AssistantUnavailableReason | undefined,
  canManage: boolean,
  serverOff = false,
): { heading: string; body: string } {
  if (reason === 'disabled' && serverOff) {
    // ASSISTANT_ENABLED=false na API: não dá para ligar pela tela.
    return { heading: 'O assistente está desligado', body: 'O assistente está desligado no servidor. Ele ainda não foi liberado para uso.' };
  }
  if (reason === 'disabled') {
    return {
      heading: 'O assistente está desligado',
      body: canManage ? 'Ligue o assistente em "Configurar" quando quiser usar.' : 'Peça ao dono da conta para ligar o assistente.',
    };
  }
  if (reason === 'no_key') {
    return {
      heading: 'O assistente não está configurado',
      body: 'Falta a chave de IA da conta no cofre (Configurações da conta → Credenciais). Sem ela, nenhuma pergunta é enviada.',
    };
  }
  return { heading: 'O assistente está indisponível agora', body: 'Tente de novo em instantes.' };
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  // Centavos de dólar somem com 2 casas: abaixo de US$ 1 mostra até 4 casas (ex.: US$ 0,0041).
  const max = Math.abs(value) > 0 && Math.abs(value) < 1 ? 4 : 2;
  return `US$ ${value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: max })}`;
}

/** Texto do erro de uma pergunta (códigos da API + do cliente de stream). */
export function chatErrorText(code: string, message: string, details: Record<string, unknown> | null): string {
  if (code === 'assistant_daily_cap') {
    const used = typeof details?.['usedUsd'] === 'number' ? (details['usedUsd'] as number) : null;
    const cap = typeof details?.['capUsd'] === 'number' ? (details['capUsd'] as number) : null;
    const values = used !== null && cap !== null ? ` Uso de hoje: ${formatUsd(used)} de ${formatUsd(cap)}.` : '';
    return `O teto diário de custo do assistente foi atingido.${values} O teto volta a zerar à meia-noite (horário de Brasília).`;
  }
  return message;
}

export function consultedLabel(labels: readonly string[]): string {
  return labels.length > 0 ? `Consultou: ${[...new Set(labels)].join(' · ')}` : '';
}

export function activityLabel(label: string): string {
  return `Consultando ${label.toLocaleLowerCase('pt-BR')}…`;
}

export function formatConversationDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
}
