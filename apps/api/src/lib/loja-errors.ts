// Story 18.5 · Catálogo do módulo "loja" para erros de ROTA (webhooks Shopify, pedidos no painel,
// checkout). Os códigos `loja.*` de jobs ficam em @blackshop/jobs (`LOJA_JOB_ERRORS`, mesmo módulo).
// Códigos legados da 0.2/0.3/0.8 (ORDER_*, SHOPIFY_WEBHOOK_SECRET_*, SHOPIFY_MODE_NOT_CONFIGURED,
// UPSTREAM_*) continuam como estão — ver "Códigos legados" em docs/architecture/erros.md.
import { defineCatalog } from '@blackshop/errors';

export const LOJA_ERRORS = defineCatalog('loja', {
  'loja.webhook_invalid_signature': { status: 401, message: 'Assinatura do webhook inválida.' },
  'loja.webhook_invalid_payload': { status: 400, message: 'Corpo do webhook inválido.' },
  'loja.webhook_persist_failed': {
    status: 503,
    message: 'Não foi possível gravar o webhook agora. A Shopify vai reenviar.',
  },
  'loja.webhook_payload_rejected': {
    status: 422,
    message: 'O banco rejeitou o dado do webhook (dado inválido). Falha registrada; reenviar não adianta.',
  },
  'loja.order_not_found': { status: 404, message: 'Pedido não encontrado.' },
  'loja.cart_invalid': { status: 400, message: 'Carrinho inválido. Revise os itens e tente de novo.' },
  'loja.cart_empty': { status: 400, message: 'O carrinho está vazio.' },
  'loja.checkout_variants_unavailable': {
    status: 422,
    message: 'Alguns produtos do carrinho ainda não estão disponíveis para pagamento.',
  },
  'loja.checkout_not_configured': {
    status: 503,
    message: 'O checkout da loja ainda não está configurado.',
  },
  // Story 17.4a · loja ≠ default sem `settings.checkoutEnabled === true` (fail-closed: as credenciais do
  // checkout ainda são globais — 17.3; quem liga é a 17.8).
  'loja.checkout_disabled': { status: 409, message: 'O checkout desta loja ainda não está habilitado.' },
  'loja.checkout_failed': { status: 502, message: 'Não foi possível iniciar o pagamento. Tente de novo.' },
  // Story 23.3 (PR2) · loja ≠ default: o servidor recalcula a disponibilidade de cada linha.
  'loja.checkout_out_of_stock': {
    status: 422,
    message: 'Uma ou mais peças do carrinho esgotaram. Revise o carrinho e tente de novo.',
  },
  // Story 17.6b · endereços de suporte por loja (/stores/:id/support-addresses).
  'loja.support_address_invalid': {
    status: 400,
    message: 'Endereço de suporte inválido. Use nome@dominio.com ou @dominio.com (até 254 caracteres).',
  },
  'loja.support_address_taken': { status: 409, message: 'Este endereço de suporte já pertence a outra loja.' },
  'loja.support_address_protected': {
    status: 409,
    message: 'Este endereço de suporte está protegido e não pode ser removido ou trocado por aqui.',
  },
  // Story 17.3b · domínio da vitrine de loja ≠ default (PUT /settings/storefront-domain): um domínio
  // pertence a UMA loja (inclusive a default); nada é gravado.
  'loja.domain_taken': {
    status: 409,
    message: 'Este endereço já pertence a outra loja. Use outro domínio ou remova-o da outra loja primeiro.',
  },
  // Story 17.6c · configuração do Atendimento por loja (/admin/store/atendimento, respostas do inbox).
  'loja.atendimento_not_configured': {
    status: 409,
    message: 'O Atendimento desta loja ainda não está configurado. Nada foi enviado ao cliente — complete a configuração.',
  },
  'loja.atendimento_sender_domain': {
    status: 400,
    message: 'O remetente precisa usar um domínio da loja (de um endereço de suporte da loja ou do domínio da loja).',
  },
  // Story 18.6a · `PATCH /products/:id/variants` (nada é gravado quando um destes sai).
  'loja.variants_required': {
    status: 400,
    message: 'O produto precisa de pelo menos uma variante. Nada foi alterado.',
  },
  'loja.variant_price_required': { status: 400, message: 'Informe o preço de todas as variantes.' },
  'loja.variant_price_invalid': {
    status: 400,
    message: 'Preço de variante inválido. Use só números com ponto e até 2 casas decimais (ex.: 129.90).',
  },
  // Story 23.3 · política de disponibilidade e prazo de produção (PATCH /products/:id e /variants).
  'loja.fulfillment_invalid': {
    status: 422,
    message: 'Disponibilidade ou prazo inválido. O prazo de produção é um número inteiro de 1 a 365 dias. Nada foi gravado.',
  },
  'loja.fulfillment_lead_time_required': {
    status: 422,
    message: 'Informe o prazo de produção (dias) do produto ou de todas as variantes para vender sob encomenda. Nada foi gravado.',
  },
  // Story 23.4 · campos personalizados (/admin/custom-fields*, /admin/products/:id/custom-values).
  'loja.custom_field_invalid': {
    status: 422,
    message: 'Campo personalizado inválido. Confira o nome, o tipo, as opções e o valor. Nada foi gravado.',
  },
  'loja.custom_field_limit': { status: 422, message: 'A loja já tem 20 campos personalizados (o máximo). Exclua um antes de criar outro.' },
  'loja.custom_field_duplicate': { status: 409, message: 'Já existe um campo personalizado com esta chave nesta loja.' },
  'loja.custom_field_in_use': {
    status: 409,
    message: 'Este campo já tem valores em produtos: a chave, o tipo e as opções usadas não podem mudar. Crie outro campo ou apague os valores antes.',
  },
  // Story 21.3 · lucro (/admin/store/profit*): nunca um número parcial como se fosse completo.
  'loja.profit_unavailable': {
    status: 503,
    message: 'Não foi possível calcular o lucro agora. Nenhum número parcial foi mostrado — tente de novo em instantes.',
  },
  'loja.profit_config_too_large': {
    status: 422,
    message: 'A configuração de custos passou do limite (2.000 produtos, 800 dias de anúncios ou 400 KB). Nada foi gravado.',
  },
});

export type LojaErrorCode = Extract<keyof typeof LOJA_ERRORS.entries, string>;

/** Motivos de `loja.webhook_invalid_payload` (`details.reason`). */
export type WebhookInvalidPayloadReason = 'invalid_json' | 'order_id_required' | 'dispute_id_required';

/**
 * `error_code` informativo da tentativa quando orders/updated ou fulfillments/update chega para um
 * pedido que não está em `orders` (normal: `orders` só guarda pedidos pagos). Não é resposta de erro
 * (o webhook responde 200), por isso não está no catálogo.
 */
export const ORDER_NOT_FOUND_FOR_UPDATE = 'loja.order_not_found_for_update';
