BEGIN;

-- ── Avaliações de produtos ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_reviews (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    text        NOT NULL DEFAULT 'default',
  product_id  uuid        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  author_name text        NOT NULL,
  rating      integer     NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title       text,
  comment     text        NOT NULL,
  status      text        NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_reviews_product
  ON product_reviews(product_id, status);

CREATE INDEX IF NOT EXISTS idx_product_reviews_store
  ON product_reviews(store_id, status);

-- ── Perguntas e Respostas ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_questions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    text        NOT NULL DEFAULT 'default',
  product_id  uuid        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  author_name text        NOT NULL,
  question    text        NOT NULL,
  answer      text,
  answered_at timestamptz,
  status      text        NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_questions_product
  ON product_questions(product_id, status);

CREATE INDEX IF NOT EXISTS idx_product_questions_store
  ON product_questions(store_id, status);

COMMIT;
