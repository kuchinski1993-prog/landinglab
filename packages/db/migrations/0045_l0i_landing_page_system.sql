-- Migration 0045 — L0i Landing Page System (Onda 1 / MVP).
--
-- Contexto:
--   L0i é o segundo canal de venda do BlackShop, dedicado a advertoriais
--   single-product em LATAM. Cada landing é HTML colável servido em domínio
--   próprio com checkout Stripe, multi-pixel Meta CAPI e contingência de
--   swap de domínio contra ban de BM.
--
-- Referências:
--   - PRD: docs/prd/l0i-landing-page-system-prd.md (Feature F1)
--   - Research: docs/research/2026-08-04-l0i-landing-page-system-latam.md §4
--
-- Escopo desta migration (6 tabelas novas + 1 view):
--   1. landing_pages       — 1 linha = 1 LP (HTML, CSS, SEO, fulfillment)
--   2. landing_variants    — variações por LP (Modelo/Tamanho/Cor + preço)
--   3. landing_domains     — 1 ativo + N reservas por LP (contingência)
--   4. landing_pixels      — multi-pixel (Meta v1; TikTok/Google prontos)
--   5. landing_orders      — orders nativos (Stripe hoje, dLocal Onda 2)
--   6. landing_settings    — jsonb 1:1 pra config flexível por LP
--   +  all_orders (view)   — UNION ALL de orders + landing_orders p/ TrustShield
--
-- Convenções seguidas:
--   - IDs uuid PK gen_random_uuid()
--   - timestamps timestamptz NOT NULL DEFAULT now()
--   - store_id text NOT NULL DEFAULT 'l0i' (store genérico L0i, não FK)
--   - FKs ON DELETE CASCADE quando semanticamente correto
--   - Vault referenciado por chave (credentials.key TEXT), não plaintext
--   - RLS: seguindo padrão atual do projeto (não usa RLS — auth via API
--     Fastify session cookie; storefront público é read-only via SSR).
--
-- Segurança:
--   - HTML colável em html_body/custom_css: risco XSS mitigado no runtime
--     via CSP estrito + DOMPurify warning-only + CSS scoped (research §4.7).
--     Nenhuma constraint SQL — dono é single-user confiável.
--   - Credenciais Stripe/Meta CAPI/Spaceship: NUNCA em plaintext.
--     landing_pixels.capi_credential_key aponta pra credentials.key (Vault).
--
-- Melhorias sobre research §4 (documentadas em cada ponto):
--   [M1] research §4.4: capi_credential_id uuid REFERENCES credentials(id)
--        MAS credentials.PK é `key TEXT`, não `id uuid`. Corrigido para
--        capi_credential_key TEXT REFERENCES credentials(key) ON DELETE SET NULL.
--   [M2] Adicionado landing_pages.preview_token TEXT UNIQUE — F5 (storefront
--        preview) precisa de token gerado no publish. Research §5 dizia
--        "guardado em landing_settings.preview_token" mas coluna dedicada
--        + unique index é ordem de magnitude mais rápido que lookup em jsonb.
--   [M3] Adicionado landing_orders.stripe_payment_intent_id UNIQUE separado
--        de payment_provider_order_id — pra webhook idempotency dedicado
--        (evita colisão futura entre Stripe PI e dLocal order ID no mesmo
--        campo). payment_provider_order_id fica como fallback genérico.
--     [M3a] Adicionada coluna stripe_session_id UNIQUE (Stripe Checkout
--        redirect usa Session, PaymentIntent é criado só ao final).
--   [M4] Adicionado landing_orders.metadata jsonb — UTMs, referrer, IP,
--        session_id de tracking. PRD F9 detalhe de order menciona esses
--        dados; research §4.5 esqueceu campo dedicado.
--   [M5] Adicionados CHECK constraints em enums soft: status, role,
--        fulfillment_type, provider, payment_provider. Evita bugs mudos
--        (ex.: dev grava 'PAID' em vez de 'paid').
--   [M6] Adicionados índices que faltavam no research:
--        - landing_domains(domain) — resolução hostname em CADA request storefront.
--        - landing_orders(landing_page_id, created_at DESC) composto —
--          dashboard de pedidos por LP ordena por data.
--        - landing_pages(status) parcial WHERE status='published' —
--          storefront filtra sempre por published.
--   [M7] Adicionado landing_variants.updated_at (research esqueceu).
--   [M8] landing_domains: adicionadas colunas dns_records (jsonb) — debug
--        futuro dos records A/CNAME que o Spaceship setou. Research menciona
--        implicitamente em §4.3 (comentário "detalhar DNS status").
--   [M9] landing_orders.refund_ticket_id: mantido sem FK dura (soft ref)
--        seguindo padrão de inbound_emails.refund_ticket_id / source_inbound_email_id
--        (schema.ts:597). Justificativa: evitar cascade cross-pipeline.
--   [M10] all_orders view: shape mínimo compatível — TrustShield hoje lê
--        (id, store_id, order_number, customer_email, currency, total_price,
--         financial_status, created_at). Colunas divergentes ficam NULL na
--        LP e vice-versa.
--
-- Rollback: seção DOWN no final (comentada; executar manualmente).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 1. landing_pages — 1 linha = 1 LP
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "landing_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text NOT NULL DEFAULT 'l0i',
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL DEFAULT 'draft',
	"currency" text NOT NULL,
	"fulfillment_type" text NOT NULL,
	"html_body" text NOT NULL,
	"custom_css" text,
	"media_urls" text[] NOT NULL DEFAULT '{}'::text[],
	"video_urls" text[] NOT NULL DEFAULT '{}'::text[],
	"seo_title" text,
	"seo_description" text,
	"seo_image" text,
	"manufacturer" text,
	"product_type" text,
	"country_of_origin" text,
	"tags" text[] NOT NULL DEFAULT '{}'::text[],
	"price" numeric(12, 2) NOT NULL,
	"compare_at_price" numeric(12, 2),
	"sold_out_counter" integer NOT NULL DEFAULT 0,
	"disclaimer_html" text,
	"anvisa_notification_number" text,
	"cofepris_registration_number" text,
	-- [M2] Token secreto pra rota /preview/[id]?token=xxx (F5).
	-- Gerado no backoffice ao criar landing; NULL em landings antigas seed.
	"preview_token" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "landing_pages_store_slug_unique" UNIQUE ("store_id", "slug"),
	CONSTRAINT "landing_pages_status_check"
		CHECK ("status" IN ('draft', 'published', 'archived')),
	CONSTRAINT "landing_pages_fulfillment_type_check"
		CHECK ("fulfillment_type" IN ('dropship', 'info_product', 'physical_own')),
	-- Currency é ISO-4217 3-letter (USD, BRL, MXN, ARS, CLP, COP, UYU...).
	-- Validação semântica no app (lista suportada Stripe); aqui só shape.
	CONSTRAINT "landing_pages_currency_check"
		CHECK (length("currency") = 3 AND "currency" = upper("currency"))
);
--> statement-breakpoint

