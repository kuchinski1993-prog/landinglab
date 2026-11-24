-- Migration 0046 — L0i Architecture Improvements (Onda 1 / follow-up 0045).
--
-- Contexto:
--   HLD do L0i (@architect Aria) recomendou 3 melhorias em §16. Duas são
--   schematizadas (esta migration); a terceira (Redis sessions) é mudança
--   de infra pro @devops e não entra em migration.
--
-- Referências:
--   - HLD:       docs/architecture/l0i-landing-page-system-hld.md §16.2, §16.5
--   - Migration base: packages/db/migrations/0045_l0i_landing_page_system.sql
--   - PRD Feature F8 (isolamento de credenciais L0i vs BlackShop)
--
-- Escopo desta migration (2 melhorias aditivas):
--   1. credentials.channel        — isolamento de credenciais L0i vs BlackShop
--   2. landing_pages.sanitized_html_body / sanitized_at  — cache DOMPurify
--
-- Segurança / risco:
--   - Zero risco de quebrar código atual: credentials.channel tem default
--     'blackshop' — comportamento preexistente preservado. Todas as rows
--     existentes ficam channel='blackshop' via DEFAULT no ADD COLUMN.
--   - landing_pages.sanitized_html_body é NULLABLE — aplicação preenche
--     lazy. Se NULL ou sanitized_at < updated_at, re-sanitiza on render.
--
-- Decisões conscientes vs HLD §16.5:
--   - HLD sugeria trigger BEFORE UPDATE pra invalidar cache. Optamos por
--     invalidação em aplicação (compara sanitized_at vs updated_at) porque:
--     (a) evita trigger com lógica de app dentro do banco,
--     (b) mantém DOMPurify no runtime Node (versão consistente com o SSR),
--     (c) trigger não roda DOMPurify — só nulificaria sanitized_at, o que
--         obriga app a checar sanitized_html_body IS NULL de qualquer jeito.
--     Aplicação: no save, roda DOMPurify e grava sanitized_html_body + sanitized_at=now().
--     No render: se updated_at > sanitized_at (ou sanitized_html_body IS NULL), re-sanitiza.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. credentials.channel — isolamento L0i vs BlackShop (HLD §16.2)
-- ─────────────────────────────────────────────────────────────────────────
--
-- Motivação: hoje credentials.key é global (ex.: 'shopify.admin_api_token').
-- L0i precisa isolar suas credenciais (Stripe, Meta CAPI, Spaceship) das
-- credenciais do BlackShop/AuthenLondon pra evitar leak cross-canal no
-- backoffice. Feature F8 do PRD depende disso.
--
-- Valores:
--   - 'blackshop' (default)  — credenciais do canal AuthenLondon/Shopify
--   - 'l0i'                  — credenciais do canal L0i
--   - 'shared'               — credenciais compartilhadas (ex.: SMTP, Anthropic)
--
-- Backfill: todas as rows existentes ficam 'blackshop' automaticamente
-- via DEFAULT no ADD COLUMN — comportamento atual do backoffice preservado
-- (queries sem filtro `channel` continuam retornando o que retornavam).

ALTER TABLE "credentials"
	ADD COLUMN "channel" text NOT NULL DEFAULT 'blackshop';
--> statement-breakpoint

ALTER TABLE "credentials"
	ADD CONSTRAINT "credentials_channel_check"
	CHECK ("channel" IN ('blackshop', 'l0i', 'shared'));
--> statement-breakpoint

-- Índice composto (channel, key): queries filtradas por channel viram
-- index-only scan. Cobre padrão "listar credenciais do canal L0i no backoffice".
CREATE INDEX IF NOT EXISTS "idx_credentials_channel_key"
	ON "credentials" USING btree ("channel", "key");
--> statement-breakpoint

COMMENT ON COLUMN "credentials"."channel" IS
	'Canal proprietário da credencial: blackshop (AuthenLondon/Shopify) | l0i (L0i) | shared (SMTP, Anthropic, etc.). Isola credenciais entre canais no backoffice (F8 do PRD L0i). Default blackshop preserva comportamento pré-0046.';
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 2. landing_pages.sanitized_html_body + sanitized_at — cache DOMPurify (HLD §16.5)
-- ─────────────────────────────────────────────────────────────────────────
--
-- Motivação: DOMPurify custa 50-150ms por render em landings grandes (20k+
-- linhas de HTML). Sem cache, cada request cliente-final paga esse custo
-- no SSR (impacta LCP, especialmente em LATAM com latência maior).
--
-- Solução: cachear HTML já sanitizado no banco. Invalidação em aplicação:
--   - No save: roda DOMPurify(html_body + custom_css), grava sanitized_html_body
--     + sanitized_at = now().
--   - No render: se sanitized_html_body IS NULL OR sanitized_at < updated_at
--     → re-sanitiza e persiste (SSR hit path faz PUT no cache).
--
-- Tradeoffs:
--   - Storage 2x pro html_body (aceitável — landings têm 20-50KB de HTML).
--   - Consistência lazy: primeira request pós-update paga a re-sanitização
--     e persiste. Requests subsequentes leem cache.

