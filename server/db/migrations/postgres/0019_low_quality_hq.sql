-- migrate:up
-- 0019_low_quality_hq.sql — store high-quality re-analysis alongside the
-- original analysis. Triggered when the initial 3-frame analysis produced
-- a "low" quality signal (high inter-frame variance, low transcript quality,
-- etc.).
--
-- Convention:
--   - ai_summary, ai_domains, ai_summary_en/es = original 3-frame analysis
--     (set by the first M3 call; preserved unchanged)
--   - ai_summary_hq, ai_domains_hq, ai_summary_hq_en/es = high-quality
--     re-analysis with 8-12 frames; NULL until reanalysis runs
--   - ai_frame_quality = 'high' | 'medium' | 'low' (single sample's score)
--   - ai_frame_similarity = avg pairwise dHash distance (0..1)
--   - ai_frames_used = number of frames in the latest analysis (3 default, 8+ for HQ)
--   - ai_reanalysis_count = times HQ was performed
--   - ai_reanalyzed_at = timestamp of latest HQ pass

ALTER TABLE images
  ADD COLUMN ai_frame_quality TEXT,
  ADD COLUMN ai_frame_similarity REAL,
  ADD COLUMN ai_reanalysis_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN ai_frames_used INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN ai_summary_hq TEXT,
  ADD COLUMN ai_summary_hq_en TEXT,
  ADD COLUMN ai_summary_hq_es TEXT,
  ADD COLUMN ai_domains_hq TEXT,
  ADD COLUMN ai_reanalyzed_at TIMESTAMPTZ;

-- migrate:down

ALTER TABLE images
  DROP COLUMN IF EXISTS ai_reanalyzed_at,
  DROP COLUMN IF EXISTS ai_domains_hq,
  DROP COLUMN IF EXISTS ai_summary_hq_es,
  DROP COLUMN IF EXISTS ai_summary_hq_en,
  DROP COLUMN IF EXISTS ai_summary_hq,
  DROP COLUMN IF EXISTS ai_frames_used,
  DROP COLUMN IF EXISTS ai_reanalysis_count,
  DROP COLUMN IF EXISTS ai_frame_similarity,
  DROP COLUMN IF EXISTS ai_frame_quality;
