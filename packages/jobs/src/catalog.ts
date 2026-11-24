// Story 18.3 · Códigos de erro dos jobs duráveis (biblioteca + processors adotantes).
// Documentados em docs/architecture/erros.md — códigos nunca mudam de significado.
//
// Os de `plataforma.job_*` também entram no catálogo `plataforma` da API
// (apps/api/src/lib/plataforma-errors.ts) para a rota responder 503 tipado.
// Os de `loja.*` são gravados em job_runs.error_code pelos processors.
import { defineCatalog } from '@blackshop/errors';

export const JOB_ERROR_ENTRIES = {
  'plataforma.job_unclassified': {
    status: 500,
    message: 'A tarefa falhou por um motivo ainda não classificado. A equipe vai analisar.',
  },
  'plataforma.job_enqueue_failed': { status: 503, message: 'Não foi possível agendar a tarefa. Tente de novo.' },
} as const;

export const JOB_ERRORS = defineCatalog('plataforma', JOB_ERROR_ENTRIES);

export const LOJA_JOB_ERRORS = defineCatalog('loja', {
  'loja.relink_product_not_found': { status: 404, message: 'Produto não encontrado para religar as cores.' },
  'loja.relink_source_unavailable': {
    status: 503,
    message: 'A loja de origem não respondeu. A tarefa será repetida.',
  },
  'loja.relink_source_rejected': {
    status: 422,
    message: 'A loja de origem não devolveu o produto (página inexistente ou resposta inválida).',
  },
  'loja.relink_source_empty': { status: 422, message: 'A loja de origem não devolveu dados do produto.' },
  'loja.relink_publish_enqueue_failed': {
    status: 503,
    message: 'Não foi possível agendar a republicação na Shopify. A tarefa será repetida.',
  },
  'loja.mirror_ambiguous': {
    status: 409,
    message: 'Há mais de um produto na Shopify com o mesmo SKU. Confira na Shopify antes de republicar.',
  },
  'loja.reconcile_too_soon': {
    status: 409,
    message: 'A Shopify ainda está processando o produto anterior. Aguarde 2 minutos e republique.',
  },
  'loja.reconcile_tag_not_removed': {
    status: 502,
    message: 'Não foi possível remover o marcador de reconciliação do produto na Shopify.',
  },
  // Story 17.2b · job com storeId no payload diferente da loja do produto (nada é alterado).
  'loja.job_store_mismatch': {
    status: 409,
    message: 'A tarefa pertence a outra loja e não foi executada. Nada foi alterado.',
  },
  // Story 18.5 · backfill de pedidos (orders-backfill-queue).
  'loja.orders_backfill_invalid_input': {
    status: 400,
    message: 'Pedido de importação de pedidos inválido (loja ou número de dias).',
  },
  'loja.orders_backfill_not_configured': {
    status: 503,
    message: 'A integração com a Shopify não está configurada (domínio ou credenciais ausentes no Vault).',
  },
  'loja.orders_backfill_source_rejected': {
    status: 422,
    message: 'A Shopify recusou a consulta de pedidos (credencial inválida, sem permissão ou loja inexistente).',
  },
  'loja.orders_backfill_source_unavailable': {
    status: 503,
    message: 'A Shopify não respondeu à consulta de pedidos. A tarefa será repetida.',
  },
});

// Story 18.8 · envio de eventos à Meta (marketing-capi-queue). Gravados em job_runs.error_code e em
// tracking_events.payload.job_error_code (painel GET /tracking/health). Não são respostas de rota.
export const MARKETING_JOB_ERRORS = defineCatalog('marketing', {
  'marketing.capi_unavailable': {
    status: 503,
    message: 'A Meta não respondeu ao envio do evento. A tarefa será repetida.',
  },
  'marketing.capi_token_rejected': {
    status: 422,
    message: 'A Meta recusou o token da Conversions API. Corrija o token da Meta nas configurações do pixel.',
  },
  'marketing.capi_event_rejected': {
    status: 422,
    message: 'A Meta recusou o evento (dado inválido, pixel inexistente ou versão da API). Reenviar não adianta.',
  },
  'marketing.capi_not_configured': {
    status: 503,
    message: 'O pixel, o token ou o modo da Conversions API da Meta não está configurado para esta loja.',
  },
  'marketing.capi_out_of_window': {
    status: 422,
    message: 'O evento tem mais de 7 dias e a Meta não aceita mais o envio.',
  },
  // Story 24.4 · envio dos itens do catálogo pela Catalog API (meta-catalog-push.processor).
  'marketing.catalog_unavailable': {
    status: 503,
    message: 'A Meta não respondeu ao envio dos itens do catálogo. A tarefa será repetida.',
  },
  'marketing.catalog_token_rejected': {
    status: 422,
    message: 'A Meta recusou o token do catálogo. Salve um token novo nas configurações do catálogo.',
  },
  'marketing.catalog_rejected': {
    status: 422,
    message: 'A Meta recusou o lote de itens do catálogo (dado inválido ou catálogo inexistente). Reenviar não adianta.',
  },
  'marketing.catalog_not_configured': {
    status: 503,
    message: 'O catálogo não tem conexão com a Meta configurada (id do catálogo ou token ausente).',
  },
});

export type JobErrorCode = Extract<keyof typeof JOB_ERROR_ENTRIES, string>;
export type LojaJobErrorCode = Extract<keyof typeof LOJA_JOB_ERRORS.entries, string>;
export type MarketingJobErrorCode = Extract<keyof typeof MARKETING_JOB_ERRORS.entries, string>;
