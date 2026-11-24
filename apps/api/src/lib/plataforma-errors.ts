// Story 18.1 · Catálogo do módulo "plataforma" (piloto: rotas de jobs).
// Story 18.3 · + códigos dos jobs duráveis (`plataforma.job_unclassified`, `plataforma.job_enqueue_failed`),
// definidos em @blackshop/jobs e reaproveitados aqui (mesmo módulo, mesmo status e mensagem).
// Story 19.3a · registro de módulos por loja (store_modules).
// Story 17.2a · validação do X-Store-Id (`plataforma.store_inactive`).
// Story 23.1a · loja pelo domínio (`plataforma.store_host_ambiguous`).
// Documentado em docs/architecture/erros.md — códigos nunca mudam de significado.
import { defineCatalog } from '@blackshop/errors';
import { JOB_ERROR_ENTRIES } from '@blackshop/jobs';

export const PLATAFORMA_ERRORS = defineCatalog('plataforma', {
  'plataforma.job_id_required': { status: 400, message: 'Informe o id do job.' },
  'plataforma.job_not_found': { status: 404, message: 'Job não encontrado.' },
  'plataforma.job_load_failed': { status: 500, message: 'Não foi possível carregar o job. Tente novamente.' },
  'plataforma.jobs_list_failed': { status: 500, message: 'Não foi possível listar os jobs. Tente novamente.' },
  ...JOB_ERROR_ENTRIES,
  // Story 19.3a — registro de módulos (GET/PATCH /stores/:id/modules e gate requireModuleEnabled).
  // Falha de banco ao ler/gravar store_modules usa `service_unavailable` do catálogo comum.
  'plataforma.store_not_found': { status: 404, message: 'Loja não encontrada.' },
  // Story 17.2a — X-Store-Id de uma loja desativada (store.plugin).
  'plataforma.store_inactive': { status: 409, message: 'Esta loja está desativada.' },
  // Story 23.1a — `GET /storefront/store-by-host`: domínio cadastrado em duas lojas ativas.
  'plataforma.store_host_ambiguous': { status: 409, message: 'Este domínio está cadastrado em mais de uma loja.' },
  'plataforma.module_unknown': { status: 404, message: 'Módulo não existe no registro.' },
  'plataforma.module_always_on': { status: 409, message: 'Este módulo é sempre ligado e não pode ser desligado.' },
  'plataforma.module_disabled': { status: 404, message: 'Módulo não habilitado para esta loja.' },
});
