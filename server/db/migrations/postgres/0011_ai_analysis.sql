-- migrate:up
-- 0011_ai_analysis.sql — AI analysis metadata for the ai-analysis plugin.
--
-- Columns live on `images` so a video inherits them just by being indexed.
-- In Postgres we expose GIN indexes on the parsed shape via generated columns.

ALTER TABLE images ADD COLUMN IF NOT EXISTS ai_status TEXT;
ALTER TABLE images ADD COLUMN IF NOT EXISTS ai_summary TEXT;
ALTER TABLE images ADD COLUMN IF NOT EXISTS ai_domains TEXT;
ALTER TABLE images ADD COLUMN IF NOT EXISTS ai_tags TEXT;
ALTER TABLE images ADD COLUMN IF NOT EXISTS ai_language TEXT;
ALTER TABLE images ADD COLUMN IF NOT EXISTS ai_sentiment TEXT;
ALTER TABLE images ADD COLUMN IF NOT EXISTS ai_transcript TEXT;
ALTER TABLE images ADD COLUMN IF NOT EXISTS ai_model TEXT;
ALTER TABLE images ADD COLUMN IF NOT EXISTS ai_usage_tokens INTEGER;
ALTER TABLE images ADD COLUMN IF NOT EXISTS ai_error TEXT;
ALTER TABLE images ADD COLUMN IF NOT EXISTS ai_analyzed_at TIMESTAMPTZ;
ALTER TABLE images ADD COLUMN IF NOT EXISTS ai_analyzed_mtime_ms BIGINT;

ALTER TABLE images
  ADD COLUMN IF NOT EXISTS ai_domains_jsonb JSONB
  GENERATED ALWAYS AS (
    CASE WHEN ai_domains IS NULL THEN NULL ELSE ai_domains::jsonb END
  ) STORED;
ALTER TABLE images
  ADD COLUMN IF NOT EXISTS ai_tags_jsonb JSONB
  GENERATED ALWAYS AS (
    CASE WHEN ai_tags IS NULL THEN NULL ELSE ai_tags::jsonb END
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_images_ai_status ON images (ai_status) WHERE media_type = 'video';
CREATE INDEX IF NOT EXISTS idx_images_ai_domains_gin ON images USING GIN (ai_domains_jsonb);
CREATE INDEX IF NOT EXISTS idx_images_ai_tags_gin ON images USING GIN (ai_tags_jsonb);
CREATE INDEX IF NOT EXISTS idx_images_ai_summary_trgm ON images USING GIN (ai_summary gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_images_ai_transcript_trgm ON images USING GIN (ai_transcript gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_images_ai_analyzed_at ON images (ai_analyzed_at) WHERE ai_status = 'ok';

-- migrate:down

DROP INDEX IF EXISTS idx_images_ai_analyzed_at;
DROP INDEX IF EXISTS idx_images_ai_transcript_trgm;
DROP INDEX IF EXISTS idx_images_ai_summary_trgm;
DROP INDEX IF EXISTS idx_images_ai_tags_gin;
DROP INDEX IF EXISTS idx_images_ai_domains_gin;
DROP INDEX IF EXISTS idx_images_ai_status;

ALTER TABLE images DROP COLUMN IF EXISTS ai_tags_jsonb;
ALTER TABLE images DROP COLUMN IF EXISTS ai_domains_jsonb;

ALTER TABLE images DROP COLUMN IF EXISTS ai_analyzed_mtime_ms;
ALTER TABLE images DROP COLUMN IF EXISTS ai_analyzed_at;
ALTER TABLE images DROP COLUMN IF EXISTS ai_error;
ALTER TABLE images DROP COLUMN IF EXISTS ai_usage_tokens;
ALTER TABLE images DROP COLUMN IF EXISTS ai_model;
ALTER TABLE images DROP COLUMN IF EXISTS ai_transcript;
ALTER TABLE images DROP COLUMN IF EXISTS ai_sentiment;
ALTER TABLE images DROP COLUMN IF EXISTS ai_language;
ALTER TABLE images DROP COLUMN IF EXISTS ai_tags;
ALTER TABLE images DROP COLUMN IF EXISTS ai_domains;
ALTER TABLE images DROP COLUMN IF EXISTS ai_summary;
ALTER TABLE images DROP COLUMN IF EXISTS ai_status;