COMMENT ON TABLE "landing_pages" IS
	'L0i landing pages (advertoriais single-product). 1 linha = 1 LP servida em domínio próprio via apps/l0i-storefront.';
COMMENT ON COLUMN "landing_pages"."store_id" IS
	'Sempre "l0i" na v1 (store genérico). Multi-store por país fica Onda 3.';
COMMENT ON COLUMN "landing_pages"."html_body" IS
	'HTML colável integral (advertorial pronto). Renderizado dentro de <div class="landing-scope"> com CSP + DOMPurify no storefront (research §4.7).';
COMMENT ON COLUMN "landing_pages"."fulfillment_type" IS
	'dropship | info_product | physical_own. physical_own só na Onda 2; incluído no CHECK pra evitar migration futura.';
COMMENT ON COLUMN "landing_pages"."preview_token" IS
	'Token secreto pra /preview/[id]?token=xxx. Gerado no backoffice; NULL em drafts antigos.';
COMMENT ON COLUMN "landing_pages"."sold_out_counter" IS
	'Contador de "vendas simuladas" (fake urgency). Aplicação soma landing_orders.status=paid + este valor no display.';
COMMENT ON COLUMN "landing_pages"."disclaimer_html" IS
	'HTML de disclaimer sanitário (ANVISA/COFEPRIS/etc.). Default LIGADO no backoffice; dono edita por landing.';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_landing_pages_slug"
	ON "landing_pages" USING btree ("slug");
