-- migrate:up
-- 0020_provider_usage.sql — attribute each analysis event to the provider
-- that spent the tokens.
--
-- Why: the usage limits are per provider. MiniMax's plan counts tokens
-- against its own window, Ollama's against nothing at all, and a local
-- gateway has its own budget again. Without knowing which provider spent
-- what, a limit cannot be enforced per provider — the numbers would be one
-- undifferentiated pool.
--
-- `provider_id` is the plugin's provider id (the slug in the configuration),
-- NOT the model name: one provider serves several models, and the limits
-- belong to the provider.
--
-- The column is nullable: the events recorded before this migration have no
-- provider, and the older rows stay where they are.

ALTER TABLE ai_analysis_events ADD COLUMN provider_id TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_events_provider
  ON ai_analysis_events (provider_id, created_at DESC)
  WHERE provider_id IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS idx_ai_events_provider;

ALTER TABLE ai_analysis_events DROP COLUMN provider_id;
