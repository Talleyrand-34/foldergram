import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { POSTGRES_BOOLEAN_COLUMNS, preparePostgresSql } from '../src/db/driver/postgres-driver.js';
import {
  getPostgresMigrationsDirectory,
  getSqliteMigrationsDirectory
} from '../src/db/migration.js';

/**
 * Migration safety net.
 *
 * These checks fail loudly so that a PostgreSQL-first migration cannot
 * silently regress:
 *
 *  1. the repository layer must not go back to the old synchronous
 *     `database.prepare(...)` API,
 *  2. SQLite-only SQL must not leak into the shared repository/service layer,
 *  3. the PostgreSQL driver must keep rewriting placeholders and booleans,
 *  4. every migration has to exist for BOTH dialects.
 */

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(testDirectory, '..');
const repositoryRoot = path.resolve(serverRoot, '..');
const sourceRoot = path.join(serverRoot, 'src');
const migrationsRoot = path.join(serverRoot, 'db', 'migrations');

/**
 * The only file in `server/src` that may talk to a raw SQLite handle.
 *
 * Everything else goes through the `IDbDriver` abstraction so the same code
 * runs on PostgreSQL.
 */
const RAW_SQLITE_ALLOWLIST = new Set(['db/driver/sqlite-raw.ts']);

/**
 * Files that legitimately contain SQLite specific SQL.
 *
 * Each entry documents why the SQLite specific syntax is unavoidable there.
 */
const SQLITE_ONLY_SQL_ALLOWLIST = new Map<string, string>([
  ['db/driver/sqlite-raw.ts', 'raw SQLite adapter'],
  ['db/migration.ts', 'SQLite migration bootstrap (schema_migrations bookkeeping)'],
  ['db/schema-compat.ts', 'SQLite legacy schema introspection'],
  ['db/schema.ts', 'SQLite schema of the in-memory fallback database'],
  ['services/place-service.ts', 'optional offline geodata SQLite database']
]);

/**
 * Migrations that only exist for one dialect.
 *
 * These are PostgreSQL specific partial indexes; SQLite does not need them.
 * Any *new* dialect specific migration has to be listed here explicitly.
 */
const DIALECT_SPECIFIC_MIGRATIONS = new Map<string, string>([
  ['000003_scan_runs_index.sql', 'PostgreSQL only partial index'],
  ['000004_performance_indexes.sql', 'PostgreSQL only partial indexes'],
  ['000005_thumbnail_path_index.sql', 'PostgreSQL only partial index']
]);

interface SqliteOnlyPattern {
  readonly label: string;
  readonly pattern: RegExp;
}

const SQLITE_ONLY_PATTERNS: SqliteOnlyPattern[] = [
  { label: 'INSERT OR IGNORE', pattern: /INSERT\s+OR\s+IGNORE/i },
  { label: 'INSERT OR REPLACE', pattern: /INSERT\s+OR\s+REPLACE/i },
  { label: 'sqlite_master', pattern: /sqlite_master/i },
  { label: 'PRAGMA', pattern: /\bPRAGMA\b/i },
  { label: 'last_insert_rowid', pattern: /last_insert_rowid/i },
  { label: 'json_each', pattern: /json_each/i },
  { label: 'json_array', pattern: /json_array/i },
  { label: 'GLOB', pattern: /\bGLOB\b/i },
  { label: 'strftime(', pattern: /\bstrftime\s*\(/i },
  { label: 'datetime(', pattern: /\bdatetime\s*\(/i }
];

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true, recursive: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.relative(sourceRoot, path.join(entry.parentPath ?? entry.path, entry.name)));
}

function findSqliteOnlyUsages(source: string): string[] {
  return SQLITE_ONLY_PATTERNS.filter(({ pattern }) => pattern.test(source)).map(({ label }) => label);
}

/**
 * Removes the dialect fragment initialiser from the repository source.
 *
 * `initDialectFragments()` is the single place that spells out the SQLite and
 * the PostgreSQL variant of a construct, so SQLite-only SQL is expected there
 * - but only in the SQLite branch.
 */
function extractDialectFragments(source: string): { sqliteBranch: string; postgresBranch: string } | null {
  const start = source.indexOf('function initDialectFragments(');
  if (start === -1) {
    return null;
  }

  const end = source.indexOf('\n}\n', start);
  if (end === -1) {
    return null;
  }

  const body = source.slice(start, end);
  const elseIndex = body.indexOf('} else {');
  if (elseIndex === -1) {
    return null;
  }

  return {
    sqliteBranch: body.slice(0, elseIndex),
    postgresBranch: body.slice(elseIndex)
  };
}

