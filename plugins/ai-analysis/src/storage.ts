/**
 * Storage for AI analysis results.
 *
 * The schema is owned by this plugin and lives in columns added by the
 * migration at server/db/migrations/{postgres,sqlite}/0011_ai_analysis.sql.
 *
 * Columns added to `images`:
 *   ai_status            TEXT   — pending | running | ok | failed | skipped
 *   ai_summary           TEXT   — one-line description
 *   ai_domains           TEXT   — JSON array of slash-notation domain paths
 *   ai_tags              TEXT   — JSON array of lowercase tags
 *   ai_language          TEXT   — ISO 639-1 or 'unknown'
 *   ai_sentiment         TEXT   — positive | negative | neutral | mixed | provocative | informative
 *   ai_transcript        TEXT   — full whisper transcript
 *   ai_model             TEXT   — model id used for the analysis
 *   ai_usage_tokens      INTEGER — total tokens used
 *   ai_error             TEXT   — last failure message, if any
 *   ai_analyzed_at       TEXT   — ISO timestamp of last successful analysis
 *   ai_analyzed_mtime_ms INTEGER — source mtime used; re-analyze when current mtime differs
 *
 * We use TEXT (JSON-encoded) for ai_domains/ai_tags instead of jsonb/text[] so
 * the same migration works on both SQLite (dev) and PostgreSQL (prod). The
 * query layer parses on the way in, and the storage layer stringifies on the
 * way out.
 */

import { databaseManager } from "../../../server/dist/db/database.js";
import type { IDbDriver } from "../../../server/dist/db/driver/types.js";

export type AiStatus = "pending" | "running" | "ok" | "failed" | "skipped";

export interface AiMetadata {
  summary: string;
  domains: string[];
  tags: string[];
  language: string;
  sentiment: string;
  transcript: string;
  detectedLanguage: string;
  model: string;
  usageTokens: number;
}

const COLUMNS =
  "ai_status, ai_summary, ai_domains, ai_tags, ai_language, ai_sentiment, ai_transcript, ai_model, ai_usage_tokens, ai_error, ai_analyzed_at, ai_analyzed_mtime_ms";

function getDb(): never {
  throw new Error("getDb() removed — use the cached driver via getDriver()");
}

/** Update AI metadata for a video. Called by the analyzer after a successful run. */
export async function saveAnalysis(
  imageId: number,
  sourceMtimeMs: number,
  data: AiMetadata,
): Promise<void> {
  const now = new Date().toISOString();
  const params: unknown[] = [
    "ok",
    data.summary,
    JSON.stringify(data.domains),
    JSON.stringify(data.tags),
    data.language,
    data.sentiment,
    data.transcript,
    data.model,
    data.usageTokens,
    null,
    now,
    Math.round(sourceMtimeMs),
    imageId,
  ];
  const sql = `UPDATE images SET ${COLUMNS.split(", ")
    .map((c) => `${c} = ?`)
    .join(", ")} WHERE id = ?`;
  await run(sql, params);
}

/** Mark a video as failed with an error message. */
export async function markFailed(imageId: number, error: string): Promise<void> {
  await run(
    `UPDATE images SET ai_status = ?, ai_error = ?, ai_analyzed_at = ? WHERE id = ?`,
    ["failed", error.slice(0, 1000), new Date().toISOString(), imageId],
  );
}

/** Mark a video as skipped (e.g. zero duration). */
export async function markSkipped(imageId: number, reason: string): Promise<void> {
  await run(
    `UPDATE images SET ai_status = ?, ai_error = ?, ai_analyzed_at = ? WHERE id = ?`,
    ["skipped", reason.slice(0, 500), new Date().toISOString(), imageId],
  );
}

