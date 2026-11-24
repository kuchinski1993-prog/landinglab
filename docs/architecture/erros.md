# Erros da API — catálogo e formato da resposta (`@blackshop/errors`)

Fonte da verdade: `packages/errors/src/common.ts` (catálogo comum) e o catálogo de cada módulo
(ex.: `apps/api/src/lib/plataforma-errors.ts`). Testes de documentação falham nos **dois sentidos**:
código sem linha nesta página **ou** linha nesta página sem código no catálogo
(`packages/errors/src/__tests__/errors-doc.test.ts` e `apps/api/src/__tests__/errors-doc.test.ts`).

O VSL Hosting usa o mesmo pacote, mas tem catálogo e doc próprios: `docs/vsl/api-errors.md`.

## Formato da resposta

Toda rota que adotou o pacote responde erros assim:

```json
{ "code": "plataforma.job_not_found", "message": "Job não encontrado.", "error": "Job não encontrado." }
```

- `code`: estável. **A tela decide pelo `code`**, nunca pelo texto.
- `message`: PT-BR, pronta para exibir. Pode ser mais específica que a da tabela quando a rota
  passa a mensagem explicitamente (`catalog.error(code, details, 'Mensagem específica.')`).
- `details` (opcional): contexto estruturado. Em erro de validação de schema é a **lista** de erros
  do Fastify; em UUID malformado é `{ "reason": "invalid_id" }`. Erro inesperado (500) **nunca**
  traz `details`.
- `error`: alias **deprecado** de `message` (o backoffice antigo lê `error`). Continua até a 18.1b.
- `statusCode`: só nos códigos legados `UPSTREAM_*` (contrato da story 0.8).
- `correlationId` (opcional, Story 18.4): o "código para suporte" — o mesmo valor do header
  `X-Correlation-Id` e do campo `correlationId` dos logs. Só em rotas não protegidas; ver
  `docs/architecture/observabilidade.md`.

O que nunca aparece no corpo: `error.message` de exceção desconhecida, stack, nome de classe,
texto do driver do banco ou texto livre em inglês. O erro real vai para o log
(`request.log.error({ err, code })`).

## Mapeamento automático (handlers novos)

| Situação | HTTP | `code` |
|---|---|---|
| Validação de schema do Fastify | 400 | `validation_failed` (`details` = lista de erros) |
| UUID/valor malformado no Postgres (`22P02`) | 400 | `validation_failed` (`details.reason = "invalid_id"`) |
| Unicidade/FK/CHECK no Postgres (`23505`/`23503`/`23514`) | 409 | `constraint_conflict` |
| Corpo acima do limite (`FST_ERR_CTP_BODY_TOO_LARGE`) | 413 | `validation_failed` (`details.reason = "payload_too_large"`) |
| Tipo de conteúdo não suportado (`FST_ERR_CTP_INVALID_MEDIA_TYPE`) | 415 | `validation_failed` (`details.reason = "unsupported_media_type"`) |
| 404 do Fastify | 404 | `not_found` |
| 429 do rate-limit da BlackShop | 429 | `rate_limited` |
| Outro 4xx do Fastify | o mesmo | 401 → `unauthorized`; 403 → `forbidden`; 404 → `not_found`; 405 → `method_not_allowed`; 409 → `constraint_conflict`; **demais 4xx (400, 406, 422…) → `validation_failed`** |
| Terceiro não respondeu no prazo (`err.code = UPSTREAM_TIMEOUT`) | 504 | `UPSTREAM_TIMEOUT` |
| Terceiro limitou as chamadas (`err.code = UPSTREAM_RATE_LIMITED`) | 503 | `UPSTREAM_RATE_LIMITED` (+ `details.retryAfterSeconds` e header `Retry-After` quando houver) |
| Terceiro fora (5xx/rede esgotados; `err.code = UPSTREAM_UNAVAILABLE`) | 503 | `UPSTREAM_UNAVAILABLE` |
| Terceiro recusou (4xx ≠ 429; `err.code = UPSTREAM_REJECTED`) | 502 | `UPSTREAM_REJECTED` |
| `AppError` com código fora de qualquer catálogo | o do erro | o do erro, com a mensagem genérica do status (log `error_code_not_in_catalog`) |
| Qualquer outra exceção | 500 | `internal_error` |

Outros SQLSTATE (`23502`, `22001`…) ainda caem em 500 — follow-up registrado na story 18.1.

## Catálogo comum

