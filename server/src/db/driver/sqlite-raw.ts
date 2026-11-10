import { DatabaseSync } from 'node:sqlite';

/**
 * The single place in `server/src` that is allowed to talk to a raw SQLite
 * handle.
 *
 * Everything above this module (the repository layer, the services, the
 * routes) goes through the `IDbDriver` abstraction so the same code can run
 * on PostgreSQL. The helpers below exist for the three places that genuinely
 * need SQLite specific access:
 *
 *  - the migration bootstrap (`schema_migrations` bookkeeping),
 *  - the legacy schema compatibility checks (`sqlite_master`, `PRAGMA`), and
 *  - the optional offline geodata database.
 *
 * `server/test/migration-safety.test.ts` enforces that no other file calls
 * `database.prepare(...)` again.
 */

export type SqlitePreparedStatement = ReturnType<DatabaseSync['prepare']>;

export function sqlitePrepare(database: DatabaseSync, sql: string): SqlitePreparedStatement {
  return database.prepare(sql);
}

export function sqliteAll(
  database: DatabaseSync,
  sql: string,
  ...params: Array<string | number | bigint | null | Uint8Array>
): Array<Record<string, unknown>> {
  return database.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

export function sqliteGet(
  database: DatabaseSync,
  sql: string,
  ...params: Array<string | number | bigint | null | Uint8Array>
): Record<string, unknown> | undefined {
  return database.prepare(sql).get(...params) as Record<string, unknown> | undefined;
}

export function sqliteRun(
  database: DatabaseSync,
  sql: string,
  ...params: Array<string | number | bigint | null | Uint8Array>
): void {
  database.prepare(sql).run(...params);
}
