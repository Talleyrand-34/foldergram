-- migrate:up
-- 0018_laya_canonicalization.sql — capture laya's canonicalization results.
--
-- When M3 proposes a domain string that laya classifies, we record:
--   1. The original (M3's wording)
--   2. The canonical (laya's decision: existing match, or new domain to register)
--   3. The status: "match" | "alias" | "new"
--   4. The confidence (laya's reported probability)
--   5. The reason (laya's optional explanation for alias/new)
--
-- Plus a synonym-pending table for aliases awaiting admin confirmation.

ALTER TABLE ai_analysis_events ADD COLUMN laya_classification TEXT;
-- JSON shape: {"domains":[{"original":"x","status":"match|alias|new","canonical":"y","confidence":0.92,"reason":"..."}], "language":{"status":"known|new","canonical":"es","confidence":0.99}}

ALTER TABLE ai_domain_nodes ADD COLUMN first_seen_via_laya TEXT;
-- NULL = added by analyzer before laya existed; "match" = recognized; "new" = registered by laya

-- SQLite has no BIGSERIAL/BIGINT/TIMESTAMPTZ; the repo's SQLite migrations
-- use INTEGER ids and TEXT timestamps with a CURRENT_TIMESTAMP default.
CREATE TABLE ai_synonym_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_domain TEXT NOT NULL,
  proposed_alias TEXT NOT NULL,
  source_video_id INTEGER,
  confidence REAL,
  reason TEXT,
  detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  resolved_at TEXT,
  UNIQUE (canonical_domain, proposed_alias)
);

CREATE INDEX idx_synonym_pending_status ON ai_synonym_pending (status, detected_at DESC);

-- migrate:down

DROP INDEX IF EXISTS idx_synonym_pending_status;
DROP TABLE IF EXISTS ai_synonym_pending;
ALTER TABLE ai_domain_nodes DROP COLUMN IF EXISTS first_seen_via_laya;
ALTER TABLE ai_analysis_events DROP COLUMN IF EXISTS laya_classification;
