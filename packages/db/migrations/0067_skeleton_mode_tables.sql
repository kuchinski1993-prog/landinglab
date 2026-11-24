-- Migration 0067 — Skeleton Mode: tabelas novas + seeds
--
-- Referências:
--   - PRD:    docs/prd/skeleton-mode.md v1.0.0
--   - Schema: docs/architecture/skeleton-mode-schema.md §4.2-4.5
--   - Pre-req: 0066_skeleton_mode_landing_pages.sql (colunas em landing_pages)
--
-- Cria 3 tabelas novas:
--   1. skeleton_versions        — catálogo de skeletons React SSR (V1 = 2 rows)
--   2. skeleton_source_snapshots — evidência da extração (FK CASCADE)
--   3. font_substitution        — mapa fonte-paga → Google Font (FR-5)
--
-- E popula seeds:
--   - 2 skeletons V1 (bepurex-advertorial-v1, bepurex-landing-v1)
--   - 12 fontes curadas iniciais (Circular, NHG, Helvetica, etc.)

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. skeleton_versions — catálogo dos templates React SSR disponíveis
--    (FR-8, FR-27, CON-3)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "skeleton_versions" (
    "id" varchar(50) PRIMARY KEY,
    "name" varchar(100) NOT NULL,
    "type" text NOT NULL,
    "component_path" text NOT NULL,
    "slots_config" jsonb NOT NULL,
    "is_active" boolean NOT NULL DEFAULT true,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "skeleton_versions_type_check"
        CHECK ("type" IN ('advertorial', 'landing')),
    CONSTRAINT "skeleton_versions_id_format_check"
        CHECK ("id" ~ '^[a-z][a-z0-9-]{2,49}$'),
    CONSTRAINT "skeleton_versions_slots_is_object_check"
        CHECK (jsonb_typeof("slots_config") = 'object')
);
--> statement-breakpoint

COMMENT ON TABLE "skeleton_versions" IS
    'Catálogo de skeletons React SSR disponíveis. V1 = 2 rows (bepurex-advertorial-v1, bepurex-landing-v1). V2+ adiciona novos temas. FR-8, FR-27, CON-3.';
COMMENT ON COLUMN "skeleton_versions"."component_path" IS
    'Path relativo ao repo do componente React SSR. Ex.: packages/landinglab-cloner/src/skeletons/bepurex-landing-v1. Validado no CI.';
COMMENT ON COLUMN "skeleton_versions"."slots_config" IS
    'Config dos 12 slots fixos + até 3 dinâmicos. Shape: {fixed: [{slot_id, name, required, type}], dynamic: {max_count, allowed_types}}. Consumido pelo skeleton-composer (FR-7).';
COMMENT ON COLUMN "skeleton_versions"."is_active" IS
    'false = skeleton deprecated (não pode ser escolhido em novos POST /api/skeleton/create), mas landings antigas com skeleton_id apontando pra ele continuam renderizando (FK-soft por design — ver schema doc §5.1).';
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 2. skeleton_source_snapshots — evidência da extração
--    (FR-26, NFR-3, NFR-5)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "skeleton_source_snapshots" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "landing_page_id" uuid NOT NULL
        REFERENCES "landing_pages"("id") ON DELETE CASCADE,
    "source_url" text NOT NULL,
    "source_html_size_bytes" integer,
    "screenshot_url" text,
    "extracted_json" jsonb NOT NULL,
    "extractor_version" varchar(20) NOT NULL,
    "extraction_confidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    -- NFR-3: JSON extraído ≤ 500KB. pg_column_size retorna bytes TOASTed.
    CONSTRAINT "skeleton_source_snapshots_extracted_size_check"
        CHECK (pg_column_size("extracted_json") <= 512000),
    CONSTRAINT "skeleton_source_snapshots_confidence_is_object_check"
        CHECK (jsonb_typeof("extraction_confidence") = 'object'),
    CONSTRAINT "skeleton_source_snapshots_html_size_positive_check"
        CHECK ("source_html_size_bytes" IS NULL OR "source_html_size_bytes" >= 0)
);
--> statement-breakpoint

COMMENT ON TABLE "skeleton_source_snapshots" IS
    'Evidência da extração da fonte. 1 landing pode ter N snapshots (re-extração = INSERT, nunca UPDATE — histórico imutável). Screenshot em Supabase Storage bucket skeleton-source-snapshots (private). FR-26, NFR-3, NFR-5.';
