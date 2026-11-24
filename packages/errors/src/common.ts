// Catálogo comum: códigos genéricos (mesmos do VSL) + rate_limited + legados UPSTREAM_*.
// Documentado em docs/architecture/erros.md — códigos nunca mudam de significado.
import { defineCatalog } from './catalog.js';

export const COMMON_CATALOG = defineCatalog(
  'comum',
  {
    validation_failed: { status: 400, message: 'Dados inválidos na requisição.' },
    unauthorized: { status: 401, message: 'Sessão expirada. Faça login novamente.' },
    cross_site_rejected: { status: 403, message: 'Requisição de outra origem bloqueada.' },
    // Story 18.11: 403/405 genéricos do Fastify com código próprio (antes viravam validation_failed).
    forbidden: { status: 403, message: 'Você não tem permissão para esta ação.' },
    method_not_allowed: { status: 405, message: 'Método não permitido para este endereço.' },
    not_found: { status: 404, message: 'Recurso não encontrado.' },
    version_conflict: { status: 409, message: 'O item foi alterado por outra ação. Recarregue e tente de novo.' },
    constraint_conflict: { status: 409, message: 'A alteração conflita com dados existentes.' },
    rate_limited: { status: 429, message: 'Muitas requisições. Aguarde alguns instantes e tente de novo.' },
    internal_error: { status: 500, message: 'Erro interno. Tente novamente.' },
    service_unavailable: { status: 503, message: 'Serviço indisponível no momento. Tente novamente em instantes.' },
    // Legados da story 0.8 (contrato já consumido por vitrine/checkout): nome em maiúsculas preservado.
    UPSTREAM_TIMEOUT: {
      status: 504,
      message: 'O serviço externo não respondeu a tempo. Tente novamente em instantes.',
      legacy: true,
    },
    UPSTREAM_RATE_LIMITED: {
      status: 503,
      message: 'O serviço externo está recebendo muitas requisições. Tente novamente em instantes.',
      legacy: true,
    },
    // Story 18.2: mesma família (cliente HTTP de @blackshop/shared/http).
    UPSTREAM_UNAVAILABLE: {
      status: 503,
      message: 'O serviço externo está indisponível no momento. Tente novamente em instantes.',
      legacy: true,
    },
    UPSTREAM_REJECTED: {
      status: 502,
      message: 'O serviço externo recusou a requisição. Verifique a configuração da integração.',
      legacy: true,
    },
  },
  { prefix: '' }
);

export const COMMON_ERRORS = COMMON_CATALOG.entries;
export type CommonErrorCode = Extract<keyof typeof COMMON_ERRORS, string>;
