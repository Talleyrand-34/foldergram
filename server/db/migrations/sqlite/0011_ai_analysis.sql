-- migrate:up
-- 0011_ai_analysis.sql — AI analysis metadata for the ai-analysis plugin.
--
-- Columns live on `images` so a video inherits them just by being indexed.
-- Status workflow: NULL → pending → running → ok | failed | skipped.
-- Re-analysis is gated by ai_analyzed_mtime_ms vs the source mtime_ms.

ALTER TABLE images ADD COLUMN ai_status TEXT;
ALTER TABLE images ADD COLUMN ai_summary TEXT;
ALTER TABLE images ADD COLUMN ai_domains TEXT;     -- JSON array of slash-notation paths
ALTER TABLE images ADD COLUMN ai_tags TEXT;        -- JSON array of lowercase tags
ALTER TABLE images ADD COLUMN ai_language TEXT;    -- ISO 639-1 or 'unknown'
ALTER TABLE images ADD COLUMN ai_sentiment TEXT;
ALTER TABLE images ADD COLUMN ai_transcript TEXT;
ALTER TABLE images ADD COLUMN ai_model TEXT;
ALTER TABLE images ADD COLUMN ai_usage_tokens INTEGER;
ALTER TABLE images ADD COLUMN ai_error TEXT;
ALTER TABLE images ADD COLUMN ai_analyzed_at TEXT;
ALTER TABLE images ADD COLUMN ai_analyzed_mtime_ms INTEGER;

CREATE INDEX IF NOT EXISTS idx_images_ai_status ON images (ai_status) WHERE media_type = 'video';
CREATE INDEX IF NOT EXISTS idx_images_ai_analyzed_at ON images (ai_analyzed_at) WHERE ai_status = 'ok';

-- migrate:down

DROP INDEX IF EXISTS idx_images_ai_analyzed_at;
DROP INDEX IF EXISTS idx_images_ai_status;

ALTER TABLE images DROP COLUMN ai_analyzed_mtime_ms;
ALTER TABLE images DROP COLUMN ai_analyzed_at;
ALTER TABLE images DROP COLUMN ai_error;
ALTER TABLE images DROP COLUMN ai_usage_tokens;
ALTER TABLE images DROP COLUMN ai_model;
ALTER TABLE images DROP COLUMN ai_transcript;
ALTER TABLE images DROP COLUMN ai_sentiment;
ALTER TABLE images DROP COLUMN ai_language;
ALTER TABLE images DROP COLUMN ai_tags;
ALTER TABLE images DROP COLUMN ai_domains;
ALTER TABLE images DROP COLUMN ai_summary;
ALTER TABLE images DROP COLUMN ai_status;
