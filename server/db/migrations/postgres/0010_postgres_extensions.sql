-- migrate:up

-- The trigram indexes of the AI analysis migration need `pg_trgm`.
--
-- The extension is created in its own migration on purpose: a migration is
-- sent to the server as a whole and is parsed *before* it runs, so the
-- operator class has to exist before the migration that uses it is parsed.
-- Creating it in the same file as the indexes would fail on a database where
-- the extension does not exist yet - and it would race with the other test
-- files that migrate the same database in parallel.
--
-- It is pinned to `public` because the operator classes of an extension live
-- in the schema it was installed in, and `public` is the schema that stays on
-- the search path of every connection.
--
-- `CREATE EXTENSION IF NOT EXISTS` decides whether it has to create the
-- extension when the statement is parsed, so a parallel migration that
-- installs the extension in between still runs into "extension already
-- exists". That is why the creation is wrapped: the error is the expected
-- outcome of the race and not a failure of the migration.
DO $ensure_extension$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public;
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END
$ensure_extension$;

-- migrate:down

-- The extension belongs to the database, not to this migration: it stays.
