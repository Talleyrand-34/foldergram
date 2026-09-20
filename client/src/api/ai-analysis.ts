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

export async function analyzeFolder(
  folderId: number,
  force = false,
): Promise<AiAnalyzeFolderResponse> {
  return await requestJson<AiAnalyzeFolderResponse>(
    `/api/plugins/ai-analysis/analyze-folder/${folderId}${force ? '?force=1' : ''}`,
    { method: 'POST' },
  );
}