COMMENT ON COLUMN "skeleton_source_snapshots"."source_html_size_bytes" IS
    'Tamanho do HTML raw baixado (metadata). HTML raw NÃO é persistido — descartado pós-extração por NFR-3.';
COMMENT ON COLUMN "skeleton_source_snapshots"."screenshot_url" IS
    'URL Supabase Storage: skeleton-source-snapshots/{landing_page_id}/{snapshot_id}.png. Máx 5MB. NULL se screenshot falhou (extração continua).';
COMMENT ON COLUMN "skeleton_source_snapshots"."extracted_json" IS
    'JSON estruturado que alimentou skeleton-composer. Shape em packages/landinglab-cloner/src/agents/skeleton-extractor. Limite 500KB enforced pelo CHECK constraint (NFR-3).';
COMMENT ON COLUMN "skeleton_source_snapshots"."extractor_version" IS
    'Versão semver do skeleton-extractor (ex.: 1.0.0). Rastreabilidade pra re-extrair com versão consistente.';
COMMENT ON COLUMN "skeleton_source_snapshots"."extraction_confidence" IS
    'Score 0-1 por slot: {hero: 0.95, bullets: 0.70, reviews: 0.10, ...}. Consumido pelo painel de edição pra sinalizar slots suspeitos ao dono.';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_skeleton_snapshots_landing_id"
    ON "skeleton_source_snapshots" ("landing_page_id", "created_at" DESC);
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 3. font_substitution — mapa fonte paga → Google Font
--    (FR-5)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "font_substitution" (
    "source_font_family" varchar(100) PRIMARY KEY,
    "google_font_family" varchar(100) NOT NULL,
    "weight_mapping" varchar(200) NOT NULL DEFAULT '400,700',
    "llm_generated" boolean NOT NULL DEFAULT false,
    "notes" text,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

COMMENT ON TABLE "font_substitution" IS
    'Tabela curada de substituição de fontes pagas por Google Fonts. Consumida pelo brand-extractor (FR-5). llm_generated=true marca entries auto-adicionadas por fallback LLM (dono deve revisar).';
COMMENT ON COLUMN "font_substitution"."weight_mapping" IS
    'Pesos disponíveis no Google Font destino, CSV. Ex.: "400,600,700".';
COMMENT ON COLUMN "font_substitution"."llm_generated" IS
    'true = entry criada por LLM fallback quando fonte fonte não estava no mapa. Revisar periodicamente e curar manualmente.';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_font_substitution_llm_pending"
    ON "font_substitution" ("created_at")
    WHERE "llm_generated" = true;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 4. SEEDS
-- ─────────────────────────────────────────────────────────────────────────

-- 4.1 Skeletons V1 (2 rows Bepurex — CON-3, FR-8)

INSERT INTO "skeleton_versions" ("id", "name", "type", "component_path", "slots_config") VALUES
(
    'bepurex-advertorial-v1',
    'Bepurex Advertorial v1',
    'advertorial',
    'packages/landinglab-cloner/src/skeletons/bepurex-advertorial-v1',
    '{
        "fixed": [
            {"slot_id":"hero","name":"Hero","required":true,"type":"copy_image"},
            {"slot_id":"problem","name":"Problem statement","required":true,"type":"copy"},
            {"slot_id":"agitate","name":"Agitate","required":true,"type":"copy"},
            {"slot_id":"solution_intro","name":"Solution intro","required":true,"type":"copy"},
            {"slot_id":"benefits","name":"Benefits list","required":true,"type":"bullets"},
            {"slot_id":"how_it_works","name":"How it works","required":true,"type":"steps"},
            {"slot_id":"testimonials","name":"Testimonials","required":true,"type":"reviews"},
            {"slot_id":"proof","name":"Social proof / badges","required":false,"type":"badges"},
            {"slot_id":"faq","name":"FAQ","required":true,"type":"faq"},
            {"slot_id":"cta","name":"Final CTA","required":true,"type":"cta"},
            {"slot_id":"footer_disclaimer","name":"Disclaimer","required":true,"type":"legal"},
            {"slot_id":"tracking","name":"Tracking pixels","required":true,"type":"script"}
        ],
        "dynamic": {"max_count":3,"allowed_types":["certifications","comparison_table","press","risk_reversal"]}
    }'::jsonb
),
(
    'bepurex-landing-v1',
    'Bepurex Landing PDP v1',
    'landing',
    'packages/landinglab-cloner/src/skeletons/bepurex-landing-v1',
    '{
        "fixed": [
            {"slot_id":"hero","name":"Hero + Add to Cart","required":true,"type":"pdp_hero"},
            {"slot_id":"benefits","name":"Benefits grid","required":true,"type":"bullets"},
            {"slot_id":"how_it_works","name":"How it works","required":true,"type":"steps"},
            {"slot_id":"ingredients","name":"Ingredients / composition","required":false,"type":"list"},
            {"slot_id":"bundles","name":"Bundles / pricing","required":true,"type":"bundle_picker"},
            {"slot_id":"reviews","name":"Reviews carousel","required":true,"type":"reviews"},
            {"slot_id":"comparison","name":"Vs. competition","required":false,"type":"comparison_table"},
            {"slot_id":"guarantee","name":"Guarantee","required":true,"type":"copy_badge"},
            {"slot_id":"faq","name":"FAQ","required":true,"type":"faq"},
            {"slot_id":"cta_footer","name":"Final CTA","required":true,"type":"cta"},
            {"slot_id":"legal","name":"Legal footer","required":true,"type":"legal"},
            {"slot_id":"tracking","name":"Tracking pixels","required":true,"type":"script"}
        ],
        "dynamic": {"max_count":3,"allowed_types":["certifications","press","before_after","risk_reversal"]}
    }'::jsonb
)
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