| code | HTTP | message (PT-BR) | Quando usar |
|---|---|---|---|
| `validation_failed` | 400 | Dados inválidos na requisição. | Entrada inválida (schema, id malformado, corpo grande, mídia não suportada) |
| `unauthorized` | 401 | Sessão expirada. Faça login novamente. | Sem sessão |
| `cross_site_rejected` | 403 | Requisição de outra origem bloqueada. | Mutação de outra origem |
| `forbidden` | 403 | Você não tem permissão para esta ação. | 403 genérico (Fastify/`AppError` sem código) — Story 18.11 |
| `method_not_allowed` | 405 | Método não permitido para este endereço. | 405 do Fastify — Story 18.11 |
| `not_found` | 404 | Recurso não encontrado. | Recurso genérico inexistente |
| `version_conflict` | 409 | O item foi alterado por outra ação. Recarregue e tente de novo. | Concorrência otimista |
| `constraint_conflict` | 409 | A alteração conflita com dados existentes. | Unicidade/FK/CHECK |
| `rate_limited` | 429 | Muitas requisições. Aguarde alguns instantes e tente de novo. | Limite da própria BlackShop |
| `internal_error` | 500 | Erro interno. Tente novamente. | Erro inesperado |
| `service_unavailable` | 503 | Serviço indisponível no momento. Tente novamente em instantes. | Dependência interna fora |
| `UPSTREAM_TIMEOUT` | 504 | O serviço externo não respondeu a tempo. Tente novamente em instantes. | Legado (0.8): Shopify/Meta sem resposta |
| `UPSTREAM_RATE_LIMITED` | 503 | O serviço externo está recebendo muitas requisições. Tente novamente em instantes. | Legado (0.8): terceiro respondeu 429 (não é limite do cliente da BlackShop) |
| `UPSTREAM_UNAVAILABLE` | 503 | O serviço externo está indisponível no momento. Tente novamente em instantes. | Família `UPSTREAM_*` (18.2): terceiro com 5xx ou falha de rede depois das tentativas permitidas |
| `UPSTREAM_REJECTED` | 502 | O serviço externo recusou a requisição. Verifique a configuração da integração. | Família `UPSTREAM_*` (18.2): terceiro respondeu 4xx (≠ 429) — token, permissão ou dado inválido |

## Módulo `plataforma`

| code | HTTP | message (PT-BR) | Onde aparece |
|---|---|---|---|
| `plataforma.job_id_required` | 400 | Informe o id do job. | `GET /jobs/:id` sem id |
| `plataforma.job_not_found` | 404 | Job não encontrado. | `GET /jobs/:id` de outro store ou inexistente |
| `plataforma.job_load_failed` | 500 | Não foi possível carregar o job. Tente novamente. | `GET /jobs/:id` com falha no banco |
| `plataforma.jobs_list_failed` | 500 | Não foi possível listar os jobs. Tente novamente. | `GET /jobs` com falha no banco |
| `plataforma.job_unclassified` | 500 | A tarefa falhou por um motivo ainda não classificado. A equipe vai analisar. | `job_runs.error_code` de falha que nenhuma regra reconheceu (tratada como transitória até a última tentativa — Story 18.3) |
| `plataforma.job_enqueue_failed` | 503 | Não foi possível agendar a tarefa. Tente de novo. | `enqueueDurable` com o Redis fora: linha `queued_failed` em `job_runs` e `JobEnqueueError` (Story 18.3) |
| `plataforma.store_not_found` | 404 | Loja não encontrada. | `GET/PATCH /stores/:id/modules[/:module]` com loja inexistente (Story 19.3a); `X-Store-Id` de loja inexistente em qualquer rota não isenta (Story 17.2a — `docs/architecture/isolamento-de-loja.md`) |
| `plataforma.store_inactive` | 409 | Esta loja está desativada. | `X-Store-Id` de loja desativada em qualquer rota não isenta (Story 17.2a); `GET /storefront/store-by-host` com o domínio de uma loja desativada (Story 23.1a — a vitrine responde `/loja-indisponivel` 503) |
| `plataforma.store_host_ambiguous` | 409 | Este domínio está cadastrado em mais de uma loja. | `GET /storefront/store-by-host` com um host cadastrado em duas lojas ativas (Story 23.1a — a vitrine responde `/loja-indisponivel` 503, nunca a `default`) |
| `plataforma.module_unknown` | 404 | Módulo não existe no registro. | `PATCH /stores/:id/modules/:module` com id fora de `@blackshop/shared/modules` |
| `plataforma.module_always_on` | 409 | Este módulo é sempre ligado e não pode ser desligado. | `PATCH` em módulo `alwaysOn` (`sistema`) |
| `plataforma.module_disabled` | 404 | Módulo não habilitado para esta loja. | Gate `requireModuleEnabled` (apps/api/src/modules/base.ts) — inerte: nenhuma rota o usa ainda |

Os códigos `plataforma.job_*` acima vêm de `packages/jobs/src/catalog.ts` (`JOB_ERRORS`) e também entram no
catálogo `plataforma` da API. Guia de jobs duráveis: `docs/architecture/jobs-duraveis.md`.

## Módulo `loja` (jobs)

Códigos gravados em `job_runs.error_code` pelos processors que adotaram `@blackshop/jobs`
(`packages/jobs/src/catalog.ts`, `LOJA_JOB_ERRORS`). Ainda não são respostas HTTP de rota.

