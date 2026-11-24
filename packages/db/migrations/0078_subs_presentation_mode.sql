-- migration 0078: subscription presentation mode fields
-- Adiciona campos para controlar comportamento visual do widget de assinatura.
-- subs_preselected: checkbox pré-marcado no page load.
-- subs_discount_percent: percentual numérico para cálculo de preço visual.
--   subs_discount_label (migration anterior) é mantido por backward-compat mas
--   subs_discount_percent passa a ser a fonte autoritativa do cálculo.

ALTER TABLE "landing_pages"
  ADD COLUMN IF NOT EXISTS "subs_preselected" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "subs_discount_percent" integer;

COMMENT ON COLUMN landing_pages.subs_preselected
  IS 'Se true, o widget Subscribe & Save nasce pré-selecionado no page load (opt-out). Se false, nasce desmarcado (opt-in).';

COMMENT ON COLUMN landing_pages.subs_discount_percent
  IS 'Percentual de desconto visual (0-99) para cálculo de preço no widget. Fonte autoritativa para JS de pricing. subs_discount_label é mantido por compat mas este campo prevalece.';
