-- Migration 0063 — landing_pages.translation_status + progress + initial flags
--
-- Fase S.2 + Fase T (set/2026): tradução integrada ao pipeline de clone.
--
-- ANTES: tradução era 2 endpoints separados (translate-text sync no Vercel +
-- translate-images SSE só-dev). Nenhum campo no DB pra rastrear estado ou
-- progresso. UI fazia reload cego de 60s.
--
-- AGORA:
--   - translation_status: estado da máquina (idle → text_pending → text_running
--     → images_pending → images_running → done | done_with_warnings | failed).
--   - translation_progress: jsonb com contadores {phase, imagesDone, imagesTotal,
--     imagesFailed, imagesSkipped, stringsTranslated, costUsd, message}.
--   - initial_target_language: idioma escolhido no WIZARD antes do clone
--     (rodado pelo clone processor logo após o clone terminar).
--   - initial_translate_images: flag do wizard indicando se deve enfileirar
--     translate-images após translate-text.
--
-- target_language (já existe, migration 0047) continua sendo o idioma "atual"
-- do html_body. initial_target_language é a INTENÇÃO do usuário no clone —
-- só existe pro chain de jobs saber se deve rodar tradução ou não.
--
-- Article IV: enum em CHECK constraint, defaults seguros pra rows legadas
-- (translation_status='idle', initial_translate_images=false).

ALTER TABLE landing_pages
  ADD COLUMN IF NOT EXISTS translation_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (translation_status IN (
      'idle',
      'text_pending',
      'text_running',
      'images_pending',
      'images_running',
      'done',
      'done_with_warnings',
      'failed'
    ));

ALTER TABLE landing_pages
  ADD COLUMN IF NOT EXISTS translation_progress JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE landing_pages
  ADD COLUMN IF NOT EXISTS initial_target_language TEXT
    CHECK (initial_target_language IS NULL OR initial_target_language IN (
      'en', 'de', 'it', 'fr', 'es', 'ja', 'zh', 'pt-BR', 'pt'
    ));

ALTER TABLE landing_pages
  ADD COLUMN IF NOT EXISTS initial_translate_images BOOLEAN NOT NULL DEFAULT false;

-- Índice parcial: UI precisa polar todas landings com tradução em andamento
-- (evita full-scan). Só landings ATIVAS (não idle/done) aparecem.
CREATE INDEX IF NOT EXISTS idx_landing_pages_translation_active
  ON landing_pages (store_id, translation_status, updated_at)
  WHERE translation_status IN (
    'text_pending', 'text_running', 'images_pending', 'images_running'
  );

COMMENT ON COLUMN landing_pages.translation_status IS
  'Estado da máquina de tradução. idle=nunca traduzida ou traduzida há tempos; done_with_warnings=algumas imagens falharam mas landing publicável; failed=erro fatal. UI polleia enquanto status in (text_pending, text_running, images_pending, images_running).';

COMMENT ON COLUMN landing_pages.translation_progress IS
  'Contadores ao vivo do processamento: {phase, imagesDone, imagesTotal, imagesFailed, imagesSkipped, stringsTranslated, costUsd, message, lastUpdatedAt}. Zerado no início de cada job.';

COMMENT ON COLUMN landing_pages.initial_target_language IS
  'Idioma-alvo escolhido no Wizard antes do clone. Usado pelo clone processor pra decidir se enfileira translate-text após o clone. NULL = sem tradução automática.';

COMMENT ON COLUMN landing_pages.initial_translate_images IS
  'Flag do Wizard indicando se translate-images deve rodar automaticamente após translate-text. Só efetivo quando initial_target_language também está setado.';