--> statement-breakpoint
-- [M6] Índice parcial pra storefront: 99% dos requests filtram status=published.
CREATE INDEX IF NOT EXISTS "idx_landing_pages_published"
	ON "landing_pages" USING btree ("store_id", "slug")
	WHERE "status" = 'published';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_landing_pages_status"
	ON "landing_pages" USING btree ("status");
--> statement-breakpoint
-- [M2] Preview lookup: WHERE preview_token=? — 1 query em cada preview page load.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_pages_preview_token"
	ON "landing_pages" USING btree ("preview_token")
	WHERE "preview_token" IS NOT NULL;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 2. landing_variants — variações da LP (Modelo/Tamanho/Combo)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "landing_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"landing_page_id" uuid NOT NULL
		REFERENCES "landing_pages"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"quantity_of_items" integer NOT NULL DEFAULT 1,
	"followers_count" integer,
	"price" numeric(12, 2) NOT NULL,
	"compare_at_price" numeric(12, 2),
	"stock" integer,
	"ean" text,
	"logo_url" text,
	"banner_url" text,
	"payment_html" text,
	"sort_order" integer NOT NULL DEFAULT 0,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	-- [M7] Faltava updated_at no research §4.2. Adicionado pra edição.
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

COMMENT ON TABLE "landing_variants" IS
	'Variações de produto por LP (Sereia 1 pote, Sereia 4 potes, etc.). ON DELETE CASCADE: deletar LP remove variants.';
COMMENT ON COLUMN "landing_variants"."stock" IS
	'NULL = ilimitado. Número = decrementa a cada landing_orders.status=paid (aplicação).';
COMMENT ON COLUMN "landing_variants"."payment_html" IS
	'HTML custom por variant (embed Stripe/dLocal específico). NULL = usa checkout default da LP.';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_landing_variants_lp"
	ON "landing_variants" USING btree ("landing_page_id", "sort_order");
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 3. landing_domains — contingência 1 ativo + N reservas por LP
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "landing_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"landing_page_id" uuid NOT NULL
		REFERENCES "landing_pages"("id") ON DELETE CASCADE,
	"domain" text NOT NULL,
	-- role = active | reserve | blocked | pending_dns | disabled
	-- (research §4.3 usa 'blocked' pós-swap; PRD F6 fluxo detalha).
	"role" text NOT NULL,
	"registrar" text,
	"registrar_domain_id" text,
	"vercel_project_id" text,
	"vercel_domain_status" text,
	-- [M8] Records DNS que o Spaceship API setou (A + CNAME).
	-- Debug futuro sem precisar consultar Spaceship de novo.
	"dns_records" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"dns_verified_at" timestamp with time zone,
	"blocked_at" timestamp with time zone,
	"blocked_reason" text,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "landing_domains_domain_unique" UNIQUE ("domain"),
	CONSTRAINT "landing_domains_role_check"
		CHECK ("role" IN ('active', 'reserve', 'blocked', 'pending_dns', 'disabled'))
);
--> statement-breakpoint

COMMENT ON TABLE "landing_domains" IS
	'Domínios por LP: 1 ativo + N reservas + histórico blocked. Swap em <30s (PRD F6). Partial unique index garante 1 role=active por LP.';
COMMENT ON COLUMN "landing_domains"."role" IS
	'active (1 por LP) | reserve (N, DNS-verified prontas pra swap) | blocked (histórico pós-ban) | pending_dns | disabled.';
COMMENT ON COLUMN "landing_domains"."dns_records" IS
	'JSON com records A/CNAME configurados via Spaceship. Ex.: { "A": "76.76.21.21", "CNAME": "cname.vercel-dns.com" }.';
COMMENT ON COLUMN "landing_domains"."blocked_reason" IS
	'meta_ban | takedown | manual | dns_error. Preenchido no swap (F6).';
--> statement-breakpoint

-- [M6] Índice de RESOLUÇÃO HOSTNAME crítico: storefront faz esta query em
-- CADA request via middleware. WHERE role='active' porque só ativo serve.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_domains_hostname_active"
	ON "landing_domains" USING btree ("domain")
	WHERE "role" = 'active';
