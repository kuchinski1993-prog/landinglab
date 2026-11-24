-- Migration 0038 — Ficha técnica do produto (Wave 3 do enriquecimento da PDP).
--
-- Alimenta o bloco product-tech-sheet: composição do tecido, país de
-- origem, país de fabricação, instruções de cuidado, peso.
--
-- Por que agora: os mesmos campos serão exigidos pelo Digital Product
-- Passport (ESPR/EU, requisitos publicados em 2026, aplicação para têxteis
-- 2027-2028). Antecipar a estrutura evita retrabalho e ganha SEO no curto
-- prazo. Nenhum campo faz alegação ambiental automática — o dono
-- preenche apenas o que o fornecedor informou. Diretiva de Alegações
-- Verdes (transposição 2026) proíbe alegação não fundamentada.
--
-- Aditiva pura, idempotente. Tudo nullable — produtos existentes
-- continuam válidos; o bloco só renderiza colunas com valor.

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "fabric_composition"    text;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "origin_country"        text;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "manufacturing_country" text;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "care_instructions"     text;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "weight_grams"          integer;
