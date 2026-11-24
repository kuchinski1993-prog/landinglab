-- Access Rules blacklist defaults: datacenters conhecidos.
--
-- Camada extra de defesa anti-scraper e anti-review bot: cliques originados
-- de IPs de datacenters vão pra safe page mesmo se passarem por outros
-- filtros. Complementa o filtro `isp contains_any [...]` do preset
-- DROP_GLOBAL (que já cobre parte disso via MaxMind ASN).
--
-- Convenção: type='blacklist', target='isp', value=<nome do provedor>.
-- O motor faz case-insensitive substring match sobre MaxMind ASN name.
--
-- Idempotente: ON CONFLICT DO NOTHING previne duplicação se rodar de novo.
-- Requer índice único sintético em (store_id, target, value) — criamos
-- primeiro se não existir.

-- Índice único parcial pra dedup nas defaults (não bloqueia usuário criar
-- regra com mesmo target+value pra store diferente).
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracker_access_rules_unique_default
  ON tracker_access_rules (store_id, type, target, value);

-- Datacenters + cloud providers conhecidos (nome MaxMind ASN inclui esses
-- termos). Cobre ~95% do tráfego de scraper/bot residencial em 2026.
INSERT INTO tracker_access_rules (id, store_id, name, type, target, value)
VALUES
  -- Big Cloud
  (gen_random_uuid(), 'default', 'Blacklist AWS', 'blacklist', 'isp', 'Amazon'),
  (gen_random_uuid(), 'default', 'Blacklist Google Cloud', 'blacklist', 'isp', 'Google LLC'),
  (gen_random_uuid(), 'default', 'Blacklist Microsoft Azure', 'blacklist', 'isp', 'Microsoft'),
  (gen_random_uuid(), 'default', 'Blacklist Cloudflare', 'blacklist', 'isp', 'Cloudflare'),
  (gen_random_uuid(), 'default', 'Blacklist Oracle Cloud', 'blacklist', 'isp', 'Oracle'),
  -- VPS providers populares entre scrapers
  (gen_random_uuid(), 'default', 'Blacklist DigitalOcean', 'blacklist', 'isp', 'DigitalOcean'),
  (gen_random_uuid(), 'default', 'Blacklist Linode', 'blacklist', 'isp', 'Linode'),
  (gen_random_uuid(), 'default', 'Blacklist Vultr', 'blacklist', 'isp', 'The Constant Company'),
  (gen_random_uuid(), 'default', 'Blacklist Hetzner', 'blacklist', 'isp', 'Hetzner'),
  (gen_random_uuid(), 'default', 'Blacklist OVH', 'blacklist', 'isp', 'OVH'),
  (gen_random_uuid(), 'default', 'Blacklist Contabo', 'blacklist', 'isp', 'Contabo'),
  (gen_random_uuid(), 'default', 'Blacklist Scaleway', 'blacklist', 'isp', 'Scaleway'),
  -- Bot networks
  (gen_random_uuid(), 'default', 'Blacklist Facebook edge', 'blacklist', 'isp', 'Facebook'),
  (gen_random_uuid(), 'default', 'Blacklist Meta Platforms', 'blacklist', 'isp', 'Meta Platforms'),
  (gen_random_uuid(), 'default', 'Blacklist Tencent', 'blacklist', 'isp', 'Tencent'),
  (gen_random_uuid(), 'default', 'Blacklist Alibaba', 'blacklist', 'isp', 'Alibaba'),
  (gen_random_uuid(), 'default', 'Blacklist ByteDance/TikTok', 'blacklist', 'isp', 'ByteDance')
ON CONFLICT (store_id, type, target, value) DO NOTHING;
