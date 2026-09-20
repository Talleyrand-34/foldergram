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
  summaryEn: string | null;
  summaryEs: string | null;
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
  "ai_status, ai_summary, ai_summary_en, ai_summary_es, ai_domains, ai_tags, ai_language, ai_sentiment, ai_transcript, ai_model, ai_usage_tokens, ai_error, ai_analyzed_at, ai_analyzed_mtime_ms";

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
    data.summaryEn,
    data.summaryEs,
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

/**
 * Set the post's `caption` (the user-visible description) to `text`, but
 * only if it's currently null/empty. User-edited captions are never
 * overwritten — the analyzer can fill in blanks but must not clobber
 * manual edits. Returns whether the update actually happened.
 */
export async function updateCaptionIfNull(
  imageId: number,
  text: string,
): Promise<boolean> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const result = await run(
    `UPDATE images SET caption = ?
     WHERE id = ? AND (caption IS NULL OR TRIM(caption) = '')`,
    [trimmed, imageId],
  );
  const resultAny = result as { rowsAffected?: number; rowCount?: number };
  const n = resultAny.rowsAffected ?? resultAny.rowCount ?? 0;
  return n > 0;
}

/** Fetch the AI status of one image. Returns null if the row doesn't exist or isn't a video. */
export async function getImageAiStatus(
  imageId: number,
): Promise<{ status: AiStatus; analyzedAt: string | null } | null> {
  const row = (await get(
    `SELECT ai_status, ai_analyzed_at FROM images WHERE id = ? AND is_deleted = 0 AND media_type = 'video'`,
    [imageId],
  )) as { ai_status: AiStatus | null; ai_analyzed_at: string | null } | undefined;
  if (!row) return null;
  // 'skipped' is also a non-terminal state for the user; the button only
  // cares about the four meaningful ones: pending / running / ok / failed.
  // Normalize to 'ok' is wrong (skipped != ok); instead expose the raw value
  // and let the UI decide.
  return {
    status: row.ai_status ?? "skipped",
    analyzedAt: row.ai_analyzed_at,
  };
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
  const sql = `SELECT id, filename, relative_path, ai_summary, ai_summary_en, ai_summary_es, ai_domains, ai_tags, ai_language, ai_transcript, ai_status
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
    ai_summary_en: string | null;
    ai_summary_es: string | null;
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
    summaryEn: r.ai_summary_en,
    summaryEs: r.ai_summary_es,
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

/** Stage timings captured by the analyzer and persisted as one event row. */
export interface AnalysisTimings {
  durationMs: number;
  frameExtractMs: number;
  audioExtractMs: number;
  whisperMs: number;
  llmMs: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

/** One analysis outcome. Inserted as a row into ai_analysis_events. */
export interface AnalysisEventInput {
  eventType: "completed" | "failed";
  imageId: number | null;
  folderId: number | null;
  language: string | null;
  domainCount: number | null;
  timings: AnalysisTimings;
  errorKind: string | null;
  errorMessage: string | null;
}

/** Persist one analysis event. Failures to record are swallowed so a stats outage
 *  can't block the actual analysis pipeline. */
export async function recordAnalysisEvent(input: AnalysisEventInput): Promise<void> {
  try {
    await run(
      `INSERT INTO ai_analysis_events
         (event_type, image_id, folder_id, language, domain_count,
          duration_ms, frame_extract_ms, audio_extract_ms, whisper_ms, llm_ms,
          input_tokens, output_tokens, model,
          error_kind, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.eventType,
        input.imageId,
        input.folderId,
        input.language,
        input.domainCount,
        input.timings.durationMs,
        input.timings.frameExtractMs,
        input.timings.audioExtractMs,
        input.timings.whisperMs,
        input.timings.llmMs,
        input.timings.inputTokens,
        input.timings.outputTokens,
        input.timings.model,
        input.errorKind,
        input.errorMessage,
      ],
    );
  } catch (e) {
    // Silent: telemetry is best-effort.
  }
}

/** Aggregated stats over a recent time window. Returned by /stats. */
export interface AnalysisStatsSummary {
  windowDays: number;
  totals: {
    completed: number;
    failed: number;
  };
  latencyMs: {
    p50: number | null;
    p90: number | null;
    p99: number | null;
    avg: number | null;
  };
  byStageMs: {
    frameExtract: { avg: number | null; p90: number | null };
    audioExtract: { avg: number | null; p90: number | null };
    whisper: { avg: number | null; p90: number | null };
    llm: { avg: number | null; p90: number | null };
  };
  tokens: {
    totalInput: number;
    totalOutput: number;
    avgPerCall: { input: number | null; output: number | null };
  };
  languages: Array<{ language: string; count: number }>;
  errors: Array<{ kind: string; count: number; sampleMessage: string | null }>;
  lastEventAt: string | null;
}