| code | HTTP | message (PT-BR) | Onde aparece |
|---|---|---|---|
| `loja.relink_product_not_found` | 404 | Produto não encontrado para religar as cores. | `relink-colors-queue`: produto apagado depois do enfileiramento (determinístico) |
| `loja.relink_source_unavailable` | 503 | A loja de origem não respondeu. A tarefa será repetida. | `relink-colors-queue`: extração com timeout/falha de rede (transitório) |
| `loja.relink_source_rejected` | 422 | A loja de origem não devolveu o produto (página inexistente ou resposta inválida). | `relink-colors-queue`: extração com `NOT_FOUND`/`INVALID_RESPONSE` (determinístico) |
| `loja.relink_source_empty` | 422 | A loja de origem não devolveu dados do produto. | `relink-colors-queue`: extração vazia ou `duplicate` (determinístico) |
| `loja.relink_publish_enqueue_failed` | 503 | Não foi possível agendar a republicação na Shopify. A tarefa será repetida. | `relink-colors-queue`: falha ao enfileirar o `publish` (transitório) |
| `loja.reconcile_too_soon` | 409 | A Shopify ainda está processando o produto anterior. Aguarde 2 minutos e republique. | `publish-queue`: reconciliação sem achados (tag + SKU) menos de 2 min depois de um resultado incerto — não recria (a busca da Shopify indexa com atraso; determinístico) |
| `loja.reconcile_tag_not_removed` | 502 | Não foi possível remover o marcador de reconciliação do produto na Shopify. | Log do adapter/`publish-queue` quando o `tagsRemove` do marcador `bs-product-<id>` falha (o publish tenta de novo antes de publicar nos canais) |
| `loja.mirror_ambiguous` | 409 | Há mais de um produto na Shopify com o mesmo SKU. Confira na Shopify antes de republicar. | `publish-queue`: reconciliação por SKU antes de recriar achou mais de 1 produto (determinístico; produto fica `out_of_sync`) |
| `loja.job_store_mismatch` | 409 | A tarefa pertence a outra loja e não foi executada. Nada foi alterado. | `publish-queue`, `rewire-mirror-queue`, `rewire-variant-media-queue` e `image-queue` (`DownloadImageJob`): `storeId` do payload diferente da loja do produto — falha antes de qualquer escrita ou chamada à Shopify (determinístico, sem retry; Story 17.2b) |
| `loja.orders_backfill_invalid_input` | 400 | Pedido de importação de pedidos inválido (loja ou número de dias). | `orders-backfill-queue`: `sinceDays` não positivo ou `storeId` vazio (determinístico, sem retry; Story 18.5) |
| `loja.orders_backfill_not_configured` | 503 | A integração com a Shopify não está configurada (domínio ou credenciais ausentes no Vault). | `orders-backfill-queue`: `shopify.store_domain` ou credencial do app ausente no Vault (determinístico, sem retry) |
| `loja.orders_backfill_source_rejected` | 422 | A Shopify recusou a consulta de pedidos (credencial inválida, sem permissão ou loja inexistente). | `orders-backfill-queue`: Admin API respondeu 401/403/404 ou outro 4xx (determinístico, sem retry) |
| `loja.orders_backfill_source_unavailable` | 503 | A Shopify não respondeu à consulta de pedidos. A tarefa será repetida. | `orders-backfill-queue`: 429/5xx/timeout/rede esgotados na página (transitório; `failed` só na última tentativa; o retry retoma da página que falhou) |

## Módulo `loja` (rotas)

Respostas HTTP dos webhooks Shopify, de pedidos no painel, do checkout e das variantes de produto
(`apps/api/src/lib/loja-errors.ts`, `LOJA_ERRORS`, Story 18.5; variantes: Story 18.6a). Mesmo módulo dos códigos de jobs acima.