/** Mark a video as pending (queued) — avoids re-queueing duplicates unless `force` is set. */
export async function markPendingIfFresh(
  imageId: number,
  sourceMtimeMs: number,
  options: { force?: boolean } = {},
): Promise<boolean> {
  // Atomically: only set pending if status is null/failed/skipped OR the source mtime changed.
  // We do it in two queries since we don't have a portable UPSERT-with-WHERE form.
  const existing = await get(
    `SELECT ai_status, ai_analyzed_mtime_ms FROM images WHERE id = ?`,
    [imageId],
  );
  if (!existing) return false;

  const status = (existing as { ai_status: string | null }).ai_status;
  const lastMtime = (existing as { ai_analyzed_mtime_ms: number | null }).ai_analyzed_mtime_ms ?? 0;

  if (!options.force && status === "ok" && Math.abs(lastMtime - Math.round(sourceMtimeMs)) < 1000) {
    return false; // already analyzed at this mtime; skip
  }
  if (status === "pending" || status === "running") {
    return false; // already queued
  }

  await run(
    `UPDATE images SET ai_status = ?, ai_error = NULL WHERE id = ?`,
    ["pending", imageId],
  );
  return true;
}

/** Mark as running while the analyzer is in flight. */
export async function markRunning(imageId: number): Promise<void> {
  await run(`UPDATE images SET ai_status = ?, ai_error = NULL WHERE id = ?`, ["running", imageId]);
}

/** Mark every video in a folder as pending. Returns the number of rows marked. */
export async function markAllPendingInFolder(
  folderId: number,
  options: { force?: boolean } = {},
): Promise<{ marked: number; alreadyAnalyzed: number; alreadyQueued: number }> {
  const rows = (await all(
    `SELECT id, mtime_ms, ai_status, ai_analyzed_mtime_ms FROM images
     WHERE folder_id = ? AND media_type = 'video' AND is_deleted = 0`,
    [folderId],
  )) as Array<{
    id: number;
    mtime_ms: number;
    ai_status: string | null;
    ai_analyzed_mtime_ms: number | null;
  }>;

  let marked = 0;
  let alreadyAnalyzed = 0;
  let alreadyQueued = 0;
  const idsToMark: number[] = [];

  for (const r of rows) {
    if (r.ai_status === "pending" || r.ai_status === "running") {
      alreadyQueued++;
      continue;
    }
    if (
      !options.force &&
      r.ai_status === "ok" &&
      Math.abs((r.ai_analyzed_mtime_ms ?? 0) - Math.round(r.mtime_ms)) < 1000
    ) {
      alreadyAnalyzed++;
      continue;
    }
    idsToMark.push(r.id);
  }

  if (idsToMark.length > 0) {
    // SQLite doesn't support tuple-in in placeholders the same way as Postgres,
    // but `IN (?, ?, ...)` works for both drivers via the standard query helper.
    const placeholders = idsToMark.map(() => "?").join(", ");
    const result = await run(
      `UPDATE images SET ai_status = 'pending', ai_error = NULL WHERE id IN (${placeholders})`,
      idsToMark,
    );
    // `run` returns a QueryResult-like object; rowCount is in different fields per driver.
    const resultAny = result as { rowsAffected?: number; rowCount?: number };
    marked = resultAny.rowsAffected ?? resultAny.rowCount ?? idsToMark.length;
  }

  return { marked, alreadyAnalyzed, alreadyQueued };
}

export interface SearchHit {
  id: number;
  filename: string;
  relativePath: string;
  summary: string | null;
  domains: string[];
  tags: string[];
  language: string | null;
  transcript: string | null;
  status: string;
}

export interface SearchOptions {
  query?: string;
  domain?: string;
  tag?: string;
  language?: string;
  limit?: number;
}

/**
 * Search analyzed videos.
 *
 * The query strategy depends on what's supplied:
 *   - domain: WHERE ai_domains LIKE '%"<domain>"%' (substring match on JSON)
 *   - tag:    WHERE ai_tags LIKE '%"<tag>"%'
 *   - query:  WHERE ai_summary LIKE %q% OR ai_transcript LIKE %q%
 *   - language: WHERE ai_language = ?
 *   - all of the above can be combined
 *
 * In a real Postgres deployment we'd add GIN indexes on the JSON columns and
 * use `jsonb_path_ops`. For the prototype we accept LIKE scans over a small N.
 */
