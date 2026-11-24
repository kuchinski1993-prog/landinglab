-- Migration 0040 — Color schemes (Fase 1).
--
-- Base: docs/research/2026-07-10-theme-editor-shopify-parity.md §2.
--
-- Zero regressão visual: o scheme "default" é backfilado copiando os 6
-- tokens de cor atuais (colorBackground, colorText, colorButton,
-- colorButtonText, cardBorderColor). Como toda seção sem
-- settings.colorScheme cai no defaultColorScheme, a renderização fica
-- idêntica ao estado pré-0040.
--
-- Idempotente: WHERE NOT (tokens ? 'colorSchemes').
--
-- Sanity check: aborta se algum tema ficar sem defaultColorScheme após
-- o backfill (proteção contra corrida ou erro no jsonb_set).

BEGIN;

-- ── 1. Backfill: adiciona colorSchemes + defaultColorScheme por tema ─────
-- Cada tema ganha 4 schemes iniciais:
--   default  → cópia fiel dos 6 tokens de cor atuais (shadow neutro).
--   creme    → paleta Riviera / old-money.
--   escuro   → inverso do padrão.
--   destaque → ouro sobre fundo grafite (accent).
-- Cliente pode editar/deletar (exceto 'default') pela UI depois.

UPDATE themes
SET tokens = jsonb_set(
  jsonb_set(
    tokens,
    '{colorSchemes}',
    jsonb_build_array(
      jsonb_build_object(
        'id',          'default',
        'name',        'Padrão',
        'background',  COALESCE(NULLIF(tokens->>'colorBackground', ''), '#ffffff'),
        'text',        COALESCE(NULLIF(tokens->>'colorText',       ''), '#111827'),
        'heading',     COALESCE(NULLIF(tokens->>'colorText',       ''), '#111827'),
        'button',      COALESCE(NULLIF(tokens->>'colorButton',     ''), '#111827'),
        'buttonText',  COALESCE(NULLIF(tokens->>'colorButtonText', ''), '#ffffff'),
        'border',      COALESCE(NULLIF(tokens->>'cardBorderColor', ''), '#e5e7eb'),
        'shadow',      '0,0,0'
      ),
      jsonb_build_object(
        'id',          'creme',
        'name',        'Creme',
        'background',  '#f7f2ea',
        'text',        '#3a2f24',
        'heading',     '#1e1710',
        'button',      '#1e1710',
        'buttonText',  '#f7f2ea',
        'border',      '#e5dccc',
        'shadow',      '30,23,16'
      ),
      jsonb_build_object(
        'id',          'escuro',
        'name',        'Escuro',
        'background',  '#111827',
        'text',        '#d1d5db',
        'heading',     '#ffffff',
        'button',      '#ffffff',
        'buttonText',  '#111827',
        'border',      '#374151',
        'shadow',      '0,0,0'
      ),
      jsonb_build_object(
        'id',          'destaque',
        'name',        'Destaque',
        'background',  '#1a1a1a',
        'text',        '#d4af37',
        'heading',     '#d4af37',
        'button',      '#d4af37',
        'buttonText',  '#111827',
        'border',      '#3a3a3a',
        'shadow',      '0,0,0'
      )
    ),
    true
  ),
  '{defaultColorScheme}',
  to_jsonb(text 'default'),
  true
)
WHERE NOT (tokens ? 'colorSchemes');

-- ── 2. Sanity check: todo tema tem defaultColorScheme após o backfill ───
-- Só verifica a existência da chave; não fixa valor (cliente pode ter
-- editado o esquema padrão antes de rodar). Rerun é seguro.

DO $$
DECLARE broken int;
BEGIN
  SELECT count(*) INTO broken
    FROM themes
   WHERE NOT (tokens ? 'defaultColorScheme');
  IF broken > 0 THEN
    RAISE EXCEPTION
      'Backfill incompleto: % themes sem defaultColorScheme. Migration abortada.',
      broken;
  END IF;
END $$;

-- ── 3. Sanity check: nenhuma theme_section com colorScheme órfão ────────
-- Antes da 0040 nenhuma section tem settings.colorScheme, então esta
-- checagem só protege reruns futuros ou dados injetados por script.
--
-- theme_sections.settings->>'colorScheme' precisa existir na lista
-- themes.tokens.colorSchemes[].id do theme dono da seção.

DO $$
DECLARE orphans int;
BEGIN
  SELECT count(*) INTO orphans
    FROM theme_sections ts
    JOIN themes t ON t.id = ts.theme_id
   WHERE ts.settings ? 'colorScheme'
     AND ts.settings->>'colorScheme' NOT IN (
       SELECT jsonb_array_elements(t.tokens->'colorSchemes')->>'id'
     );
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'Backfill incompleto: % theme_sections apontam para colorScheme inexistente. Migration abortada.',
      orphans;
  END IF;
END $$;

COMMIT;