| code | HTTP | message (PT-BR) | Onde aparece |
|---|---|---|---|
| `loja.webhook_invalid_signature` | 401 | Assinatura do webhook inválida. | `POST /webhooks/shopify/*` sem `rawBody` ou com HMAC inválido |
| `loja.webhook_invalid_payload` | 400 | Corpo do webhook inválido. | `POST /webhooks/shopify/*` assinado com JSON inválido ou sem o id (`details.reason` = `invalid_json` \| `order_id_required` \| `dispute_id_required`) |
| `loja.webhook_persist_failed` | 503 | Não foi possível gravar o webhook agora. A Shopify vai reenviar. | `orders/updated`, `fulfillments/update`, `disputes/*` com falha **transitória** de banco; tentativa `failed` em `webhook_delivery_attempts` (a Shopify reenvia) |
| `loja.webhook_payload_rejected` | 422 | O banco rejeitou o dado do webhook (dado inválido). Falha registrada; reenviar não adianta. | Mesmos tópicos, falha **permanente** (Postgres classe 22/23, data inválida). A resposta HTTP é **200** `{ status: 'rejected', code, ... }` — 5xx repetido faria a Shopify remover a assinatura; o 422 é só a classe do erro (log e `error_code` da tentativa) |
| `loja.order_not_found` | 404 | Pedido não encontrado. | `GET /admin/orders/:id` inexistente ou de outra loja |
| `loja.cart_invalid` | 400 | Carrinho inválido. Revise os itens e tente de novo. | `POST /checkout` com mais de 100 linhas, `qty` fora de 1..999 ou linha malformada (`details.maxLines`/`maxQty`) |
| `loja.cart_empty` | 400 | O carrinho está vazio. | `POST /checkout` sem `cartItems` ou com lista vazia |
| `loja.checkout_variants_unavailable` | 422 | Alguns produtos do carrinho ainda não estão disponíveis para pagamento. | `POST /checkout` com variante desconhecida, sem espelho na Shopify ou de outra loja; `details.missingVariants` + campo legado `missing_variants` no topo (vitrine antiga) |
| `loja.checkout_not_configured` | 503 | O checkout da loja ainda não está configurado. | `POST /checkout` sem credencial da Shopify no Vault (antes: 503 em inglês) |
| `loja.checkout_disabled` | 409 | O checkout desta loja ainda não está habilitado. | `POST /checkout` de loja ≠ `default` sem `stores.settings.checkoutEnabled === true` (ausente, `false` ou texto), **antes** de variantes/Vault/Shopify — fail-closed porque as credenciais do checkout ainda são globais (17.3); não há interruptor no painel, quem liga é a 17.8. A `default` não consulta. Falha de banco nessa leitura → `service_unavailable` (503). A vitrine decide a mensagem pelo `code` (Story 17.4a) |
| `loja.checkout_out_of_stock` | 422 | Uma ou mais peças do carrinho esgotaram. Revise o carrinho e tente de novo. | `POST /checkout` de loja ≠ `default`: o servidor recalcula a disponibilidade de cada linha (`resolveLineFulfillment`, quantidade pedida) e alguma ficou `sold_out`; `details.variantIds` traz as variantes afetadas. Nada é enviado ao checkout. A `default` não recalcula (Story 23.3 PR2) |
| `loja.checkout_failed` | 502 | Não foi possível iniciar o pagamento. Tente de novo. | `POST /checkout` com erro inesperado (banco, Vault, bug; antes: 500 em inglês). A vitrine decide a mensagem pelo `code` (`apps/storefront/src/lib/checkout-errors.ts`) |
| `loja.support_address_invalid` | 400 | Endereço de suporte inválido. Use nome@dominio.com ou @dominio.com (até 254 caracteres). | `POST/PATCH/DELETE /stores/:id/support-addresses[/:address]` com formato inválido ou principal que não é endereço exato (`details.reason` = `invalid_format` \| `primary_must_be_address`; Story 17.6b) |
| `loja.domain_taken` | 409 | Este endereço já pertence a outra loja. Use outro domínio ou remova-o da outra loja primeiro. | `PUT /settings/storefront-domain` numa loja ≠ `default` com domínio já cadastrado em outra loja (inclusive a `default`, sem caixa) — nunca "rouba"; nada gravado (Story 17.3b) |
| `loja.support_address_taken` | 409 | Este endereço de suporte já pertence a outra loja. | `POST /stores/:id/support-addresses` com endereço/padrão já cadastrado em outra loja — nunca "rouba" (Story 17.6b) |
| `loja.support_address_protected` | 409 | Este endereço de suporte está protegido e não pode ser removido ou trocado por aqui. | `details.reason` = `default_store_routing` (mover/remover o principal ou remover o padrão de domínio da `default` — decisão do owner, script manual: `docs/runbooks/atendimento-endereco-por-loja.md`) \| `primary_in_use` (remover o principal de uma loja que tem outro endereço exato — troque o principal antes; Story 17.6b) |
| `loja.atendimento_not_configured` | 409 | O Atendimento desta loja ainda não está configurado. Nada foi enviado ao cliente — complete a configuração. | `POST /inbox/:id/manual-reply\|auto-reply\|instructed-reply` de loja ≠ `default` sem config completa (`details.missing[]`, `details.invalid`, `details.configLink`); `POST /admin/store/atendimento/templates/seed` sem nome da marca. Nada é enfileirado (fail-safe; Story 17.6c) |
| `loja.atendimento_sender_domain` | 400 | O remetente precisa usar um domínio da loja (de um endereço de suporte da loja ou do domínio da loja). | `PUT /admin/store/atendimento` com `sender.fromAddress` fora dos domínios da loja (`details.allowedDomains`; Story 17.6c) |
| `loja.variants_required` | 400 | O produto precisa de pelo menos uma variante. Nada foi alterado. | `PATCH /products/:id/variants` com `variants: []` — antes apagava todas as variantes; as existentes continuam (Story 18.6a) |
| `loja.variant_price_required` | 400 | Informe o preço de todas as variantes. | `PATCH /products/:id/variants` com `price` ausente, `null` ou vazio (`details.index` = posição da variante); nada gravado, nunca `'0'` por omissão (Story 18.6a) |
| `loja.variant_price_invalid` | 400 | Preço de variante inválido. Use só números com ponto e até 2 casas decimais (ex.: 129.90). | `PATCH /products/:id/variants` com preço fora de `^\d{1,9}(\.\d{1,2})?$` (`"abc"`, `"-5"`, `"10,5"`, `"1e3"`, `"10.999"`; `details.index`). `"0"` é válido (brinde); nada gravado (Story 18.6a) |
| `loja.fulfillment_invalid` | 422 | Disponibilidade ou prazo inválido. O prazo de produção é um número inteiro de 1 a 365 dias. Nada foi gravado. | `PATCH /products/:id` com `fulfillment_policy` fora de `stock_only`/`stock_then_made_to_order`/`made_to_order_only` ou `lead_time_days` que não é inteiro de 1 a 365 nem `null`; `PATCH /products/:id/variants` com `lead_time_days` inválido numa variante (`details.field`, `details.index`). Nada gravado (Story 23.3) |
| `loja.fulfillment_lead_time_required` | 422 | Informe o prazo de produção (dias) do produto ou de todas as variantes para vender sob encomenda. Nada foi gravado. | `PATCH /products/:id` ou `/variants` que deixaria um produto com política ≠ `stock_only` sem prazo no produto e sem prazo em todas as variantes (decisão 75). Nada gravado (Story 23.3) |
| `loja.custom_field_invalid` | 422 | Campo personalizado inválido. Confira o nome, o tipo, as opções e o valor. Nada foi gravado. | `POST/PUT /admin/custom-fields[/:id]` com chave fora de `^[a-z][a-z0-9_]{1,40}$`, rótulo vazio ou > 80, tipo fora dos 5, opções fora dos limites (`details.reason`, `details.field`); `PUT /admin/products/:id/custom-values` com chave desconhecida ou valor que não bate com o tipo (`details.key`, `details.reason`) — tudo ou nada (Story 23.4) |
| `loja.custom_field_limit` | 422 | A loja já tem 20 campos personalizados (o máximo). Exclua um antes de criar outro. | `POST /admin/custom-fields` com a loja já em 20 definições (Story 23.4) |
| `loja.custom_field_duplicate` | 409 | Já existe um campo personalizado com esta chave nesta loja. | `POST`/`PUT /admin/custom-fields` com `key` já usada na loja (Story 23.4) |
| `loja.custom_field_in_use` | 409 | Este campo já tem valores em produtos: a chave, o tipo e as opções usadas não podem mudar. Crie outro campo ou apague os valores antes. | `PUT /admin/custom-fields/:id` trocando `key`/`type` com valores gravados, ou removendo de uma lista opção que algum produto usa (`details.reason`, `details.options`) (Story 23.4) |
| `loja.profit_unavailable` | 503 | Não foi possível calcular o lucro agora. Nenhum número parcial foi mostrado — tente de novo em instantes. | `GET /admin/store/profit` com falha ou estouro de tempo do banco (3 s por instrução); nunca devolve número parcial (Story 21.3) |
| `loja.profit_config_too_large` | 422 | A configuração de custos passou do limite (2.000 produtos, 800 dias de anúncios ou 400 KB). Nada foi gravado. | `PUT /admin/store/profit/settings` que deixaria `stores.settings.profit` acima dos tetos (`details.limit`); a fase 2 cria tabela própria (Story 21.3) |

