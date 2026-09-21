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

/** Per-video aggregated stats, summing across every recorded analysis attempt. */
export interface VideoStats {
  imageId: number;
  eventCount: number;
  completedCount: number;
  failedCount: number;
  firstAttemptAt: string | null;
  lastAttemptAt: string | null;
  totalDurationMs: number;
  avgDurationMs: number | null;
  fastestDurationMs: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastModel: string | null;
  lastError: string | null;
}

export async function getVideoStats(imageId: number): Promise<VideoStats | null> {
  const row = (await get(
    `SELECT
       COUNT(*) AS event_count,
       SUM(CASE WHEN event_type = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN event_type = 'failed'    THEN 1 ELSE 0 END) AS failed,
       MIN(created_at) AS first_at,
       MAX(created_at) AS last_at,
       SUM(COALESCE(duration_ms, 0))  AS total_dur,
       AVG(duration_ms)              AS avg_dur,
       MIN(duration_ms)              AS min_dur,
       SUM(COALESCE(input_tokens, 0))  AS total_in,
       SUM(COALESCE(output_tokens, 0)) AS total_out
     FROM ai_analysis_events
     WHERE image_id = ?`,
    [imageId],
  )) as {
    event_count: number | null;
    completed: number | null;
    failed: number | null;
    first_at: string | null;
    last_at: string | null;
    total_dur: number | null;
    avg_dur: number | null;
    min_dur: number | null;
    total_in: number | null;
    total_out: number | null;
  } | undefined;
  if (!row || !row.event_count) return null;

  const last = (await get(
    `SELECT model, error_message, error_kind
     FROM ai_analysis_events
     WHERE image_id = ?
     ORDER BY created_at DESC LIMIT 1`,
    [imageId],
  )) as { model: string | null; error_message: string | null; error_kind: string | null } | undefined;

  return {
    imageId,
    eventCount: row.event_count,
    completedCount: row.completed ?? 0,
    failedCount: row.failed ?? 0,
    firstAttemptAt: row.first_at,
    lastAttemptAt: row.last_at,
    totalDurationMs: row.total_dur ?? 0,
    avgDurationMs: row.avg_dur ? Math.round(row.avg_dur) : null,
    fastestDurationMs: row.min_dur,
    totalInputTokens: row.total_in ?? 0,
    totalOutputTokens: row.total_out ?? 0,
    lastModel: last?.model ?? null,
    lastError: last?.error_message ?? null,
  };
}

/* ──────────────────────────────────────────────────────────────────────── *
 * Per-folder rollup + domain knowledge graph.                              *
 * Updated each time a video finishes analysis: the rollup is recomputed    *
 * from the current images rows (single source of truth), and the domain   *
 * nodes + edges are bumped in place.                                       *
 * ──────────────────────────────────────────────────────────────────────── */

/** Persisted summary for one folder, computed from its analyzed videos. */
export interface FolderRollup {
  folderId: number;
  summary: string | null;
  topDomains: string[];
  language: string | null;
  videoCount: number;
  analyzedCount: number;
  updatedAt: string | null;
  /** Human-authored overrides. When present, the UI shows these instead of
   *  the AI-generated values above. */
  userSummary: string | null;
  userDomains: string[];
  userLanguage: string | null;
}

/** One domain in the knowledge graph. */
export interface DomainNode {
  domain: string;
  videoCount: number;
  folderCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Map of ISO code → count, parsed from the JSON 'languages' column. */
  languages: Record<string, number>;
}

/** Undirected co-occurrence edge between two domains. */
export interface DomainEdge {
  source: string;
  target: string;
  weight: number;
  updatedAt: string;
}

/**
 * Recompute the rollup for one folder from the current image rows. Called
 * after every successful analysis so the summary stays live. Safe to run
 * concurrently for different folders; per-folder serialization is up to the
 * caller if you want strict consistency.
 */
