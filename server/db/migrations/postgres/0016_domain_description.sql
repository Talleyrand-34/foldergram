-- migrate:up
-- 0016_domain_description.sql — human-authored description for a domain.
--
-- Each ai_domain_nodes row gains a `description` column (free-form text)
-- the admin can fill in to document what this domain represents
-- ("reggaeton music videos from the Caribbean", "deepfakes and
-- comedic edits", etc.). The analyzer never touches this column; it's
-- purely human-curated knowledge.

ALTER TABLE ai_domain_nodes ADD COLUMN IF NOT EXISTS description TEXT;

-- migrate:down

ALTER TABLE ai_domain_nodes DROP COLUMN IF EXISTS description;