--> statement-breakpoint
-- Regra dura: 1 role=active por LP.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_domains_active"
	ON "landing_domains" USING btree ("landing_page_id")
	WHERE "role" = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_landing_domains_reserve"
	ON "landing_domains" USING btree ("landing_page_id")
	WHERE "role" = 'reserve';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_landing_domains_lp"
	ON "landing_domains" USING btree ("landing_page_id");
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 4. landing_pixels — multi-pixel por LP (Meta v1; TikTok/Google prontos)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "landing_pixels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"landing_page_id" uuid NOT NULL
		REFERENCES "landing_pages"("id") ON DELETE CASCADE,
	"provider" text NOT NULL,
	"pixel_id" text NOT NULL,
	-- [M1] Corrigido: credentials.PK é `key TEXT`, não `id uuid`.
	-- Aponta pra Vault key (ex.: 'l0i.meta.capi.pixel_1234.token').
	-- ON DELETE SET NULL: perder credencial não apaga pixel (retention pra
	-- auditoria); dono re-configura credencial nova.
	"capi_credential_key" text
		REFERENCES "credentials"("key") ON DELETE SET NULL,
	"event_test_code" text,
	"events_enabled" jsonb NOT NULL
		DEFAULT '["Purchase","InitiateCheckout","ViewContent"]'::jsonb,
	"is_active" boolean NOT NULL DEFAULT true,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "landing_pixels_provider_check"
		CHECK ("provider" IN ('meta', 'tiktok', 'google_ads', 'pinterest'))
);
--> statement-breakpoint

COMMENT ON TABLE "landing_pixels" IS
	'Pixels multi-provider por LP. V1 UI só expõe meta; schema pronto pra tiktok/google_ads/pinterest (Onda 2).';
COMMENT ON COLUMN "landing_pixels"."pixel_id" IS
	'ID público do pixel no provider (aparece no <script> client-side).';
COMMENT ON COLUMN "landing_pixels"."capi_credential_key" IS
	'Chave no Vault (credentials.key) apontando pro access_token do CAPI. Server-side apenas. Nunca exposto no client.';
COMMENT ON COLUMN "landing_pixels"."event_test_code" IS
	'Meta Events Manager test code (TEST12345). NULL em produção.';
COMMENT ON COLUMN "landing_pixels"."events_enabled" IS
	'Array JSON de eventos habilitados. Ex.: ["Purchase","InitiateCheckout","ViewContent","AddToCart"].';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_landing_pixels_lp"
	ON "landing_pixels" USING btree ("landing_page_id", "is_active");
--> statement-breakpoint
-- [M6] Storefront filtra por LP + is_active na renderização.
CREATE INDEX IF NOT EXISTS "idx_landing_pixels_lp_active"
	ON "landing_pixels" USING btree ("landing_page_id")
	WHERE "is_active" = true;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 5. landing_orders — orders nativos L0i (Stripe hoje, dLocal Onda 2)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "landing_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text NOT NULL DEFAULT 'l0i',
	"landing_page_id" uuid NOT NULL
		REFERENCES "landing_pages"("id"),
	"landing_variant_id" uuid
		REFERENCES "landing_variants"("id"),
	"order_number" text NOT NULL,
	"status" text NOT NULL DEFAULT 'pending',
	"payment_provider" text NOT NULL,
	"payment_provider_order_id" text,
	-- [M3a] Stripe Checkout session (redirect flow — v1). UNIQUE pra webhook idempotency.
	"stripe_session_id" text,
	-- [M3] Stripe PaymentIntent ID (após confirm). UNIQUE separado do provider_order_id.
	"stripe_payment_intent_id" text,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text NOT NULL,
	"customer_email" text NOT NULL,
	"customer_phone" text,
	"customer_name" text,
	"customer_document" text,
	"shipping_address" jsonb,
	"fulfillment_status" text,
	"fulfillment_tracking" text,
	"fulfillment_carrier" text,
	"meta_event_id" text,
	-- [M4] UTMs, referrer, IP, session_id de tracking, user-agent, etc.
	"metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"raw" jsonb NOT NULL DEFAULT '{}'::jsonb,
	-- [M9] Soft ref (sem FK) pro refund_tickets — evita cascade cross-pipeline.
	"refund_ticket_id" uuid,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "landing_orders_order_number_unique" UNIQUE ("order_number"),
	CONSTRAINT "landing_orders_status_check"
		CHECK ("status" IN (
			'pending', 'paid', 'shipped', 'delivered',
			'refunded', 'cancelled', 'chargeback', 'failed'
		)),
	CONSTRAINT "landing_orders_payment_provider_check"
		CHECK ("payment_provider" IN ('stripe', 'dlocal', 'manual')),
	CONSTRAINT "landing_orders_fulfillment_status_check"
		CHECK ("fulfillment_status" IS NULL OR "fulfillment_status" IN (
			'pending', 'processing', 'shipped', 'delivered', 'failed'
		)),
	CONSTRAINT "landing_orders_currency_check"
		CHECK (length("currency") = 3 AND "currency" = upper("currency"))
);
--> statement-breakpoint