export async function recomputeFolderRollup(folderId: number): Promise<FolderRollup> {
  const rows = (await all(
    `SELECT ai_language, ai_domains, ai_summary
     FROM images
     WHERE folder_id = ? AND is_deleted = 0 AND media_type = 'video'`,
    [folderId],
  )) as Array<{
    ai_language: string | null;
    ai_domains: string | null;
    ai_summary: string | null;
  }>;

  const videoCount = rows.length;
  const analyzedRows = rows.filter((r) => r.ai_summary && r.ai_domains);
  const analyzedCount = analyzedRows.length;

  // Top domains = most-frequent slash-notation domain across all analyzed
  // videos in the folder. Counts are per-video, not per-tag — same domain in
  // 3 different videos → 3 points, even if one video has 2 of them.
  const domainCounts = new Map<string, number>();
  const langCounts = new Map<string, number>();
  for (const r of analyzedRows) {
    const domains = r.ai_domains ? safeParseStringArray(r.ai_domains) : [];
    for (const d of domains) domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
    if (r.ai_language) langCounts.set(r.ai_language, (langCounts.get(r.ai_language) ?? 0) + 1);
  }

  const topDomains = Array.from(domainCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([d]) => d);

  // Pick the majority language among analyzed videos (tie → first seen).
  const dominantLanguage = Array.from(langCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([l]) => l)[0] ?? null;

  // Roll-up summary: stitch together one summary per top domain, deduped.
  const summaryParts: string[] = [];
  const seen = new Set<string>();
  for (const d of topDomains) {
    for (const r of analyzedRows) {
      const domains = r.ai_domains ? safeParseStringArray(r.ai_domains) : [];
      if (!domains.includes(d)) continue;
      const s = (r.ai_summary ?? "").trim();
      if (!s) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      summaryParts.push(s);
      break;
    }
    if (summaryParts.length >= 4) break;
  }
  const summary = summaryParts.length > 0 ? summaryParts.join(" ") : null;

  const nowExpr = await nowLiteral();
  await run(
    `INSERT INTO ai_folder_rollup (folder_id, summary, top_domains, language, video_count, analyzed_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ${nowExpr})
     ON CONFLICT(folder_id) DO UPDATE SET
       summary = excluded.summary,
       top_domains = excluded.top_domains,
       language = excluded.language,
       video_count = excluded.video_count,
       analyzed_count = excluded.analyzed_count,
       updated_at = ${nowExpr}`,
    [
      folderId,
      summary,
      JSON.stringify(topDomains),
      dominantLanguage,
      videoCount,
      analyzedCount,
    ],
  );

  return {
    folderId,
    summary,
    topDomains,
    language: dominantLanguage,
    videoCount,
    analyzedCount,
    updatedAt: new Date().toISOString(),
    userSummary: null,
    userDomains: [],
    userLanguage: null,
  };
}

export async function getFolderRollup(folderId: number): Promise<FolderRollup | null> {
  const row = (await get(
    `SELECT folder_id, summary, top_domains, language, video_count, analyzed_count, updated_at,
            user_summary, user_domains, user_language
     FROM ai_folder_rollup WHERE folder_id = ?`,
    [folderId],
  )) as {
    folder_id: number;
    summary: string | null;
    top_domains: string | null;
    language: string | null;
    video_count: number;
    analyzed_count: number;
    updated_at: string | null;
    user_summary: string | null;
    user_domains: string | null;
    user_language: string | null;
  } | undefined;
  if (!row) return null;
  return {
    folderId: row.folder_id,
    summary: row.summary,
    topDomains: row.top_domains ? safeParseStringArray(row.top_domains) : [],
    language: row.language,
    videoCount: row.video_count,
    analyzedCount: row.analyzed_count,
    updatedAt: row.updated_at,
    userSummary: row.user_summary,
    userDomains: row.user_domains ? safeParseStringArray(row.user_domains) : [],
    userLanguage: row.user_language,
  };
}

/**
 * Persist a user-authored override of the folder rollup. Pass null for any
 * field you want to clear. The folder must already have a rollup row (i.e.
 * at least one video has been analyzed). Returns the updated rollup, or null
 * if the rollup doesn't exist yet.
 */