Falha de banco em `GET /admin/orders[/:id]` e em `POST /cart/validate` responde `service_unavailable` (503, comum).

`PATCH /products/:id/variants`, `DELETE /products/:id/hard` e `DELETE /products/hard-bulk` (Story 18.6a) usam os
códigos comuns: id malformado → `validation_failed` (400, `details.reason = "invalid_product_id"`; no `hard-bulk`,
quando nenhum id é UUID); corpo fora do schema → `validation_failed` (`details` = lista de erros); produto
inexistente ou de outra loja → `not_found` (404, nada alterado — no `hard-bulk` o id de outra loja só não conta em
`deleted`); falha de banco → `internal_error` (500, `productId`/`productIds` no log). A exclusão definitiva responde
`storageCleanup: 'ok' | 'failed' | 'skipped'` (aditivo): `failed` = o Storage não confirmou (5xx/4xx/timeout/rede;
`warn` com `count`/`status`), a exclusão no banco continua valendo; `skipped` = nada a apagar ou Storage não
configurado. As demais rotas de `products.routes.ts` seguem como estão (18.6a-2 e seguintes).

`GET /store/settings` e `PUT /admin/store/settings` (Story 17.4a) não têm código próprio: a loja é a do `X-Store-Id` (inexistente → `plataforma.store_not_found`, inativa → `plataforma.store_inactive`, formato inválido → `validation_failed` `invalid_store_id`); corpo do `PUT` com campo desconhecido (inclusive `checkoutEnabled`), `currency`/`locale` fora da lista ou `timezone` inválido → `validation_failed` (400) com `details.field` e `details.reason` (`unknown_field` \| `unsupported_currency` \| `unsupported_locale` \| `invalid_timezone` \| `invalid_type` \| `invalid_body`), nada gravado. `POST /stores` com região inválida → o mesmo `validation_failed`, nenhuma loja criada.