export async function searchVideos(opts: SearchOptions): Promise<SearchHit[]> {
  const conds: string[] = ["ai_status = 'ok'", "media_type = 'video'", "is_deleted = 0"];
  const params: unknown[] = [];

  if (opts.domain) {
    conds.push(`ai_domains LIKE ?`);
    params.push(`%"${escapeLike(opts.domain)}"%`);
  }
  if (opts.tag) {
    conds.push(`ai_tags LIKE ?`);
    params.push(`%"${escapeLike(opts.tag.toLowerCase())}"%`);
  }
  if (opts.language) {
    conds.push(`ai_language = ?`);
    params.push(opts.language);
  }
  if (opts.query) {
    conds.push(`(ai_summary LIKE ? OR ai_transcript LIKE ?)`);
    const wildcard = `%${escapeLike(opts.query)}%`;
    params.push(wildcard, wildcard);
  }

  const limit = Math.min(opts.limit ?? 50, 200);
  const sql = `SELECT id, filename, relative_path, ai_summary, ai_domains, ai_tags, ai_language, ai_transcript, ai_status
               FROM images
               WHERE ${conds.join(" AND ")}
               ORDER BY ai_analyzed_at DESC NULLS LAST
               LIMIT ?`;
  // SQLite uses ? for params; NULLS LAST is Postgres-only. We strip it on SQLite.
  const finalSql = sql.replace(" NULLS LAST", "");
  params.push(limit);

  const rows = (await all(finalSql, params)) as Array<{
    id: number;
    filename: string;
    relative_path: string;
    ai_summary: string | null;
    ai_domains: string | null;
    ai_tags: string | null;
    ai_language: string | null;
    ai_transcript: string | null;
    ai_status: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    relativePath: r.relative_path,
    summary: r.ai_summary,
    domains: r.ai_domains ? safeParseStringArray(r.ai_domains) : [],
    tags: r.ai_tags ? safeParseStringArray(r.ai_tags) : [],
    language: r.ai_language,
    transcript: r.ai_transcript,
    status: r.ai_status,
  }));
}

export interface StatusSummary {
  totalVideos: number;
  byStatus: Record<string, number>;
  oldestPendingAt: string | null;
}

export async function getStatusSummary(): Promise<StatusSummary> {
  const rows = (await all(
    `SELECT ai_status, COUNT(*) as n FROM images WHERE media_type = 'video' AND is_deleted = 0 GROUP BY ai_status`,
  )) as Array<{ ai_status: string | null; n: number }>;
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    const k = r.ai_status ?? "unanalyzed";
    byStatus[k] = r.n;
    total += r.n;
  }
  const oldest = (await get(
    `SELECT MIN(ai_analyzed_at) as oldest FROM images WHERE ai_status = 'pending'`,
  )) as { oldest: string | null } | undefined;
  return { totalVideos: total, byStatus, oldestPendingAt: oldest?.oldest ?? null };
}

/** Pull the next pending video and lock it as running. Returns null if queue empty. */
export async function claimNextPending(): Promise<{ imageId: number; absolutePath: string; mtimeMs: number } | null> {
  const row = (await get(
    `SELECT id, absolute_path, mtime_ms FROM images
     WHERE media_type = 'video' AND is_deleted = 0 AND ai_status = 'pending'
     ORDER BY id ASC LIMIT 1`,
  )) as { id: number; absolute_path: string; mtime_ms: number } | undefined;
  if (!row) return null;
  await run(`UPDATE images SET ai_status = 'running' WHERE id = ?`, [row.id]);
  return { imageId: row.id, absolutePath: row.absolute_path, mtimeMs: row.mtime_ms };
}

// ─── driver-specific query helpers ─────────────────────────────────────

let cachedDriver: IDbDriver | null = null;

async function getDriver(): Promise<IDbDriver> {
  if (cachedDriver) return cachedDriver;
  cachedDriver = await databaseManager.getConnection();
  return cachedDriver;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function safeParseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function all(sql: string, params?: unknown[]): Promise<unknown[]> {
  const drv = await getDriver();
  const result = await drv.query(sql, params);
  return result.rows;
}
async function get(sql: string, params?: unknown[]): Promise<unknown> {
  const drv = await getDriver();
  return await drv.queryOne(sql, params);
}
async function run(sql: string, params?: unknown[]): Promise<unknown> {
  const drv = await getDriver();
  return await drv.execute(sql, params);
}
