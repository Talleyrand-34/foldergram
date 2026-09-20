-- migrate:up
-- 0015_folder_ai_overrides.sql — user-overridable AI fields for a folder.
--
-- The rollup holds both the AI-generated values (rolled up from the
-- analyzed videos in the folder) and, optionally, a human-authored
-- override. When the override is present, the UI shows that instead of
-- the AI value — the AI value is still kept around so the user can
-- compare, undo, or hand-pick which parts to keep.
--
-- These columns are nullable. Empty / null means "no override, show AI".

ALTER TABLE ai_folder_rollup ADD COLUMN user_summary TEXT;
ALTER TABLE ai_folder_rollup ADD COLUMN user_domains TEXT;     -- JSON array
ALTER TABLE ai_folder_rollup ADD COLUMN user_language TEXT;     -- ISO 639-1

-- migrate:down

ALTER TABLE ai_folder_rollup DROP COLUMN user_language;
ALTER TABLE ai_folder_rollup DROP COLUMN user_domains;
ALTER TABLE ai_folder_rollup DROP COLUMN user_summary;
