-- 0054 — Landing domain bindings (M:N pivot).
--
-- Contexto: modelo atual landing_domains tem landing_page_id NOT NULL — cada
-- domínio pertence a UMA landing. Contradição com fluxo dropshipping onde
-- usuário quer: (a) reusar mesmo domínio pra várias landings, (b) manter
-- pool de domínios comprados independente das landings.
--
-- Solução: tabela pivot que amarra domain ↔ landing_page via slug. Legacy
-- landing_domains continua funcionando (não muda schema); novos fluxos
-- usam bindings. Migração de dados existentes: comentada abaixo (opcional).

BEGIN;

-- ─── landing_domain_bindings ────────────────────────────────────────
-- Pivot M:N entre um domínio (recurso reusável) e uma landing_page.
-- slug: url path onde a landing é servida sob esse domínio (ex: 'vigorax').
--   NULL/empty = binding pra root do domínio (dominio.com/).
-- is_default_root: boolean com constraint parcial garantindo max 1 por domain.
--
-- Exemplos válidos:
--   dominio.com/         → binding {slug: '', is_default_root: true}
--   dominio.com/oferta1  → binding {slug: 'oferta1', is_default_root: false}
--   dominio.com/oferta2  → binding {slug: 'oferta2', is_default_root: false}
CREATE TABLE IF NOT EXISTS "landing_domain_bindings" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Referência ao domínio (recurso independente). landing_domains é o
    -- catálogo de domínios comprados/registrados pelo usuário.
    "domain_id" uuid NOT NULL REFERENCES "landing_domains"("id") ON DELETE CASCADE,
    "landing_page_id" uuid NOT NULL REFERENCES "landing_pages"("id") ON DELETE CASCADE,
    -- URL path sob o domínio. Vazio = root. Único por (domain_id, slug).
    "slug" text NOT NULL DEFAULT '',
    -- Landing marcada como default do domínio (servida no path root).
    -- CHECK garante max 1 por domain via partial unique index abaixo.
    "is_default_root" boolean NOT NULL DEFAULT false,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    -- Slug format check — url-safe (lowercase, alfanumérico + hífen, pode
    -- ser vazio pra representar root).
    CONSTRAINT "landing_domain_bindings_slug_format_check"
      CHECK ("slug" = '' OR "slug" ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$')
);

-- Unicidade: 1 binding por (domain, slug) — não pode ter 2 landings no
-- mesmo path do mesmo domínio.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_domain_bindings_domain_slug"
  ON "landing_domain_bindings" ("domain_id", "slug");

-- Máximo 1 landing default (root) por domínio. Partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_domain_bindings_default_root"
  ON "landing_domain_bindings" ("domain_id")
  WHERE "is_default_root" = true;

-- Index de suporte pra lookups no storefront:
--   SELECT * FROM landing_domain_bindings WHERE domain_id = ? AND slug = ?
-- (já coberto pelo unique acima).
--
-- Index reverso: "quais landings usam este domínio?"
CREATE INDEX IF NOT EXISTS "idx_landing_domain_bindings_landing"
  ON "landing_domain_bindings" ("landing_page_id");

-- ─── Ajustes em landing_domains ─────────────────────────────────────
-- Torna landing_page_id NULLABLE. Legacy rows continuam com FK preenchido;
-- novos domínios criados via /landing-pages/domains ficam com NULL (domínio
-- existe sozinho até ser bindado via landing_domain_bindings).
ALTER TABLE "landing_domains"
    ALTER COLUMN "landing_page_id" DROP NOT NULL;

-- Adiciona tags pra organização por nicho/status (sugestão do usuário):
--   nickname: apelido user-friendly ("dominio-beleza-#1", "vigorax-fresh")
--   tags: array de labels ("beleza", "queimado", "meta-ban", "fresh")
--   notes: texto livre pra observações
ALTER TABLE "landing_domains"
    ADD COLUMN IF NOT EXISTS "nickname" text,
    ADD COLUMN IF NOT EXISTS "tags" text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS "notes" text,
    ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;

-- Index parcial pra alertas de expiração (vencendo em 30 dias).
CREATE INDEX IF NOT EXISTS "idx_landing_domains_expiring"
  ON "landing_domains" ("expires_at")
  WHERE "expires_at" IS NOT NULL;

COMMIT;