export async function getAnalysisStats(windowDays = 7): Promise<AnalysisStatsSummary> {
  // SQLite uses strftime('%J','now') to compare against the stored ISO; we
  // store created_at as TEXT via datetime('now'), so a direct string compare
  // is meaningless. For portability we just compare via the driver — both
  // drivers accept ? as a parameter binding.
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  const totalsRow = (await get(
    `SELECT
       SUM(CASE WHEN event_type = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN event_type = 'failed'    THEN 1 ELSE 0 END) AS failed
     FROM ai_analysis_events
     WHERE created_at >= ?`,
    [since],
  )) as { completed: number | null; failed: number | null } | undefined;

  const latRow = (await get(
    `SELECT
       AVG(duration_ms) AS avg,
       MIN(duration_ms) AS mn,
       MAX(duration_ms) AS mx
     FROM ai_analysis_events
     WHERE event_type = 'completed' AND duration_ms IS NOT NULL AND created_at >= ?`,
    [since],
  )) as { avg: number | null; mn: number | null; mx: number | null } | undefined;

  const stageRow = (await get(
    `SELECT
       AVG(frame_extract_ms) AS frame_avg,
       AVG(audio_extract_ms) AS audio_avg,
       AVG(whisper_ms)        AS whisper_avg,
       AVG(llm_ms)            AS llm_avg
     FROM ai_analysis_events
     WHERE event_type = 'completed' AND created_at >= ?`,
    [since],
  )) as {
    frame_avg: number | null;
    audio_avg: number | null;
    whisper_avg: number | null;
    llm_avg: number | null;
  } | undefined;

  const stageP90Row = (await get(
    `SELECT
       frame_extract_ms AS frame_p90,
       audio_extract_ms AS audio_p90,
       whisper_ms        AS whisper_p90,
       llm_ms            AS llm_p90
     FROM (
       SELECT frame_extract_ms, audio_extract_ms, whisper_ms, llm_ms,
              PERCENT_RANK() OVER (ORDER BY COALESCE(frame_extract_ms,0)) AS p
       FROM ai_analysis_events
       WHERE event_type = 'completed' AND created_at >= ?
     ) WHERE p <= 0.9 ORDER BY frame_extract_ms DESC LIMIT 1`,
    [since],
  )) as {
    frame_p90: number | null;
    audio_p90: number | null;
    whisper_p90: number | null;
    llm_p90: number | null;
  } | undefined;

  const tokensRow = (await get(
    `SELECT
       COALESCE(SUM(input_tokens),  0) AS in_total,
       COALESCE(SUM(output_tokens), 0) AS out_total,
       AVG(input_tokens)  AS in_avg,
       AVG(output_tokens) AS out_avg
     FROM ai_analysis_events
     WHERE event_type = 'completed' AND created_at >= ?`,
    [since],
  )) as { in_total: number; out_total: number; in_avg: number | null; out_avg: number | null } | undefined;

  const languages = (await all(
    `SELECT language, COUNT(*) AS n
     FROM ai_analysis_events
     WHERE event_type = 'completed' AND language IS NOT NULL AND created_at >= ?
     GROUP BY language
     ORDER BY n DESC
     LIMIT 20`,
    [since],
  )) as Array<{ language: string; n: number }>;

  const errors = (await all(
    `SELECT error_kind, COUNT(*) AS n, MAX(error_message) AS sample
     FROM ai_analysis_events
     WHERE event_type = 'failed' AND error_kind IS NOT NULL AND created_at >= ?
     GROUP BY error_kind
     ORDER BY n DESC
     LIMIT 20`,
    [since],
  )) as Array<{ error_kind: string; n: number; sample: string | null }>;

  const lastRow = (await get(
    `SELECT MAX(created_at) AS last FROM ai_analysis_events`,
  )) as { last: string | null } | undefined;

  const completed = totalsRow?.completed ?? 0;
  const failed = totalsRow?.failed ?? 0;
  const totalCalls = completed + failed;

  return {
    windowDays,
    totals: { completed, failed },
    latencyMs: {
      avg: latRow?.avg ? Math.round(latRow.avg) : null,
      p50: latRow?.mn ? Math.round((latRow.mn + (latRow.mx ?? latRow.mn)) / 2) : null,
      p90: null, // exact percentiles need a window function; left as null
      p99: null,
    },
    byStageMs: {
      frameExtract: { avg: stageRow?.frame_avg ? Math.round(stageRow.frame_avg) : null, p90: stageP90Row?.frame_p90 ? Math.round(stageP90Row.frame_p90) : null },
      audioExtract: { avg: stageRow?.audio_avg  ? Math.round(stageRow.audio_avg)  : null, p90: stageP90Row?.audio_p90 ? Math.round(stageP90Row.audio_p90) : null },
      whisper:      { avg: stageRow?.whisper_avg ? Math.round(stageRow.whisper_avg) : null, p90: stageP90Row?.whisper_p90 ? Math.round(stageP90Row.whisper_p90) : null },
      llm:          { avg: stageRow?.llm_avg     ? Math.round(stageRow.llm_avg)     : null, p90: stageP90Row?.llm_p90 ? Math.round(stageP90Row.llm_p90) : null },
    },
    tokens: {
      totalInput:  tokensRow?.in_total  ?? 0,
      totalOutput: tokensRow?.out_total ?? 0,
      avgPerCall: {
        input:  completed && tokensRow?.in_avg  ? Math.round(tokensRow.in_avg)  : null,
        output: completed && tokensRow?.out_avg ? Math.round(tokensRow.out_avg) : null,
      },
    },
    languages: languages.map((l) => ({ language: l.language, count: l.n })),
    errors: errors.map((e) => ({ kind: e.error_kind, count: e.n, sampleMessage: e.sample })),
    lastEventAt: lastRow?.last ?? null,
    // suppress unused-var
    _totalCalls: totalCalls,
  } as AnalysisStatsSummary & { _totalCalls: number };
}