ALTER TABLE "landing_pages"
	ADD COLUMN "sanitized_html_body" text;
--> statement-breakpoint

ALTER TABLE "landing_pages"
	ADD COLUMN "sanitized_at" timestamp with time zone;
--> statement-breakpoint

COMMENT ON COLUMN "landing_pages"."sanitized_html_body" IS
	'Cache do html_body após DOMPurify (concatenado com custom_css sanitizado). Invalidar quando html_body ou custom_css muda. Aplicação compara sanitized_at vs updated_at pra decidir re-sanitizar. NULL = ainda não sanitizado (primeira render preenche).';
--> statement-breakpoint

COMMENT ON COLUMN "landing_pages"."sanitized_at" IS
	'Timestamp da última sanitização. Se < updated_at, cache inválido → aplicação re-sanitiza no próximo render e persiste.';
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- ROLLBACK (executar manualmente se precisar reverter):
-- ═════════════════════════════════════════════════════════════════════════
--
-- -- 2. landing_pages cache
-- ALTER TABLE "landing_pages" DROP COLUMN IF EXISTS "sanitized_at";
-- ALTER TABLE "landing_pages" DROP COLUMN IF EXISTS "sanitized_html_body";
--
-- -- 1. credentials.channel
-- DROP INDEX IF EXISTS "idx_credentials_channel_key";
-- ALTER TABLE "credentials" DROP CONSTRAINT IF EXISTS "credentials_channel_check";
-- ALTER TABLE "credentials" DROP COLUMN IF EXISTS "channel";
--
-- Ordem: reverso da aplicação. Nenhuma dependência entre as duas mudanças —
-- podem ser revertidas independentemente se necessário.
--
-- ═════════════════════════════════════════════════════════════════════════
-- TESTES DE SANIDADE (executar manualmente após migration):
-- ═════════════════════════════════════════════════════════════════════════
--
-- -- Teste 1: Backfill preservou comportamento — todas as rows existentes 'blackshop'
-- SELECT channel, count(*) FROM credentials GROUP BY channel;
-- -- Esperado: blackshop = N (todas as pre-existentes); l0i = 0; shared = 0.
--
-- -- Teste 2: CHECK constraint bloqueia valores inválidos
-- INSERT INTO credentials (key, encrypted_value, iv, salt, channel)
-- VALUES ('teste.invalido', 'x'::bytea, 'x'::bytea, 'x'::bytea, 'invalido');
-- -- Esperado: ERROR: new row violates check constraint "credentials_channel_check"
--
-- -- Teste 3: Insert de credencial L0i funciona
-- INSERT INTO credentials (key, encrypted_value, iv, salt, channel)
-- VALUES ('l0i.stripe.secret', 'x'::bytea, 'x'::bytea, 'x'::bytea, 'l0i');
-- SELECT key, channel FROM credentials WHERE channel = 'l0i';
-- -- Esperado: 1 row com channel='l0i'.
--
-- -- Teste 4: Índice composto usado em query filtrada por channel
-- EXPLAIN ANALYZE SELECT key FROM credentials WHERE channel = 'l0i' ORDER BY key;
-- -- Esperado: Index Scan / Index Only Scan usando idx_credentials_channel_key.
--
-- -- Teste 5: sanitized_html_body começa NULL e aplicação preenche
-- SELECT id, sanitized_html_body IS NULL AS sem_cache, sanitized_at
-- FROM landing_pages LIMIT 5;
-- -- Esperado: sem_cache = t, sanitized_at = NULL em todas as rows pré-0046.
--
-- -- Teste 6: Simular invalidação de cache (updated_at > sanitized_at)
-- UPDATE landing_pages
-- SET sanitized_html_body = '<h1>cached</h1>', sanitized_at = now()
-- WHERE slug = 'teste-mvp';
-- -- (dorme 1s)
-- UPDATE landing_pages SET updated_at = now() WHERE slug = 'teste-mvp';
-- SELECT (updated_at > sanitized_at) AS cache_invalido
-- FROM landing_pages WHERE slug = 'teste-mvp';
-- -- Esperado: cache_invalido = t → aplicação deve re-sanitizar.
--
-- -- Teste 7: Cleanup dos testes
-- DELETE FROM credentials WHERE key = 'l0i.stripe.secret';