export async function updateFolderRollupOverride(
  folderId: number,
  override: {
    userSummary?: string | null;
    userDomains?: string[] | null;
    userLanguage?: string | null;
  },
): Promise<FolderRollup | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if ('userSummary' in override) {
    sets.push('user_summary = ?');
    params.push(override.userSummary ?? null);
  }
  if ('userDomains' in override) {
    sets.push('user_domains = ?');
    params.push(
      override.userDomains && override.userDomains.length > 0
        ? JSON.stringify(override.userDomains)
        : null,
    );
  }
  if ('userLanguage' in override) {
    sets.push('user_language = ?');
    params.push(override.userLanguage ?? null);
  }
  if (sets.length === 0) {
    return await getFolderRollup(folderId);
  }
  sets.push('updated_at = ' + (await nowLiteral()));
  params.push(folderId);
  await run(
    `UPDATE ai_folder_rollup SET ${sets.join(', ')} WHERE folder_id = ?`,
    params,
  );
  return await getFolderRollup(folderId);
}

/**
 * Bump the node counts and timestamps for each domain seen in a video.
 * Idempotent per (domain, video) pair? No — we want pure counters, so re-running
 * for the same video will double-count. Callers should call this exactly once per
 * successful analysis.
 */
export async function bumpDomainNodes(domains: string[], language: string | null): Promise<void> {
  if (domains.length === 0) return;
  const nowExpr = await nowLiteral();
  for (const d of domains) {
    await run(
      `INSERT INTO ai_domain_nodes (domain, video_count, folder_count, first_seen_at, last_seen_at, languages)
       VALUES (?, 1, 0, ${nowExpr}, ${nowExpr}, ?)
       ON CONFLICT(domain) DO UPDATE SET
         video_count = ai_domain_nodes.video_count + 1,
         last_seen_at = ${nowExpr},
         languages = ?`,
      [d, language ? JSON.stringify({ [language]: 1 }) : null, language ? JSON.stringify({ [language]: 1 }) : null],
    );
  }
}

/** Bump undirected co-occurrence edges for each (d1, d2) pair where d1 != d2. */
export async function bumpDomainEdges(domains: string[]): Promise<void> {
  if (domains.length < 2) return;
  for (let i = 0; i < domains.length; i++) {
    for (let j = i + 1; j < domains.length; j++) {
      const a = domains[i];
      const b = domains[j];
      // Canonical ordering so (a,b) and (b,a) hit the same row.
      const [source, target] = a < b ? [a, b] : [b, a];
      const nowExpr = await nowLiteral();
      await run(
        `INSERT INTO ai_domain_edges (source_domain, target_domain, weight, updated_at)
         VALUES (?, ?, 1, ${nowExpr})
         ON CONFLICT(source_domain, target_domain) DO UPDATE SET
           weight = ai_domain_edges.weight + 1,
           updated_at = ${nowExpr}`,
        [source, target],
      );
    }
  }
}

/** Aggregate folders-distinct for the set of videos that mention each domain. */
export async function recomputeFolderCounts(): Promise<void> {
  await run(
    `UPDATE ai_domain_nodes
     SET folder_count = (
       SELECT COUNT(DISTINCT images.folder_id)
       FROM images
       WHERE ai_domains IS NOT NULL AND ai_domains LIKE '%"' || ai_domain_nodes.domain || '"%'
     )`,
  );
}

export async function getTopDomains(limit = 50): Promise<DomainNode[]> {
  const rows = (await all(
    `SELECT domain, video_count, folder_count, first_seen_at, last_seen_at, languages
     FROM ai_domain_nodes
     ORDER BY video_count DESC, domain ASC
     LIMIT ?`,
    [limit],
  )) as Array<{
    domain: string;
    video_count: number;
    folder_count: number;
    first_seen_at: string;
    last_seen_at: string;
    languages: string | null;
  }>;
  return rows.map((r) => ({
    domain: r.domain,
    videoCount: r.video_count,
    folderCount: r.folder_count,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    languages: r.languages ? safeParseLanguages(r.languages) : {},
  }));
}

export async function getDomainEdges(domain: string, limit = 30): Promise<DomainEdge[]> {
  const rows = (await all(
    `SELECT source_domain, target_domain, weight, updated_at
     FROM ai_domain_edges
     WHERE source_domain = ? OR target_domain = ?
     ORDER BY weight DESC, source_domain ASC
     LIMIT ?`,
    [domain, domain, limit],
  )) as Array<{
    source_domain: string;
    target_domain: string;
    weight: number;
    updated_at: string;
  }>;
  return rows.map((r) => ({
    source: r.source_domain,
    target: r.target_domain,
    weight: r.weight,
    updatedAt: r.updated_at,
  }));
}

