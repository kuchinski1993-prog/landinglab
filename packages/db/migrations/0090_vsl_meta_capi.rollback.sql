-- Rollback 0090_vsl_meta_capi (VSL-13 Fase A). Idempotente.
-- Apaga só o registro de envio da Meta CAPI (diagnóstico com retenção de 30 dias); nenhum dado de funil,
-- release, analytics (vsl_events) ou token (os tokens ficam em `credentials`, chave `vsl_meta_capi:<pixel>`;
-- remova-os pela API/CLI se quiser descartar também).
-- Antes do rollback, remova/desligue o envio (deploy sem VSL-13 ou sem VSL_CAPI_INTERNAL_SECRET na API),
-- senão o endpoint interno passa a responder 503 ao gravar.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f 0090_vsl_meta_capi.rollback.sql

DROP INDEX IF EXISTS vsl_meta_capi_deliveries_created_idx;
DROP INDEX IF EXISTS vsl_meta_capi_deliveries_project_time_idx;
DROP TABLE IF EXISTS vsl_meta_capi_deliveries;