COMMENT ON TABLE "landing_orders" IS
	'Orders nativos do L0i. Tabela separada de "orders" (AuthenLondon Shopify) — shape diverge. Vistas juntas via view all_orders pra TrustShield.';
COMMENT ON COLUMN "landing_orders"."order_number" IS
	'Formato "L0I-YYYY-NNNN" (gerado no app). UNIQUE global.';
COMMENT ON COLUMN "landing_orders"."stripe_session_id" IS
	'Stripe Checkout Session ID. UNIQUE — chave de idempotency do webhook checkout.session.completed.';
COMMENT ON COLUMN "landing_orders"."stripe_payment_intent_id" IS
	'Stripe PaymentIntent ID. UNIQUE — chave de idempotency do webhook payment_intent.succeeded.';
COMMENT ON COLUMN "landing_orders"."customer_document" IS
	'CPF (BR) / RFC (MX) / DNI (AR/UY) / RUT (CL). LATAM PSPs exigem em >70% dos casos.';
COMMENT ON COLUMN "landing_orders"."shipping_address" IS
	'JSON flexível (LATAM tem N formatos). Shape esperado: { street, number, complement, neighborhood, city, state, zip, country }.';
COMMENT ON COLUMN "landing_orders"."meta_event_id" IS
	'Event ID pra dedup CAPI Purchase — mesmo valor no fbq client-side e Graph API server-side.';
COMMENT ON COLUMN "landing_orders"."metadata" IS
	'UTMs, referrer, IP, user-agent, tracking_session_id. Shape: { utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer, ip, user_agent, tracking_session_id, fbc, fbp }.';