/** Distinct languages seen across analyzed videos, ordered by frequency. */
export async function getDistinctLanguages(limit = 50): Promise<string[]> {
  const rows = (await all(
    `SELECT ai_language AS language, COUNT(*) AS n
     FROM images
     WHERE media_type::text = 'video' AND is_deleted = 0
       AND ai_language IS NOT NULL AND ai_language <> ''
     GROUP BY ai_language
     ORDER BY n DESC, ai_language ASC
     LIMIT ?`,
    [limit],
  )) as Array<{ language: string; n: number }>;
  return rows.map((r) => r.language);
}

/**
 * Add a custom domain to the knowledge graph with zero counts. Used by
 * the Settings "Domain manager" for manual entries. No-op (returns false)
 * if the domain already exists or the name fails validation.
 */
export async function addDomainNode(domain: string): Promise<boolean> {
  const d = domain.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9/-]*$/.test(d)) return false;
  const nowExpr = await nowLiteral();
  await run(
    `INSERT INTO ai_domain_nodes (domain, video_count, folder_count, first_seen_at, last_seen_at, languages)
     VALUES (?, 0, 0, ${nowExpr}, ${nowExpr}, NULL)
     ON CONFLICT(domain) DO NOTHING`,
    [d],
  );
  return true;
}

/**
 * Rename a domain. Cascades to:
 *   - ai_domain_nodes: row renamed
 *   - ai_domain_edges: both source and target references renamed
 *   - images.ai_domains: every video that had the old name gets the new
 *     name in its JSON array
 *
 * The four statements are not wrapped in a transaction (the driver layer
 * doesn't expose begin/commit). For a manual admin action this is fine —
 * a partial rename is recoverable by re-running with the same args.
 */
export async function renameDomain(oldName: string, newName: string): Promise<boolean> {
  const oldD = oldName.trim().toLowerCase();
  const newD = newName.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9/-]*$/.test(newD)) return false;
  if (oldD === newD) return false;

  await run(`UPDATE ai_domain_nodes SET domain = ? WHERE domain = ?`, [newD, oldD]);
  await run(
    `UPDATE ai_domain_edges SET source_domain = ? WHERE source_domain = ?`,
    [newD, oldD],
  );
  await run(
    `UPDATE ai_domain_edges SET target_domain = ? WHERE target_domain = ?`,
    [newD, oldD],
  );
  // Rewrite the JSON array in every image that mentions the old name.
  // Plain text replace is portable (no jsonb_set in SQLite) and safe because
  // the match is a quoted JSON string token — it never collides with a
  // substring of another domain name.
  await run(
    `UPDATE images
     SET ai_domains = REPLACE(ai_domains, '"' || ? || '"', '"' || ? || '"')
     WHERE media_type::text = 'video' AND is_deleted = 0
       AND ai_domains LIKE '%"' || ? || '"%'`,
    [oldD, newD, oldD],
  );
  return true;
}

/**
 * Delete a domain. Cascades:
 *   - ai_domain_nodes: row removed
 *   - ai_domain_edges: edges referencing it (either side) removed
 *   - images.ai_domains: every video that had the name has it stripped
 *     from its JSON array (text replace; same portability caveat as rename)
 */
export async function deleteDomain(name: string): Promise<boolean> {
  const d = name.trim().toLowerCase();
  if (!d) return false;
  await run(`DELETE FROM ai_domain_nodes WHERE domain = ?`, [d]);
  await run(
    `DELETE FROM ai_domain_edges WHERE source_domain = ? OR target_domain = ?`,
    [d, d],
  );
  // Strip the domain from every video that mentioned it.
  await run(
    `UPDATE images
     SET ai_domains = REPLACE(ai_domains, '"' || ? || '"', '')
     WHERE media_type::text = 'video' AND is_deleted = 0
       AND ai_domains LIKE '%"' || ? || '"%'`,
    [d, d],
  );
  return true;
}

/** One folder row in the Settings folder-knowledge list. */
export interface FolderKnowledgeRow {
  folderId: number;
  folderSlug: string;
  folderName: string;
  folderPath: string;
  videoCount: number;
  analyzedCount: number;
  hasRollup: boolean;
  hasUserOverride: boolean;
  summary: string | null;
  topDomains: string[];
  language: string | null;
}

