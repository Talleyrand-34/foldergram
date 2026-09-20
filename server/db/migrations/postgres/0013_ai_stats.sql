-- migrate:up
-- 0013_ai_stats.sql — per-video analysis event log for debugging and tuning.
--
-- One row per completed or failed analysis. Used to answer:
--   - which languages are common, what does the model do well/poorly on
--   - which stages are slow (frame extraction / whisper / llm)
--   - token usage trends over time
--   - error rates and kinds (transcribe failure, llm parse failure, network)
--
-- Aggregation is done in the stats endpoint via SQL — no app-side rollups.
-- The table is append-only; pruning is up to ops.

CREATE TABLE IF NOT EXISTS ai_analysis_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('completed', 'failed')),
  image_id BIGINT,
  folder_id BIGINT,
  language TEXT,
  domain_count INTEGER,
  duration_ms INTEGER,
  frame_extract_ms INTEGER,
  audio_extract_ms INTEGER,
  whisper_ms INTEGER,
  llm_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  model TEXT,
  error_kind TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_events_created_at ON ai_analysis_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_events_event_type ON ai_analysis_events (event_type);
CREATE INDEX IF NOT EXISTS idx_ai_events_language ON ai_analysis_events (language) WHERE language IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_events_image_id ON ai_analysis_events (image_id);

-- migrate:down

DROP INDEX IF EXISTS idx_ai_events_image_id;
DROP INDEX IF EXISTS idx_ai_events_language;
DROP INDEX IF EXISTS idx_ai_events_event_type;
DROP INDEX IF EXISTS idx_ai_events_created_at;

DROP TABLE IF EXISTS ai_analysis_events;
