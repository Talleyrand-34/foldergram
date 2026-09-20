-- migrate:up
-- 0014_ai_knowledge.sql — per-folder rollup + domain knowledge graph.
--
-- Three tables:
--   ai_folder_rollup   — one row per folder, aggregates every analyzed video in
--                          that folder (summary, top domains, dominant language,
--                          counts, last-updated). Refreshed after each analyze.
--   ai_domain_nodes    — one row per distinct domain path (e.g. 'music/reggaeton').
--                          Tracks how many videos mention it, in how many distinct
--                          folders, when first/last seen, and which languages it
--                          co-occurs with.
--   ai_domain_edges    — undirected co-occurrence between two domains. The count
--                          is how many videos mention BOTH; useful for graph
--                          traversal later ("what lives near music/reggaeton?").
--
-- Updates are append-on-analyze: domain node counts increment, edge counts
-- increment for every (d1, d2) pair, and the folder rollup is fully
-- recomputed from current rows. No background reconciliation needed.

CREATE TABLE IF NOT EXISTS ai_folder_rollup (
  folder_id BIGINT PRIMARY KEY,
  summary TEXT,
  top_domains TEXT,
  language TEXT,
  video_count INTEGER NOT NULL DEFAULT 0,
  analyzed_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_domain_nodes (
  domain TEXT PRIMARY KEY,
  video_count INTEGER NOT NULL DEFAULT 0,
  folder_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  languages TEXT
);

CREATE TABLE IF NOT EXISTS ai_domain_edges (
  source_domain TEXT NOT NULL,
  target_domain TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_domain, target_domain)
);

CREATE INDEX IF NOT EXISTS idx_ai_domain_edges_target ON ai_domain_edges (target_domain);

-- migrate:down

DROP INDEX IF EXISTS idx_ai_domain_edges_target;
DROP TABLE IF EXISTS ai_domain_edges;
DROP TABLE IF EXISTS ai_domain_nodes;
DROP TABLE IF EXISTS ai_folder_rollup;
