# Server test harness

Reusable helpers that let a test run against **SQLite** (embedded default) and
**PostgreSQL** (the target dialect) with the exact same assertions.

The project is PostgreSQL-first: SQLite is being dropped. Everything in here
exists so that a dialect difference cannot ship unnoticed.

## Files

| File | Purpose |
| --- | --- |
| `temp-data-root.ts` | Creates an isolated data root (`DATA_ROOT`, `GALLERY_ROOT`, `DB_DIR`, `THUMBNAILS_DIR`, `PREVIEWS_DIR`) and points the environment at it. |
| `dialect.ts` | Resolves the dialect, probes a PostgreSQL server, creates/drops an isolated schema. |
| `db-harness.ts` | `createDatabaseHarness()` - temp data root + migrated repositories for the chosen dialect + deterministic teardown. |

## Usage

```ts
import { createDatabaseHarness } from './helpers/db-harness.js';

const harness = await createDatabaseHarness({ dialect: 'sqlite' });

try {
  await harness.repositories.folderRepository.upsert({ slug: 'a', name: 'A', folderPath: 'a' });
} finally {
  await harness.close();
}
```

`close()` closes the database handle (including the PostgreSQL connection
pool), restores the environment and removes the temporary data root, so no
handle leaks and no state is shared with the next test file.

## Running against PostgreSQL

The dialect is derived from the environment:

* `DB_DRIVER=postgres` or a non-empty `DATABASE_URL` selects PostgreSQL,
* otherwise SQLite is used.

```bash
# SQLite (default)
corepack pnpm --filter @foldergram/server test

# PostgreSQL
DB_DRIVER=postgres \
DATABASE_URL=postgresql://foldergram:foldergram@localhost:5432/foldergram?sslmode=disable \
  corepack pnpm --filter @foldergram/server test

# only the dialect parity test
corepack pnpm --filter @foldergram/server test:pg:parity
```

### Starting a local PostgreSQL

```bash
docker compose -f docker-compose.postgres.yml up -d postgres
```

That provides `postgresql://foldergram:foldergram@localhost:5432/foldergram?sslmode=disable`
(role `foldergram`, password `foldergram`, database `foldergram`).

When no PostgreSQL server is reachable, the parity test **skips** with the
exact command needed to start one - it never fails because of a missing
database.

### Isolation

The parity test creates a dedicated PostgreSQL **schema** (not a database) and
connects with `search_path` pointing at it, so it works with a non-superuser
role and never touches the application schema. The schema is dropped again
afterwards.