COMMENT ON COLUMN "landing_orders"."refund_ticket_id" IS
	'Soft ref pra refund_tickets (sem FK). Setado quando TrustShield abre ticket sobre esta order.';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_landing_orders_lp"
	ON "landing_orders" USING btree ("landing_page_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_landing_orders_status"
	ON "landing_orders" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_landing_orders_email"
	ON "landing_orders" USING btree ("customer_email");
--> statement-breakpoint
-- [M6] Dashboard PRD F9: WHERE landing_page_id=? ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS "idx_landing_orders_lp_created"
	ON "landing_orders" USING btree ("landing_page_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_landing_orders_created"
	ON "landing_orders" USING btree ("created_at" DESC);
--> statement-breakpoint
-- [M3/M3a] Webhook idempotency: unique parcial (NULL permitido pra dLocal).
CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_orders_stripe_session"
	ON "landing_orders" USING btree ("stripe_session_id")
	WHERE "stripe_session_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_orders_stripe_pi"
	ON "landing_orders" USING btree ("stripe_payment_intent_id")
	WHERE "stripe_payment_intent_id" IS NOT NULL;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 6. landing_settings — 1:1 com landing_pages, jsonb pra config flexível
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "landing_settings" (
	"landing_page_id" uuid PRIMARY KEY
		REFERENCES "landing_pages"("id") ON DELETE CASCADE,
	"settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

COMMENT ON TABLE "landing_settings" IS
	'Config flexível 1:1 com landing_pages. jsonb pra evitar migration a cada nova config. Shape documentado no research §4.6.';
COMMENT ON COLUMN "landing_settings"."settings" IS
	'Chaves esperadas (não schematizadas): checkout.{provider,buttonText,guaranteeText,successRedirectUrl}, urgency.{showCountdown,countdownMinutes,showStockCounter,startFrom,discountCouponCode}, shipping.{flatRateCents,freeShippingThreshold,carrierMessage}, dropship.{supplierEmail,supplierWebhookUrl,emailTemplate}, infoProduct.{deliveryUrl,deliveryTemplate}, policies.{privacyOverride,refundOverride,termsOverride}, email.{provider,listId} (v2).';
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 7. all_orders VIEW — union pra TrustShield ler ambos os canais
-- ─────────────────────────────────────────────────────────────────────────
--
-- [M10] Shape mínimo compatível com queries atuais do TrustShield:
--       (id, store_id, order_number, customer_email, currency, total_price,
--        financial_status, created_at, source).
--       "source" discrimina origem pro dashboard.
--       Colunas divergentes ficam NULL de cada lado.
--       Cast id → text porque orders.id é text (Shopify) e landing_orders.id é uuid.

CREATE OR REPLACE VIEW "all_orders" AS
SELECT
	"id"::text                       AS "id",
	"store_id"                       AS "store_id",
	"order_number"                   AS "order_number",
	"customer_email"                 AS "customer_email",
	"customer_phone"                 AS "customer_phone",
	"currency"                       AS "currency",
	"total_price"                    AS "total_price",
	"financial_status"               AS "financial_status",
	"fulfillment_status"             AS "fulfillment_status",
	"carrier"                        AS "carrier",
	"tracking_number"                AS "tracking_number",
	NULL::uuid                       AS "landing_page_id",
	NULL::uuid                       AS "landing_variant_id",
	NULL::text                       AS "payment_provider",
	"raw"                            AS "raw",
	"created_at"                     AS "created_at",
	"updated_at"                     AS "updated_at",
	'shopify'::text                  AS "source"
FROM "orders"
UNION ALL
SELECT
	"id"::text                       AS "id",
	"store_id"                       AS "store_id",
	"order_number"                   AS "order_number",
	"customer_email"                 AS "customer_email",
	"customer_phone"                 AS "customer_phone",
	"currency"                       AS "currency",
	"amount"                         AS "total_price",
	"status"                         AS "financial_status",
	"fulfillment_status"             AS "fulfillment_status",
	"fulfillment_carrier"            AS "carrier",
	"fulfillment_tracking"           AS "tracking_number",
	"landing_page_id"                AS "landing_page_id",
	"landing_variant_id"             AS "landing_variant_id",
	"payment_provider"               AS "payment_provider",
	"raw"                            AS "raw",
	"created_at"                     AS "created_at",
	"updated_at"                     AS "updated_at",
	'l0i'::text                      AS "source"
FROM "landing_orders";
--> statement-breakpoint

COMMENT ON VIEW "all_orders" IS
	'Union de orders (Shopify/AuthenLondon) + landing_orders (L0i). TrustShield lê daqui pra atender ambos os canais. Source discrimina origem.';

-- ═════════════════════════════════════════════════════════════════════════
-- ROLLBACK (executar manualmente se precisar reverter):
-- ═════════════════════════════════════════════════════════════════════════
--
-- DROP VIEW IF EXISTS "all_orders";
-- DROP TABLE IF EXISTS "landing_settings";
-- DROP TABLE IF EXISTS "landing_orders";
-- DROP TABLE IF EXISTS "landing_pixels";
-- DROP TABLE IF EXISTS "landing_domains";
-- DROP TABLE IF EXISTS "landing_variants";
-- DROP TABLE IF EXISTS "landing_pages";
--
-- Ordem obrigatória: view primeiro (depende de landing_orders), depois
-- filhas com FK (settings/orders/pixels/domains/variants), por fim landing_pages.
--
-- ═════════════════════════════════════════════════════════════════════════
-- TESTES DE SANIDADE (executar manualmente após migration):
-- ═════════════════════════════════════════════════════════════════════════
--
-- -- Teste 1: INSERT de landing_page com todos os campos obrigatórios
-- INSERT INTO landing_pages (slug, title, currency, fulfillment_type, html_body, price)
-- VALUES ('teste-mvp', 'VigoraXi Teste', 'BRL', 'dropship', '<h1>Teste</h1>', 197.00)
-- RETURNING id;
--
-- -- Teste 2: INSERT de variants
-- INSERT INTO landing_variants (landing_page_id, name, price)
-- SELECT id, '4 potes', 597.00 FROM landing_pages WHERE slug='teste-mvp';
--
-- -- Teste 3: INSERT domain ativo
-- INSERT INTO landing_domains (landing_page_id, domain, role, dns_verified_at)
-- SELECT id, 'loiofertas.shop', 'active', now() FROM landing_pages WHERE slug='teste-mvp';
--
-- -- Teste 4: Partial unique — tentar inserir 2º active pra mesma LP → deve falhar
-- INSERT INTO landing_domains (landing_page_id, domain, role)
-- SELECT id, 'loiofertas2.shop', 'active' FROM landing_pages WHERE slug='teste-mvp';
-- -- Esperado: ERROR: duplicate key value violates unique constraint "idx_landing_domains_active"
--
-- -- Teste 5: Reserva OK (mesmo LP, role diferente)
-- INSERT INTO landing_domains (landing_page_id, domain, role, dns_verified_at)
-- SELECT id, 'loiofertas-reserva.shop', 'reserve', now() FROM landing_pages WHERE slug='teste-mvp';
--
-- -- Teste 6: INSERT pixel Meta com credential mock
-- INSERT INTO credentials (key, encrypted_value, iv, salt)
-- VALUES ('l0i.meta.capi.test', 'fake'::bytea, 'fake'::bytea, 'fake'::bytea)
-- ON CONFLICT DO NOTHING;
-- INSERT INTO landing_pixels (landing_page_id, provider, pixel_id, capi_credential_key)
-- SELECT id, 'meta', '1234567890', 'l0i.meta.capi.test' FROM landing_pages WHERE slug='teste-mvp';
--
-- -- Teste 7: INSERT settings jsonb
-- INSERT INTO landing_settings (landing_page_id, settings)
-- SELECT id, '{"checkout":{"buttonText":"COMPRAR JÁ"}}'::jsonb FROM landing_pages WHERE slug='teste-mvp';
--
-- -- Teste 8: INSERT order + verificar dedup Stripe
-- INSERT INTO landing_orders (landing_page_id, order_number, payment_provider, stripe_session_id, amount, currency, customer_email)
-- SELECT id, 'L0I-2026-0001', 'stripe', 'cs_test_abc', 197.00, 'BRL', 'cliente@teste.com'
-- FROM landing_pages WHERE slug='teste-mvp';
--
-- -- Teste 9: Idempotency — inserir mesma session → deve falhar
-- INSERT INTO landing_orders (landing_page_id, order_number, payment_provider, stripe_session_id, amount, currency, customer_email)
-- SELECT id, 'L0I-2026-0002', 'stripe', 'cs_test_abc', 197.00, 'BRL', 'outro@teste.com'
-- FROM landing_pages WHERE slug='teste-mvp';
-- -- Esperado: ERROR: duplicate key value violates "idx_landing_orders_stripe_session"
--
-- -- Teste 10: FK sem CASCADE em landing_orders — DELETE de LP com orders deve FALHAR.
-- --          (Auditoria financeira: nunca perder rastro de pedido pago.)
-- --          Se quiser mesmo remover, precisa arquivar orders antes OU manter LP.
-- DELETE FROM landing_pages WHERE slug='teste-mvp';
-- -- Esperado: ERROR: update or delete on "landing_pages" violates foreign key
-- --          constraint on "landing_orders" (RESTRICT default)
-- --
-- -- Teste 10b: CASCADE funciona pra variants/domains/pixels/settings.
-- --          Deletar orders manualmente antes:
-- DELETE FROM landing_orders WHERE landing_page_id = (SELECT id FROM landing_pages WHERE slug='teste-mvp');
-- DELETE FROM landing_pages WHERE slug='teste-mvp';
-- SELECT count(*) FROM landing_variants WHERE landing_page_id NOT IN (SELECT id FROM landing_pages);
-- -- Esperado: 0 (variants + domains + pixels + settings removidos por cascade)
--
-- -- Teste 11: View all_orders funciona
-- SELECT source, count(*) FROM all_orders GROUP BY source;