`GET /admin/store/atendimento/readiness` (Story 17.6d) não tem código próprio: sem sessão → `unauthorized` (401), `X-Store-Id` inexistente → `not_found` (404, validação da 17.2a); falha de banco ou do Resend num item vira `status: 'unknown'` naquele item (200) — nunca 5xx por causa de um item.

`error_code` **informativo** (não é resposta de erro): `loja.order_not_found_for_update` — gravado na
tentativa `processed` quando `orders/updated`/`fulfillments/update` chega para pedido que não está em
`orders` (normal: `orders` só guarda pedidos pagos). O webhook responde 200.

## Módulo `marketing` (jobs)

Códigos do envio de eventos à Meta pela fila durável `marketing-capi-queue` (Story 18.8 —
`packages/jobs/src/catalog.ts`, `MARKETING_JOB_ERRORS`; guia `docs/architecture/marketing-capi.md`).
Gravados em `job_runs.error_code` e em `tracking_events.payload.job_error_code` (lido pelo painel
`GET /tracking/health`). Ainda não são respostas HTTP de rota. O código histórico do envio
(`INTEGRATION_MODE_UNSET`, `UPSTREAM_TIMEOUT`, `META_GRAPH_API_VERSION_INVALID`…) continua em
`payload.error_code`.

| code | HTTP | message (PT-BR) | Onde aparece |
|---|---|---|---|
| `marketing.capi_unavailable` | 503 | A Meta não respondeu ao envio do evento. A tarefa será repetida. | Timeout, rede, HTTP 5xx/429 ou erro da Meta com `is_transient: true`/código de limite (`4`, `17`, `32`, `613`, `80004` — mesmo em HTTP 400). Transitório: a linha fica `retrying` e só vira `failed` na 6ª tentativa |
| `marketing.capi_token_rejected` | 422 | A Meta recusou o token da Conversions API. Corrija o token da Meta nas configurações do pixel. | Erro da Meta `190`/`102` (token inválido/expirado) ou `10`/`200`–`299` (permissão). Determinístico, sem retry; o painel mostra "Corrigir o token da Meta" → `/settings/loja/pixel` |
| `marketing.capi_event_rejected` | 422 | A Meta recusou o evento (dado inválido, pixel inexistente ou versão da API). Reenviar não adianta. | Demais 4xx da Meta (evento mal formado, pixel inexistente, versão da Graph API inexistente). Determinístico, sem retry |
| `marketing.capi_not_configured` | 503 | O pixel, o token ou o modo da Conversions API da Meta não está configurado para esta loja. | Linha sem pixel, token ausente/ilegível no Vault, `META_CAPI_MODE` ausente em produção (`payload.error_code` = código do modo) ou `META_GRAPH_API_VERSION` fora do formato `vNN.0`. Determinístico, sem retry |
| `marketing.capi_out_of_window` | 422 | O evento tem mais de 7 dias e a Meta não aceita mais o envio. | Reenvio de evento cujo `event_time` original passou da janela de 7 dias (com 1 h de folga). Determinístico, sem retry |
| `marketing.catalog_unavailable` | 503 | A Meta não respondeu ao envio dos itens do catálogo. A tarefa será repetida. | Story 24.4: items_batch / check_batch_request_status com 429, 5xx, limite da Meta (4, 17, 32, 613, 80004, 80009, 80014), timeout ou rede. Transitório (5 tentativas, backoff 30 s); na última, os itens viram `error` |
| `marketing.catalog_token_rejected` | 422 | A Meta recusou o token do catálogo. Salve um token novo nas configurações do catálogo. | Story 24.4: erro 102/190, permissão (10, 200–299) ou HTTP 401/403. Conexão vira `error` e evento `connection_error`. Determinístico |
| `marketing.catalog_rejected` | 422 | A Meta recusou o lote de itens do catálogo (dado inválido ou catálogo inexistente). Reenviar não adianta. | Story 24.4: items_batch recusado inteiro (ex.: erro 100). Itens viram `error` com a mensagem da Meta (sem token). Determinístico |
| `marketing.catalog_not_configured` | 503 | O catálogo não tem conexão com a Meta configurada (id do catálogo ou token ausente). | Story 24.4: chave do token sem segredo no Vault ou `META_GRAPH_API_VERSION` fora de `vNN.0`. Determinístico |

## Módulo `marketing` (rotas)

Códigos das rotas admin dos catálogos Meta (Story 24.1 —
`apps/api/src/modules/marketing/lib/marketing-errors.ts`, `MARKETING_ERRORS`; rotas
`/admin/meta-catalogs*`). O feed público `GET /public/meta-catalogs/:token.xml` não usa o envelope:
token inexistente, rotacionado ou de catálogo pausado responde 404 sem corpo.

