-- migrate:up

-- The PostgreSQL dialect installs the `pg_trgm` extension in this migration
-- (see db/migrations/postgres/0010_postgres_extensions.sql). SQLite has no
-- extensions, so there is nothing to do here - the migration exists so that
-- both dialects carry the same set of migration versions.

SELECT 1;

-- migrate:down

-- Nothing to undo.
