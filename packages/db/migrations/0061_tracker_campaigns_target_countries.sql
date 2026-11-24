-- Adiciona target_countries em tracker_campaigns.
--
-- Array de ISO 3166-1 alpha-2 (BR, CL, PE, ...). Vazio (default) = campanha
-- global sem geolock. Preenchido = auto-preset injeta filtro extra no White
-- Page bloqueando cliques de fora dos target countries.
--
-- Uppercase enforced pelo backend (MaxMind retorna upper) — mas guardamos
-- como text[] pra não amarrar com CHECK constraint.

ALTER TABLE tracker_campaigns
  ADD COLUMN IF NOT EXISTS target_countries text[] NOT NULL DEFAULT '{}';

-- Index parcial: só campanhas com pelo menos 1 país. Consulta rara
-- (usada em analytics futura tipo "quais campanhas rodam no Chile").
CREATE INDEX IF NOT EXISTS idx_tracker_campaigns_target_countries
  ON tracker_campaigns USING gin (target_countries)
  WHERE array_length(target_countries, 1) > 0;