| code | HTTP | message (PT-BR) | Onde aparece |
|---|---|---|---|
| `marketing.catalog_not_found` | 404 | Catálogo não encontrado. | Id inexistente, malformado ou de outra loja (`X-Store-Id`) em qualquer rota `/admin/meta-catalogs/:id*` |
| `marketing.catalog_item_not_found` | 404 | Item do catálogo não encontrado. | `PATCH`/`DELETE /admin/meta-catalogs/:id/items/:itemId` com item inexistente ou de outro catálogo |
| `marketing.catalog_source_not_found` | 404 | A origem do catálogo (landing ou produto) não foi encontrada. | Criação com `sourceRef` inexistente ou de outra loja; `items/from-source` quando a origem sumiu |
| `marketing.catalog_source_manual` | 409 | Este catálogo é manual e não tem origem para importar itens. | `POST /admin/meta-catalogs/:id/items/from-source` em catálogo `manual` |
| `marketing.catalog_source_without_image` | 422 | A origem não tem imagem. Adicione uma imagem real antes de criar o item. | `items/from-source` com landing/produto sem nenhuma imagem https (nunca há imagem padrão) |
| `marketing.catalog_destination_invalid` | 400 | URL de destino inválida. Use um endereço https:// público. | Destino do item ou destino padrão do catálogo que não é `https://`, aponta para IP/host privado ou resolve para rede privada |
| `marketing.catalog_destination_required` | 422 | Informe a URL de destino de cada item. | Confirmação de `items/from-source` para item sem URL na origem e sem `destinationUrl` informado |
| `marketing.catalog_retailer_id_taken` | 409 | Já existe um item com este ID no catálogo. | Criação de item (manual ou da origem) com `retailerId` já usado no catálogo |
| `marketing.catalog_reorder_mismatch` | 400 | A nova ordem precisa conter exatamente os itens do catálogo. | `POST /admin/meta-catalogs/:id/items/reorder` com lista faltando, sobrando ou repetindo itens |
| `marketing.catalog_media_type_invalid` | 400 | Tipo de arquivo não aceito. Imagem: JPEG, PNG ou WebP. Vídeo: MP4 ou MOV. | `media/upload-url` com `contentType` fora da lista, ou `commit` cujo arquivo enviado não é do tipo declarado (bytes conferidos) |
| `marketing.catalog_media_too_large` | 413 | Arquivo grande demais. Imagem até 8 MB; vídeo até 200 MB. | `media/upload-url` com `size` acima do limite do tipo |
| `marketing.catalog_media_too_small` | 422 | A imagem precisa ter pelo menos 500×500 px. | `media/commit` de imagem com largura ou altura abaixo de 500 px (mínimo da Meta) |
| `marketing.catalog_media_not_found` | 404 | Arquivo não encontrado. Envie o arquivo de novo. | `media/commit` ou `items/media-batch` com `objectKey` desconhecida, de outro catálogo, já confirmada em outro slot incompatível, ou sem upload concluído |
| `marketing.catalog_media_mismatch` | 422 | O arquivo enviado não confere com o tamanho ou o tipo informado. Envie de novo. | `media/commit` quando o objeto no storage tem tamanho/tipo diferente do declarado no `upload-url` (o objeto é apagado) |
| `marketing.catalog_media_slot_invalid` | 400 | Este arquivo não pode ser usado nesse lugar do item. | `slot` de imagem com arquivo de vídeo, ou `video` com arquivo de imagem |
| `marketing.catalog_media_limit` | 422 | O item já tem o máximo de imagens (11). | `media/commit` com `slot: additional_image` em item que já tem 11 imagens |
| `marketing.catalog_batch_items_invalid` | 422 | Há itens marcados que não pertencem a este catálogo. | `POST /admin/meta-catalogs/:id/items/media-batch` com `itemIds` de outro catálogo, de outra loja ou inexistentes (nada é gravado) |
| `marketing.catalog_media_storage_unavailable` | 503 | Armazenamento de mídia indisponível. Tente de novo em instantes. | Credenciais do Supabase ausentes no Vault ou falha do Storage ao assinar/conferir/apagar o arquivo |
| `marketing.catalog_token_required` | 422 | Cole o token do usuário de sistema da Meta para conectar o catálogo. | `PUT /admin/meta-catalogs/:id/connection` sem `token` num catálogo que ainda não tem token no Vault (Story 24.4) |
| `marketing.catalog_connection_rejected` | 422 | A Meta recusou a conexão: confira o ID do catálogo e se o token tem a permissão catalog_management. | Teste de conexão (`GET /{catalog_id}?fields=id,name`) recusado pela Meta: token inválido/expirado, sem permissão ou catálogo inexistente. O token não é gravado |
| `marketing.catalog_connection_unavailable` | 503 | A Meta não respondeu ao teste de conexão. Tente de novo em instantes. | Teste de conexão com 5xx, 429/limite de chamadas, timeout ou rede. O token não é gravado |
| `marketing.catalog_not_connected` | 409 | Conecte o catálogo à Meta (ID do catálogo e token) antes de sincronizar. | `POST /admin/meta-catalogs/:id/sync`, `POST .../connection/test` ou `pushEnabled: true` sem conexão salva |
| `marketing.catalog_sync_unavailable` | 503 | Não foi possível agendar o envio agora. Os itens ficaram pendentes e serão enviados em alguns minutos. | `POST /admin/meta-catalogs/:id/sync` com a fila (Redis) fora: os itens já estão `pending` e a varredura do worker (5 min) reenfileira |

