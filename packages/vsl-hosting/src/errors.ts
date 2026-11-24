// Catálogo de erros G3 com códigos estáveis e mensagens PT-BR.
// Tabela documentada em docs/vsl/api-errors.md — códigos nunca mudam de significado.
// Story 18.1: camada fina sobre @blackshop/errors. Os 8 genéricos vêm do catálogo comum
// (internal_error/service_unavailable com a mensagem do VSL via `overrides`); o contrato é idêntico.
// Caminho relativo (não '@blackshop/errors'): entra no bundle Vercel do vsl-storefront
// (safe-fetch → domain-service → errors.ts), que só empacota fontes de workspace por caminho relativo.
import { COMMON_CATALOG, defineCatalog, toErrorResponse } from '../../errors/src/index.js';

import { VslError } from './imports.js';

export const VSL_CATALOG = defineCatalog(
  'vsl',
  {
    // Projetos e etapas
    project_not_found: { status: 404, message: 'Projeto não encontrado.' },
    project_not_editable: { status: 409, message: 'Projeto arquivado não pode ser editado.' },
    project_not_archivable: { status: 409, message: 'Despublique o projeto antes de arquivá-lo.' },
    project_needs_step: { status: 409, message: 'O projeto precisa de pelo menos uma etapa.' },
    step_not_found: { status: 404, message: 'Etapa não encontrada.' },
    step_in_use: { status: 409, message: 'Outra etapa segue para esta. Ajuste o "segue para" antes de excluir.' },
    invalid_pathname: { status: 400, message: 'Caminho inválido. Use algo como /oferta.' },
    pathname_conflict: { status: 409, message: 'Este caminho já está em uso.' },
    funnel_graph_invalid: { status: 400, message: 'A sequência de etapas é inválida (ciclo ou etapa inexistente).' },
    invalid_step_order: { status: 400, message: 'A nova ordem precisa conter cada etapa exatamente uma vez.' },
    invalid_config: { status: 400, message: 'Configuração inválida.' },
    asset_unavailable: { status: 400, message: 'Página ou vídeo indisponível para esta etapa.' },
    // Páginas e import
    page_not_found: { status: 404, message: 'Página não encontrada.' },
    unsupported_media_type: { status: 415, message: 'Envie um arquivo HTML ou ZIP.' },
    content_length_required: { status: 411, message: 'Tamanho do envio (Content-Length) obrigatório.' },
    payload_too_large: { status: 413, message: 'Arquivo acima do limite permitido.' },
    idempotency_conflict: { status: 409, message: 'Esta chave de idempotência já foi usada com outro envio.' },
    import_job_not_found: { status: 404, message: 'Importação não encontrada.' },
    import_not_resumable: { status: 409, message: 'Esta importação não aguarda ajustes.' },
    import_source_invalid: { status: 400, message: 'Arquivo inválido ou corrompido.' },
    import_entry_required: { status: 400, message: 'Escolha qual arquivo HTML é a página principal.' },
    import_needs_resolution: { status: 409, message: 'Esta importação foi analisada pela versão antiga do importador. Reprocesse para concluir automaticamente.' },
    import_failed: { status: 500, message: 'A importação falhou. Tente enviar o arquivo de novo.' },
    import_storage_failed: { status: 503, message: 'Falha ao gravar o arquivo. Tente novamente.' },
    import_expired: { status: 410, message: 'A importação ficou parada aguardando ajustes e expirou. Envie o arquivo de novo.' },
    import_source_unavailable: { status: 410, message: 'O arquivo original desta importação não está mais guardado. Envie o arquivo de novo.' },
    import_url_invalid: { status: 400, message: 'Link inválido. Use o endereço público da página (http:// ou https://).' },
    import_url_unreachable: { status: 502, message: 'Não foi possível baixar a página desse link. Confira o endereço e tente de novo.' },
    import_url_not_html: { status: 400, message: 'O link não aponta para uma página HTML.' },
    // Edição de textos e tradução (F1b)
    revision_not_found: { status: 404, message: 'Versão da página não encontrada ou indisponível.' },
    text_edit_invalid: { status: 400, message: 'Edição de texto inválida (bloco inexistente ou texto não permitido).' },
    page_text_unsupported: { status: 422, message: 'Não foi possível ler os textos desta página (codificação não suportada).' },
    translation_not_found: { status: 404, message: 'Tradução não encontrada.' },
    translation_provider_unavailable: { status: 503, message: 'Tradução automática indisponível. Configure a chave da Anthropic no cofre (anthropic:api_key) ou ANTHROPIC_API_KEY.' },
    translation_too_large: { status: 413, message: 'A página tem texto demais para traduzir de uma vez.' },
    translation_not_ready: { status: 409, message: 'A tradução ainda não está pronta para esta ação.' },
    translation_failed: { status: 502, message: 'A tradução automática falhou. Tente de novo.' },
    // Vídeos
    video_not_found: { status: 404, message: 'Vídeo não encontrado.' },
    video_intent_invalid: { status: 400, message: 'Dados do vídeo inválidos (nome, tamanho ou formato).' },
    video_too_large: { status: 413, message: 'O vídeo deve ter até 5 GB.' },
    video_not_ready: { status: 409, message: 'O vídeo ainda não está pronto.' },
    video_ownership_mismatch: { status: 409, message: 'O vídeo no Stream não corresponde a este cadastro.' },
    video_missing_remote: { status: 409, message: 'O vídeo não foi encontrado no Cloudflare Stream.' },
    video_origins_unrestricted: { status: 409, message: 'O vídeo está sem restrição de domínio no Cloudflare Stream. Defina os domínios permitidos antes de publicar.' },
    stream_unavailable: { status: 502, message: 'Cloudflare Stream indisponível. Tente novamente.' },
    stream_not_configured: { status: 503, message: 'Cloudflare Stream não está configurado.' },
    webhook_signature_invalid: { status: 401, message: 'Assinatura do webhook inválida.' },
    webhook_invalid: { status: 400, message: 'Webhook inválido.' },
    // Domínios
    domain_not_found: { status: 404, message: 'Domínio não encontrado.' },
    domain_invalid: { status: 400, message: 'Domínio inválido.' },
    domain_reserved: { status: 400, message: 'Este domínio é reservado e não pode ser usado.' },
    domain_reserved_landinglab: { status: 400, message: 'Este domínio pertence ao LandingLab (cubipiccanti.online, landinglab.app ou um domínio já usado por uma landing) e não pode ser usado no VSL.' },
    domain_landinglab_conflict: { status: 409, message: 'Este domínio já é usado pelo LandingLab.' },
    domain_not_verified: { status: 409, message: 'O domínio ainda não foi verificado.' },
    domain_in_use: { status: 409, message: 'O domínio tem páginas publicadas. Despublique antes de remover.' },
    domain_not_suspended: { status: 409, message: 'Este domínio não está suspenso.' },
    // Publicação
    publish_check_failed: { status: 409, message: 'O projeto ainda não pode ser publicado. Veja o checklist.' },
    publish_conflict: { status: 409, message: 'O projeto mudou durante a publicação. Tente de novo.' },
    release_not_found: { status: 404, message: 'Versão publicada não encontrada.' },
    release_unavailable: { status: 409, message: 'Esta versão não pode ser restaurada (página ou vídeo indisponível).' },
    preview_not_configured: { status: 503, message: 'Prévia não configurada no servidor.' },
    // Meta Conversions API (VSL-13)
    meta_pixel_required: { status: 409, message: 'Preencha e salve o Pixel da Meta do funil antes de configurar o token da API de Conversões.' },
    meta_capi_token_invalid: { status: 400, message: 'Token da API de Conversões inválido: cole o token completo gerado no Gerenciador de Eventos (sem espaços).' },
    // Analytics
    invalid_period: { status: 400, message: 'Período inválido. Use datas ISO com início antes do fim (máx. 366 dias).' },
  },
  {
    // Códigos do VSL são contrato público sem prefixo de módulo.
    prefix: '',
    base: COMMON_CATALOG,
    include: [
      'validation_failed',
      'unauthorized',
      'cross_site_rejected',
      'not_found',
      'version_conflict',
      'constraint_conflict',
      'internal_error',
      'service_unavailable',
    ],
    overrides: {
      internal_error: 'Erro interno no VSL. Tente novamente.',
      service_unavailable: 'Serviço do VSL indisponível no momento.',
    },
  }
);