/**
 * Removes the dialect fragments from a source file.
 *
 * The SQLite branch of the fragments is the only place where SQLite-only SQL
 * is allowed; the PostgreSQL branch is checked separately.
 */
function stripDialectFragments(relativePath: string, source: string): string {
  if (relativePath.split(path.sep).join('/') !== 'db/repositories.ts') {
    return source;
  }

  const fragments = extractDialectFragments(source);
  if (!fragments) {
    return source;
  }

  const start = source.indexOf('function initDialectFragments(');
  const end = source.indexOf('\n}\n', start);

  return source.slice(0, start) + source.slice(end);
}

describe('migration safety', () => {
  describe('repository layer stays on the driver abstraction', () => {
    it('never calls the raw SQLite prepare() API outside the SQLite adapter', async () => {
      const sourceFiles = await listSourceFiles(sourceRoot);
      const offenders: string[] = [];

      for (const relativePath of sourceFiles) {
        if (RAW_SQLITE_ALLOWLIST.has(relativePath.split(path.sep).join('/'))) {
          continue;
        }

        const source = await fs.readFile(path.join(sourceRoot, relativePath), 'utf8');
        const lines = source.split('\n');

        lines.forEach((line, index) => {
          // `geodataService.prepare()` is a service method, not a SQLite
          // statement, so only calls with an argument are considered.
          if (/\.prepare\s*\(\s*[^)\s]/.test(line)) {
            offenders.push(`${relativePath}:${index + 1}: ${line.trim()}`);
          }
        });
      }

      expect(
        offenders,
        'The repository/service layer must use the IDbDriver abstraction, not a raw SQLite handle.'
      ).toEqual([]);
    });

    it('keeps SQLite-only SQL out of the shared repository and service layer', async () => {
      const sourceFiles = await listSourceFiles(sourceRoot);
      const offenders: string[] = [];

      for (const relativePath of sourceFiles) {
        const normalisedPath = relativePath.split(path.sep).join('/');
        if (SQLITE_ONLY_SQL_ALLOWLIST.has(normalisedPath)) {
          continue;
        }

        const source = await fs.readFile(path.join(sourceRoot, relativePath), 'utf8');
        const usages = findSqliteOnlyUsages(stripDialectFragments(relativePath, source));

        if (usages.length > 0) {
          offenders.push(`${relativePath}: ${usages.join(', ')}`);
        }
      }

      expect(
        offenders,
        'SQLite-only SQL must be expressed through the dialect fragments in server/src/db/repositories.ts.'
      ).toEqual([]);
    });

    it('keeps the PostgreSQL dialect fragment free of SQLite-only SQL', async () => {
      const source = await fs.readFile(path.join(sourceRoot, 'db', 'repositories.ts'), 'utf8');
      const fragments = extractDialectFragments(source);

      expect(fragments, 'initDialectFragments() must exist in server/src/db/repositories.ts').not.toBeNull();
      expect(findSqliteOnlyUsages(fragments!.postgresBranch)).toEqual([]);
    });
  });

  describe('PostgreSQL driver keeps rewriting SQLite syntax', () => {
    it('rewrites ? placeholders into $n placeholders', () => {
      expect(preparePostgresSql('SELECT * FROM images WHERE id = ? AND folder_id = ?')).toBe(
        'SELECT * FROM images WHERE id = $1 AND folder_id = $2'
      );
      expect(preparePostgresSql('SELECT * FROM images WHERE id = ?')).not.toContain('?');
    });

    it('rewrites boolean literals for every known boolean column', () => {
      for (const column of POSTGRES_BOOLEAN_COLUMNS) {
        expect(preparePostgresSql(`SELECT * FROM images WHERE ${column} = 0`)).toContain(`${column} = false`);
        expect(preparePostgresSql(`SELECT * FROM images WHERE ${column} = 1`)).toContain(`${column} = true`);
      }
    });

    it('knows about every boolean column the schema uses', () => {
      expect([...POSTGRES_BOOLEAN_COLUMNS].sort()).toEqual([
        'is_animated',
        'is_approximate',
        'is_default',
        'is_deleted',
        'is_trashed'
      ]);
    });
  });

  describe('migrations exist for both dialects', () => {
    it('reads the per-dialect migration directories', () => {
      expect(getSqliteMigrationsDirectory()).toBe(path.join(migrationsRoot, 'sqlite'));
      expect(getPostgresMigrationsDirectory()).toBe(path.join(migrationsRoot, 'postgres'));
    });

    it('has a counterpart for every migration in the flat legacy directory', async () => {
      const flatFiles = (await fs.readdir(migrationsRoot)).filter((file) => file.endsWith('.sql'));
      const missing: string[] = [];

      for (const file of flatFiles) {
        for (const dialect of ['sqlite', 'postgres']) {
          const exists = await fs
            .stat(path.join(migrationsRoot, dialect, file))
            .then(() => true)
            .catch(() => false);

          if (!exists) {
            missing.push(`${dialect}/${file}`);
          }
        }
      }

      expect(
        missing,
        'The flat server/db/migrations/ directory is legacy: a migration added there is never applied. ' +
          'Add it to server/db/migrations/sqlite/ and server/db/migrations/postgres/ instead.'
      ).toEqual([]);
    });

    it('has a counterpart for every migration of the other dialect', async () => {
      const sqliteFiles = (await fs.readdir(path.join(migrationsRoot, 'sqlite'))).filter((file) =>
        file.endsWith('.sql')
      );
      const postgresFiles = (await fs.readdir(path.join(migrationsRoot, 'postgres'))).filter((file) =>
        file.endsWith('.sql')
      );

      const missingInPostgres = sqliteFiles.filter(
        (file) => !postgresFiles.includes(file) && !DIALECT_SPECIFIC_MIGRATIONS.has(file)
      );
      const missingInSqlite = postgresFiles.filter(
        (file) => !sqliteFiles.includes(file) && !DIALECT_SPECIFIC_MIGRATIONS.has(file)
      );

      expect(
        missingInPostgres,
        'Every migration needs a PostgreSQL counterpart in server/db/migrations/postgres/.'
      ).toEqual([]);
      expect(
        missingInSqlite,
        'Every migration needs a SQLite counterpart in server/db/migrations/sqlite/. ' +
          'Dialect specific migrations have to be listed in DIALECT_SPECIFIC_MIGRATIONS.'
      ).toEqual([]);
    });

    it('documents every dialect specific migration', () => {
      const entries = [...DIALECT_SPECIFIC_MIGRATIONS.entries()];
      expect(entries.length).toBeGreaterThan(0);

      for (const [file, reason] of entries) {
        expect(reason, `${file} needs a reason`).toBeTruthy();
      }
    });
  });

  describe('the project still builds', () => {
    it('declares the types the emitted declarations need', async () => {
      // `@types/express-serve-static-core` is only a transitive dependency of
      // `@types/express`. Without it as an explicit dependency the emitted
      // `.d.ts` files cannot name its types and `tsc` fails with
      // "TS2742: The inferred type of 'createApp' cannot be named without a
      // reference to ..." - a build that only works on a machine with a stale
      // flat `node_modules`.
      const packageJson = JSON.parse(
        await fs.readFile(path.join(serverRoot, 'package.json'), 'utf8')
      ) as { devDependencies?: Record<string, string> };

      expect(
        packageJson.devDependencies?.['@types/express-serve-static-core'],
        'server/package.json has to declare @types/express-serve-static-core explicitly.'
      ).toBeTruthy();
    });

    it('has a build check script', async () => {
      const packageJson = JSON.parse(
        await fs.readFile(path.join(serverRoot, 'package.json'), 'utf8')
      ) as { scripts?: Record<string, string> };

      expect(
        packageJson.scripts?.['build:check'],
        'server/package.json has to provide a "build:check" script that builds the server and both plugins.'
      ).toBeTruthy();
    });
  });

  describe('source tree stays free of stale build artifacts', () => {
    it('has no compiled .js files left inside server/src', async () => {
      const entries = await fs.readdir(sourceRoot, { withFileTypes: true, recursive: true });
      const staleArtifacts = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
        .map((entry) => path.relative(sourceRoot, path.join(entry.parentPath ?? entry.path, entry.name)));

      expect(
        staleArtifacts,
        'A compiled .js file next to a .ts source shadows the TypeScript source during test runs. ' +
          'Delete the artifact (the build output belongs into server/dist/).'
      ).toEqual([]);
    });

    it('keeps the repository root free of a stray build output', () => {
      expect(path.basename(repositoryRoot)).toBeTruthy();
    });
  });
});
