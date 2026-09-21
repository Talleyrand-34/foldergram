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

export async function fetchFoldersWithRollup(
  limit = 200,
  offset = 0,
): Promise<FolderKnowledgeRow[]> {
  try {
    const r = await requestJson<{ folders: FolderKnowledgeRow[] }>(
      `/api/plugins/ai-analysis/knowledge/folders?limit=${limit}&offset=${offset}`,
    );
    return r.folders ?? [];
  } catch {
    return [];
  }
}

export async function updateFolderProfileAiOverride(
  folderSlug: string,
  override: FolderRollupOverride,
): Promise<boolean> {
  try {
    await requestJson(`/api/folders/${encodeURIComponent(folderSlug)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: undefined as unknown as string, aiOverride: override } as Record<string, unknown>),
    });
    return true;
  } catch {
    return false;
  }
}

export interface AiDomainNode {
  domain: string;
  videoCount: number;
  folderCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  languages: Record<string, number>;
  /** Human-authored description of what this domain represents. */
  description: string | null;
  /** Recently-tagged videos — loaded on demand when opening the knowledge
   *  modal. Not returned by the list endpoint; populated separately. */
  recentVideos?: DomainVideo[];
}

export async function fetchTopDomains(limit = 200): Promise<AiDomainNode[]> {
  try {
    const r = await requestJson<{ domains: AiDomainNode[] }>(
      `/api/plugins/ai-analysis/knowledge/domains?limit=${limit}`,
    );
    return r.domains ?? [];
  } catch {
    return [];
  }
}

export async function fetchTopDomainStrings(limit = 200): Promise<string[]> {
  const rows = await fetchTopDomains(limit);
  return rows.map((d) => d.domain);
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

export async function addDomain(domain: string): Promise<boolean> {
  try {
    await requestJson(`/api/plugins/ai-analysis/knowledge/domains`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain }),
    });
    return true;
  } catch {
    return false;
  }
}

export async function renameDomain(oldDomain: string, newDomain: string): Promise<boolean> {
  try {
    await requestJson(
      `/api/plugins/ai-analysis/knowledge/domains/${encodeURIComponent(oldDomain)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newDomain }),
      },
    );
    return true;
  } catch {
    return false;
  }
}

export async function deleteDomain(domain: string): Promise<boolean> {
  try {
    await requestJson(
      `/api/plugins/ai-analysis/knowledge/domains/${encodeURIComponent(domain)}`,
      { method: 'DELETE' },
    );
    return true;
  } catch {
    return false;
  }
}

export async function updateDomainDescription(
  domain: string,
  description: string | null,
): Promise<boolean> {
  try {
    await requestJson(
      `/api/plugins/ai-analysis/knowledge/domains/${encodeURIComponent(domain)}/description`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description }),
      },
    );
    return true;
  } catch {
    return false;
  }
}

export interface DomainVideo {
  id: number;
  filename: string;
  relativePath: string;
  folderName: string;
  folderSlug: string;
  aiSummary: string | null;
  aiLanguage: string | null;
}

export async function fetchVideosForDomain(
  domain: string,
  limit = 50,
): Promise<DomainVideo[]> {
  try {
    const r = await requestJson<{ videos: DomainVideo[] }>(
      `/api/plugins/ai-analysis/knowledge/domains/${encodeURIComponent(domain)}/videos?limit=${limit}`,
    );
    return r.videos ?? [];
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