export const VSL_ERRORS = VSL_CATALOG.entries;

export type VslErrorCode = Extract<keyof typeof VSL_ERRORS, string>;

export function isVslErrorCode(value: unknown): value is VslErrorCode {
  return VSL_CATALOG.has(value);
}

/** Cria um VslError com código estável; `message` opcional substitui a mensagem padrão. */
export function vslError(code: VslErrorCode, details?: unknown, message?: string): VslError {
  const entry = VSL_ERRORS[code];
  return new VslError(message ?? entry.message, entry.status, code, details);
}

export interface VslErrorBody {
  code: VslErrorCode;
  message: string;
  details?: unknown;
  /** @deprecated alias de `message` para a UI antiga; será removido na F3. */
  error: string;
}

export function vslErrorBody(code: VslErrorCode, details?: unknown, message?: string): VslErrorBody {
  const text = message ?? VSL_ERRORS[code].message;
  return { code, message: text, ...(details === undefined ? {} : { details }), error: text };
}

/** Converte qualquer erro em {status, body}. VslError sem código cai por status (compat 'vsl'). */
export function toVslErrorResponse(error: unknown): { status: number; body: VslErrorBody } {
  const { status, body } = toErrorResponse(error, { catalogs: [VSL_CATALOG], compat: 'vsl' });
  return { status, body: body as VslErrorBody };
}
