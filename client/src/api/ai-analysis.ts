/**
 * Typed client for the AI-analysis plugin's REST endpoints.
 *
 * Endpoints (all under /api/plugins/ai-analysis):
 *   GET  /status              → overall progress
 *   GET  /search?q=&domain=&tag=&language=&limit= → analyzed-video hits
 *   POST /analyze/:imageId[?force]                → enqueue one video
 *   POST /analyze-folder/:folderId[?force]        → enqueue every video in a folder
 *
 * The `force` flag re-runs analysis even when the source mtime hasn't changed
 * (useful when the model has improved or results were bad).
 */

import { requestJson } from './http.js';

export type AiStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

export interface AiMetadata {
  summary: string;
  domains: string[];
  tags: string[];
  language: string;
  sentiment: string;
}

export interface AiStatusSummary {
  totalVideos: number;
  byStatus: Record<string, number>;
  oldestPendingAt: string | null;
}

export interface AiImageStatus {
  imageId: number;
  status: AiStatus;
  analyzedAt: string | null;
}

export interface AiSearchHit {
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

export interface AiSearchResponse {
  hits: AiSearchHit[];
  count: number;
}

export interface AiAnalyzeResponse {
  imageId: number;
  queued: boolean;
  reason?: string;
}

export interface AiAnalyzeFolderResponse {
  folderId: number;
  folderSlug: string;
  marked: number;
  alreadyAnalyzed: number;
  alreadyQueued: number;
  force: boolean;
}

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

export interface FolderRollupOverride {
  userSummary?: string | null;
  userDomains?: string[] | null;
  userLanguage?: string | null;
}

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

export async function fetchAiStatus(): Promise<AiStatusSummary> {
  return await requestJson<AiStatusSummary>('/api/plugins/ai-analysis/status');
}

export interface AiSearchParams {
  q?: string;
  domain?: string;
  tag?: string;
  language?: string;
  limit?: number;
}

export async function searchAi(params: AiSearchParams): Promise<AiSearchResponse> {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.domain) search.set('domain', params.domain);
  if (params.tag) search.set('tag', params.tag);
  if (params.language) search.set('language', params.language);
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  const qs = search.toString();
  return await requestJson<AiSearchResponse>(
    `/api/plugins/ai-analysis/search${qs ? `?${qs}` : ''}`,
  );
}

export async function analyzeVideo(imageId: number, force = false): Promise<AiAnalyzeResponse> {
  return await requestJson<AiAnalyzeResponse>(
    `/api/plugins/ai-analysis/analyze/${imageId}${force ? '?force=1' : ''}`,
    { method: 'POST' },
  );
}

export async function fetchImageAiStatus(imageId: number): Promise<AiImageStatus | null> {
  try {
    return await requestJson<AiImageStatus>(
      `/api/plugins/ai-analysis/image/${imageId}/status`,
    );
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e && (e as { status: number }).status === 404) {
      return null;
    }
    throw e;
  }
}

export async function fetchFolderRollup(folderId: number): Promise<FolderRollup | null> {
  try {
    return await requestJson<FolderRollup>(
      `/api/plugins/ai-analysis/folder/${folderId}/rollup`,
    );
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e && (e as { status: number }).status === 404) {
      return null;
    }
    throw e;
  }
}

export async function fetchTopDomains(limit = 200): Promise<string[]> {
  try {
    const r = await requestJson<{ domains: Array<{ domain: string }> }>(
      `/api/plugins/ai-analysis/knowledge/domains?limit=${limit}`,
    );
    return r.domains.map((d) => d.domain);
  } catch {
    return [];
  }
}

export async function fetchDistinctLanguages(limit = 50): Promise<string[]> {
  try {
    const r = await requestJson<{ languages: string[] }>(
      `/api/plugins/ai-analysis/knowledge/languages?limit=${limit}`,
    );
    return r.languages;
  } catch {
    return [];
  }
}

export async function updateFolderRollup(
  folderId: number,
  override: FolderRollupOverride,
): Promise<FolderRollup | null> {
  try {
    return await requestJson<FolderRollup>(
      `/api/plugins/ai-analysis/folder/${folderId}/rollup`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(override),
      },
    );
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e && (e as { status: number }).status === 404) {
      return null;
    }
    throw e;
  }
}

export async function analyzeFolder(
  folderId: number,
  force = false,
): Promise<AiAnalyzeFolderResponse> {
  return await requestJson<AiAnalyzeFolderResponse>(
    `/api/plugins/ai-analysis/analyze-folder/${folderId}${force ? '?force=1' : ''}`,
    { method: 'POST' },
  );
}