-- 4.2 Font substitution curada (FR-5) — 12 fontes iniciais
--     llm_generated=false = curadoria manual (não precisa revisar)

INSERT INTO "font_substitution"
    ("source_font_family", "google_font_family", "weight_mapping", "llm_generated", "notes") VALUES
    ('Circular',          'Nunito Sans', '400,600,700', false, 'Circular Std sans-serif geométrica → Nunito Sans (similaridade métrica)'),
    ('Circular Std',      'Nunito Sans', '400,600,700', false, 'Alias de Circular'),
    ('Neue Haas Grotesk', 'Inter',       '400,500,700', false, 'NHG grotesk → Inter (mesma família ótica)'),
    ('Helvetica Neue',    'Inter',       '400,500,700', false, 'Substituto padrão de Helvetica em web'),
    ('Proxima Nova',      'Montserrat',  '400,600,700', false, 'Proxima Nova → Montserrat'),
    ('Gotham',            'Montserrat',  '400,600,700', false, 'Gotham (paid) → Montserrat (open geometric sans)'),
    ('Futura',            'Jost',        '400,500,700', false, 'Futura → Jost (open geometric sans)'),
    ('Avenir',            'Nunito',      '400,600,700', false, 'Avenir humanist → Nunito'),
    ('Avenir Next',       'Nunito',      '400,600,700', false, 'Alias de Avenir'),
    ('Playfair Display',  'Playfair Display', '400,700', false, 'Já é Google Font — pass-through'),
    ('Lato',              'Lato',        '400,700',      false, 'Já é Google Font — pass-through'),
    ('Open Sans',         'Open Sans',   '400,700',      false, 'Já é Google Font — pass-through')
ON CONFLICT (source_font_family) DO NOTHING;
--> statement-breakpoint

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- POST-DEPLOY (manual, via Supabase Dashboard OU seed script):
--
-- Criar bucket 'skeleton-source-snapshots' (private, 5MB):
--
--   INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
--   VALUES (
--       'skeleton-source-snapshots',
--       'skeleton-source-snapshots',
--       false,
--       5242880,
--       ARRAY['image/png','image/jpeg','image/webp']
--   )
--   ON CONFLICT (id) DO NOTHING;
--
-- Sem policies adicionais = default deny pra anon/authenticated. Apenas
-- service_role (backoffice API) acessa. Signed URLs emitidos server-side
-- quando dono clica "Ver evidência" no painel de edição.
-- ═════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════
-- ROLLBACK (executar manualmente):
--
-- BEGIN;
-- DROP INDEX IF EXISTS idx_skeleton_snapshots_landing_id;
-- DROP INDEX IF EXISTS idx_font_substitution_llm_pending;
-- DROP TABLE IF EXISTS skeleton_source_snapshots;  -- CASCADE remove FK
-- DROP TABLE IF EXISTS font_substitution;
-- DROP TABLE IF EXISTS skeleton_versions;
-- COMMIT;
--
-- Nota: rollback preserva colunas landing_pages.skeleton_id (viram FK-soft
-- órfã até rollback do 0066). Screenshots no bucket ficam órfãos — limpar
-- manualmente via Supabase Storage se necessário.
-- ═════════════════════════════════════════════════════════════════════════