## Módulo `cambio`

Fonte: `packages/errors/src/cambio.ts` (Story 0.7c). Códigos `FX_*` com nome preservado (`prefix: ''`,
`legacy: true`), porque já são gravados assim em `fx_rate_history.error_code` e `fx_sync_runs.summary`.
Os demais `FX_*` ainda não migraram para o catálogo.

| code | HTTP | message (PT-BR) | Onde aparece |
|---|---|---|---|
| `FX_DOUBLE_CONVERSION` | 409 | A regra de câmbio converte para a moeda da própria loja; o preço já está nessa moeda e não é convertido de novo. | Price-sync: regra ativa com `target_currency` = `stores.settings.currency` (ex.: loja EUR + regra USD→EUR) é pulada; se todas forem assim, o produto conta `skipped` com esse `errorCode` (sem `price_sync_status = 'error'`), senão vai para `summary.warnings.fx_double_conversion`. Refresh: run `failed` com `summary.fatalError = 'FX_DOUBLE_CONVERSION'` + notificação `fx_double_conversion` (uma por loja enquanto não lida) |

## Códigos legados

Contratos anteriores ao padrão `modulo.codigo`, já consumidos por testes, script e vitrine. **Não mudam**
(fora dos catálogos; sem crase na primeira coluna para o teste de documentação não cobrá-los de um catálogo).

| code | HTTP | message (PT-BR) | Onde aparece |
|---|---|---|---|
| ORDER_PERSIST_FAILED | 503 | Não foi possível gravar o pedido agora. A Shopify vai reenviar este webhook. | `orders/paid` com falha transitória de banco (Story 0.2) |
| ORDER_PAYLOAD_REJECTED | 200 | O pedido foi rejeitado pelo banco (dado inválido). Falha registrada para reprocessamento manual. | `orders/paid` com falha permanente (corpo `status: 'rejected'`; Story 0.2) |
| SHOPIFY_WEBHOOK_SECRET_MISSING | 503 | (ver `lib/shopify-webhook-secret.ts`) | Segredo do webhook ausente — falha fechada (Story 0.3) |
| SHOPIFY_WEBHOOK_SECRET_UNAVAILABLE | 503 | (ver `lib/shopify-webhook-secret.ts`) | Vault indisponível ao ler o segredo (Story 0.3) |
| SHOPIFY_MODE_NOT_CONFIGURED | 503 | (ver `lib/integration-mode.ts`) | Checkout sem modo de integração configurado (Story 0.4) |

Os `UPSTREAM_*` (0.8/18.2) estão no catálogo comum acima.

## Regra de nome

- Códigos novos: `modulo.codigo` em `snake_case` (ex.: `plataforma.job_not_found`, `loja.variant_price_required`).
  `defineCatalog` exige o prefixo `${moduleId}.` e falha na carga se faltar.
- Código duplicado entre módulos, status fora de 400–599 ou mensagem vazia falham **na carga**.
- Contratos antigos mantêm o nome: o catálogo do VSL (sem prefixo, `prefix: ''`) e os legados
  `UPSTREAM_*` (`legacy: true`). Um código **nunca** muda de significado depois de publicado.
- Um módulo pode reaproveitar códigos do comum com `include` e trocar só a **mensagem** com
  `overrides` (o VSL faz isso com `internal_error` e `service_unavailable`); trocar o status falha.

## Como adicionar um código

1. Adicione a entrada no catálogo do módulo (`defineCatalog('<modulo>', { '<modulo>.<codigo>': { status, message } })`).
   Mensagem em PT-BR, curta, dizendo o que aconteceu e, se der, o que fazer.
2. Adicione a linha `` | `<modulo>.<codigo>` | <status> | <mensagem> | <onde aparece> | `` na tabela do módulo nesta página
   (catálogo novo = seção nova). O teste de documentação aponta o que faltar.
3. Na rota: `throw CATALOGO.error('<modulo>.<codigo>', details?)` ou
   `return sendError(reply, CATALOGO, '<modulo>.<codigo>')` (`@blackshop/errors/fastify`).
4. O plugin do módulo chama `installErrorHandler(app, { catalogs: [CATALOGO] })` **dentro** do plugin
   (encapsulado). Nunca instale no app raiz: o handler global de `apps/api/src/server.ts` também
   responde Tracker e TrustShield (zonas protegidas) e continua com `{ error, statusCode }`.
