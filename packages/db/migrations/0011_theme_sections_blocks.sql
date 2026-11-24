ALTER TABLE theme_sections
  ADD COLUMN blocks JSONB NOT NULL DEFAULT '[]';
