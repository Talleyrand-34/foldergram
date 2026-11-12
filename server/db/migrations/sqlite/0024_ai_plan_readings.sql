-- migrate:up
-- The readings of the provider's plan.
--
-- The plan publishes how much of each of its windows is left, as whole
-- percentages. The rate it is being spent at — and with it the answer to
-- "when does this run out" — is the difference between two readings, so
-- the readings have to outlive the process that took them: without this
-- the projection was gone for an hour and a half after every restart.
--
-- One row per window per reading. The window is identified by its start
-- time, because a window that has rolled over is a different window and
-- comparing across the rollover would say the plan had been refilled.
CREATE TABLE IF NOT EXISTS ai_plan_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  window_kind TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  remaining_percent REAL NOT NULL,
  read_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_plan_readings
  ON ai_plan_readings(provider_id, window_kind, window_start, read_at);

-- migrate:down
DROP INDEX IF EXISTS idx_ai_plan_readings;
DROP TABLE IF EXISTS ai_plan_readings;
