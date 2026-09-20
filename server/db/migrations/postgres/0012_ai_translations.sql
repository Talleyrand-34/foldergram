-- migrate:up
-- 0012_ai_translations.sql — locale-aware AI summary translations.
--
-- ai_summary remains the native-language summary. ai_summary_en and
-- ai_summary_es are populated when the source language differs; either
-- may be null. The client picks the row that matches the viewer's locale.

ALTER TABLE images ADD COLUMN IF NOT EXISTS ai_summary_en TEXT;
ALTER TABLE images ADD COLUMN IF NOT EXISTS ai_summary_es TEXT;

CREATE INDEX IF NOT EXISTS idx_images_ai_summary_en_trgm
  ON images USING GIN (ai_summary_en gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_images_ai_summary_es_trgm
  ON images USING GIN (ai_summary_es gin_trgm_ops);

-- migrate:down

DROP INDEX IF EXISTS idx_images_ai_summary_es_trgm;
DROP INDEX IF EXISTS idx_images_ai_summary_en_trgm;

ALTER TABLE images DROP COLUMN IF EXISTS ai_summary_es;
ALTER TABLE images DROP COLUMN IF EXISTS ai_summary_en;