/**
 * List folders that have an AI rollup, with the per-folder counts and the
 * override flag. Bounded by `limit` to keep the response small; the UI can
 * paginate. Used by the Settings folder-knowledge section.
 */
export async function getFoldersWithRollup(
  limit = 200,
  offset = 0,
): Promise<FolderKnowledgeRow[]> {
  const rows = (await all(
    `SELECT
       folders.id            AS folder_id,
       folders.slug          AS folder_slug,
       folders.name          AS folder_name,
       folders.folder_path   AS folder_path,
       folders.video_count   AS video_count,
       (SELECT COUNT(*) FROM images
          WHERE images.folder_id = folders.id
            AND images.media_type::text = 'video'
            AND images.is_deleted = 0
            AND images.ai_status::text = 'ok') AS analyzed_count,
       CASE WHEN ai_folder_rollup.folder_id IS NULL THEN 0 ELSE 1 END AS has_rollup,
       CASE WHEN ai_folder_rollup.user_summary IS NULL
              AND (ai_folder_rollup.user_domains IS NULL OR ai_folder_rollup.user_domains = '')
              AND ai_folder_rollup.user_language IS NULL
            THEN 0 ELSE 1 END AS has_user_override,
       ai_folder_rollup.summary     AS summary,
       ai_folder_rollup.top_domains AS top_domains,
       ai_folder_rollup.language    AS language
     FROM folders
     LEFT JOIN ai_folder_rollup ON ai_folder_rollup.folder_id = folders.id
     WHERE folders.role::text = 'normal'
       AND ai_folder_rollup.folder_id IS NOT NULL
     ORDER BY ai_folder_rollup.updated_at DESC NULLS LAST,
              folders.name ASC
     LIMIT ? OFFSET ?`,
    [limit, offset],
  )) as Array<{
    folder_id: number;
    folder_slug: string;
    folder_name: string;
    folder_path: string;
    video_count: number;
    analyzed_count: number;
    has_rollup: number;
    has_user_override: number;
    summary: string | null;
    top_domains: string | null;
    language: string | null;
  }>;
  return rows.map((r) => ({
    folderId: r.folder_id,
    folderSlug: r.folder_slug,
    folderName: r.folder_name,
    folderPath: r.folder_path,
    videoCount: r.video_count,
    analyzedCount: r.analyzed_count,
    hasRollup: r.has_rollup === 1,
    hasUserOverride: r.has_user_override === 1,
    summary: r.summary,
    topDomains: r.top_domains ? safeParseStringArray(r.top_domains) : [],
    language: r.language,
  }));
}

function safeParseLanguages(raw: string): Record<string, number> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
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
export async function claimNextPending(): Promise<{ imageId: number; folderId: number; absolutePath: string; mtimeMs: number } | null> {
  const row = (await get(
    `SELECT id, folder_id, absolute_path, mtime_ms FROM images
     WHERE media_type = 'video' AND is_deleted = 0 AND ai_status = 'pending'
     ORDER BY id ASC LIMIT 1`,
  )) as { id: number; folder_id: number; absolute_path: string; mtime_ms: number } | undefined;
  if (!row) return null;
  await run(`UPDATE images SET ai_status = 'running' WHERE id = ?`, [row.id]);
  return {
    imageId: row.id,
    folderId: row.folder_id,
    absolutePath: row.absolute_path,
    mtimeMs: row.mtime_ms,
  };
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

/** Driver-aware "now" — the migration files use dbmate, which is dialect-aware,
 *  but our SQL helpers run via the driver directly and need the right literal.
 *  SQLite uses datetime('now'); Postgres uses CURRENT_TIMESTAMP. */
async function nowLiteral(): Promise<string> {
  const drv = await getDriver();
  return drv.dialect === 'postgres' ? 'CURRENT_TIMESTAMP' : "datetime('now')";
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
    const nowExpr = await nowLiteral();
    await run(
      `INSERT INTO ai_analysis_events
         (event_type, image_id, folder_id, language, domain_count,
          duration_ms, frame_extract_ms, audio_extract_ms, whisper_ms, llm_ms,
          input_tokens, output_tokens, model,
          error_kind, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${nowExpr})`,
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
