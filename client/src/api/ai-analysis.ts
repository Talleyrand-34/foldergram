/**
 * Typed client for the AI-analysis plugin's REST endpoints.
 *
 * Endpoints (all under /api/plugins/ai-analysis):
 *   GET  /status              → overall progress
 *   GET  /search?q=&domain=&tag=&language=&limit= → analyzed-video hits
 *   POST /analyze/:imageId[?force]                → enqueue one video
 *   POST /analyze-folder/:folderId[?force]        → enqueue every video in a folder
 *   GET  /config              → the provider + pipeline configuration
 *   POST /config              → change the configuration
 *   POST /config/test         → probe a provider
 *
 * The `force` flag re-runs analysis even when the source mtime hasn't changed
 * (useful when the model has improved or results were bad).
 *
 * The configuration carries the provider API keys, so the server never sends
 * them back: a provider arrives with `hasApiKey` and a mask instead.
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

/**
 * How to talk to a provider.
 *
 * `openai-compatible` is the plain OpenAI shape. `minimax` is the same shape
 * with MiniMax's differences: `max_completion_tokens` instead of the
 * deprecated `max_tokens`, no `response_format`, and the thinking controls.
 */
export type AiProviderDialect = 'openai-compatible' | 'minimax';

/**
 * A provider, as the browser sees it.
 *
 * The API key is never sent back: `hasApiKey` says whether one is stored and
 * `apiKeyMasked` shows its last few characters.
 */
export interface AiProviderView {
  id: string;
  label: string;
  dialect: AiProviderDialect;
  baseUrl: string;
  defaultModel: string;
  headers: Record<string, string>;
  /** MiniMax thinking depth; empty means the API default. */
  reasoningEffort: string;
  /** MiniMax thinking mode; empty means the API default. */
  thinkingType: string;
  /** This provider's own usage limits. */
  usageLimits: AiProviderUsageLimitsView;
  hasApiKey: boolean;
  apiKeyMasked: string;
}

/** A provider as the form holds it. */
export interface AiProviderInput {
  id: string;
  label: string;
  dialect: AiProviderDialect;
  baseUrl: string;
  defaultModel: string;
  headers: Record<string, string>;
  reasoningEffort?: string;
  thinkingType?: string;
  /** This provider's own usage limits. */
  usageLimits?: AiProviderUsageLimits;
  /** Omitted keeps the stored key; an empty string clears it. */
  apiKey?: string;
}

/** Which provider and model a stage uses. */
export interface AiStageTarget {
  providerId: string;
  model: string;
}

export interface AiVisionStage extends AiStageTarget {
  maxTokens: number;
  timeoutMs: number;
  jsonMode: boolean;
}

export interface AiAudioStage extends AiStageTarget {
  timeoutMs: number;
  /** Forced ISO 639-1 code, or null to let the model detect it. */
  language: string | null;
}

export interface AiEmbedStage extends AiStageTarget {
  enabled: boolean;
  timeoutMs: number;
}

export interface AiCanonicalizerStage {
  enabled: boolean;
  url: string;
  timeoutMs: number;
  /** Check laya's decision with the AI — it catches false positives. */
  verify: boolean;
}

/** The knobs of the per-video pipeline. */
export interface AiPipelineConfig {
  frameCount: number;
  framePositions: number[];
  extractAudio: boolean;
  writeCaption: boolean;
  updateKnowledgeGraph: boolean;
  minDurationSeconds: number;
  maxDurationSeconds: number;
}

/** The windows a usage limit can be set for. */
export type AiUsageWindow = 'hourly' | 'daily' | 'weekly' | 'monthly';

/**
 * One usage window.
 *
 * The length is free-form, because a provider's own allowance is not: a plan
 * can count tokens over a rolling 5-hour window, a calendar week, or anything
 * else.
 */
export interface AiUsageWindowRule {
  /** The window's length, in hours. 1 = hourly, 24 = daily, 168 = weekly. */
  hours: number;
  /** The share of the budget this window may use, as a percentage. */
  percent: number;
}

/**
 * How the queue decides to stop.
 *
 * `hard` uses the operator's own windows. `smart` watches the provider's
 * shared plan and yields to whoever else is using it.
 */
export type AiUsageMode = 'hard' | 'smart';

/**
 * The smart mode's settings.
 *
 * The plan is read from a read-only endpoint. MiniMax's Token Plan publishes
 * one — `/v1/token_plan/remains` — and it reports what *everybody* used.
 */
export interface AiSmartUsageLimits {
  /** The read-only endpoint that reports the plan. Empty derives it. */
  probeUrl: string;
  /** The key for the endpoint. Empty uses the provider's own key. */
  probeApiKey?: string;
  /** Which of the plan's windows to watch. */
  watch: 'interval' | 'weekly' | 'both';
  /** How often to read the plan, in minutes. */
  pollMinutes: number;
  /** The share of the plan to take while nobody else is using it. */
  idlePercent: number;
  /** The share of the plan to take while somebody else is using it. */
  yieldPercent: number;
  /** The share of the plan's drain above which it counts as shared. */
  contentionPercent: number;
  /** Let the plan's own wall be the only limit. */
  ignoreHardWindows: boolean;
}

/**
 * A provider's usage limits.
 *
 * Per provider, because the providers' allowances differ. The windows are
 * rolling — "in the last N hours".
 */
export interface AiProviderUsageLimits {
  enabled: boolean;
  /** The total token budget the percentages are shares of. */
  budget: number;
  windows: AiUsageWindowRule[];
  /** Which rule decides when the queue stops. */
  mode: AiUsageMode;
  /** The smart mode's settings. */
  smart: AiSmartUsageLimits;
}

/**
 * The smart mode's settings as the browser sees them.
 *
 * The probe's key never leaves the server: it comes back as a flag and a
 * mask.
 */
export interface AiSmartUsageView extends Omit<AiSmartUsageLimits, 'probeApiKey'> {
  hasProbeApiKey: boolean;
  probeApiKeyMasked: string;
}

/** The usage limits as the browser sees them. */
export interface AiProviderUsageLimitsView
  extends Omit<AiProviderUsageLimits, 'smart'> {
  smart: AiSmartUsageView;
}

/** One of the plan's windows, as the provider's plan reports it. */
export interface AiPlanWindow {
  /** Which window this is: the plan's interval, or its week. */
  kind: 'interval' | 'weekly';
  /** How much of the window is left, as a percentage. */
  remainingPercent: number;
  /** The plan's absolute allowance. Zero when the plan publishes none. */
  total: number;
  /** How much of it is used — by everybody. */
  used: number;
  /** When the window starts, in epoch milliseconds. */
  startTime: number;
  /** When the window ends, in epoch milliseconds. */
  endTime: number;
  /** How long until the window rolls over, in seconds. */
  rollsOverInSeconds: number;
  /**
   * How long the window lasts at the rate it is being spent, in hours.
   *
   * Null when the plan is not being spent, or when there is not enough
   * history yet to tell how fast it is going.
   */
  hoursLeft: number | null;
}

/** What the smart mode says about one provider's plan. */
export interface AiSmartProviderState {
  providerId: string;
  label: string;
  /** The plan could be read. */
  probeOk: boolean;
  /** Why it could not be read. */
  probeError: string | null;
  /** The model the plan reports for. */
  model: string | null;
  /** Somebody else is using the plan. */
  contended: boolean;
  /** How much of the plan's use was not ours. */
  residual: number;
  /** The share of the plan we may take right now. */
  allowedPercent: number;
  /** The plan's allowance for the watched window. */
  poolTotal: number;
  /** How much of it is used — by everybody. */
  poolUsed: number;
  /** Our own use of it. */
  ourUsage: number;
  /** The cap: the share of the plan we may take. */
  cap: number;
  /**
   * How much of the watched window the plan says is left, as a percentage.
   *
   * Null when the plan could not be read. When the plan publishes no
   * absolute allowance this is the only number there is.
   */
  poolRemainingPercent: number | null;
  /** Every window the plan publishes, with what is left of each. */
  windows: AiPlanWindow[];
  /** We have taken our share. */
  blocked: boolean;
  /** When the watched window rolls over. */
  resetsAt: string | null;
  /** When the plan was last read. */
  readAt: number;
}

/**
 * The token budgets.
 *
 * The limits are percentages of ONE budget: the total allowance. Each window
 * gets the share of it that may be spent in that window — 50 % of the budget
 * per day, 70 % per week. Zero means "no limit for this window".
 */
export interface AiUsageLimits {
  enabled: boolean;
  /** The total token budget the shares are taken of. */
  budget: number;
  /** The share of the budget the current hour may use. */
  hourly: number;
  /** The share of the budget today may use. */
  daily: number;
  /** The share of the budget this week may use. */
  weekly: number;
  /** The share of the budget this month may use. */
  monthly: number;
}

/** The usage in one window. */
export interface AiUsageWindowStatus {
  /** The window's length, in hours. */
  hours: number;
  used: number;
  /** The token budget for this window — the budget times the share. */
  limit: number;
  /** The share of THIS window's budget used, 0–100+. */
  percent: number;
  overThreshold: boolean;
  resetsAt: string;
}

/** What one provider has spent. */
export interface AiProviderUsageStatus {
  providerId: string;
  label: string;
  enabled: boolean;
  budget: number;
  windows: AiUsageWindowStatus[];
  blocked: boolean;
  blockedWindow: number | null;
  blockedUntil: string | null;
}

/** What every provider has spent, and whether any of them must stop. */
export interface AiUsageStatus {
  providers: AiProviderUsageStatus[];
  /** A provider is over its share — the queue must not claim work. */
  blocked: boolean;
}

export interface AiAnalysisConfig {
  providers: AiProviderView[];
  stages: {
    vision: AiVisionStage;
    audio: AiAudioStage;
    embed: AiEmbedStage;
    canonicalizer: AiCanonicalizerStage;
  };
  pipeline: AiPipelineConfig;
}

export interface AiConfigResponse {
  config: AiAnalysisConfig;
  /** Problems with the configuration; empty when it is healthy. */
  errors: string[];
  /** What the pipeline has spent so far. */
  usage: AiUsageStatus;
  /** What the smart mode says about the shared plans. */
  smart: AiSmartProviderState[];
}

/** The result of probing a provider. */
export interface AiProviderTestResult {
  ok: boolean;
  /** The HTTP status, or null when the endpoint could not be reached. */
  status: number | null;
  message?: string;
  models?: string[];
  modelCount?: number;
  /** Whether the requested model was in the list; null when not checked. */
  modelFound?: boolean | null;
}

/**
 * The models a provider offers.
 *
 * The names are read from the provider, not typed, so a typo cannot stop
 * the queue.
 */
export interface AiProviderModels {
  providerId: string;
  /** The model names, as the provider spells them. */
  models: string[];
  /** How many the provider advertises in total. */
  modelCount: number;
  /** Why the list could not be read, if it could not. */
  error: string | null;
}

/** The state of the domain re-check sweep. */
export interface AiCanonicalizationState {
  running: boolean;
  /** How many posts were looked at. */
  checked: number;
  /** How many of them were moved to a different domain. */
  moved: number;
  /** How many domains the taxonomy has. */
  domains: number;
  lastRunAt: string | null;
  error: string | null;
  /** Recent activity, oldest first. */
  log: string[];
}

export interface AiCanonicalizationStatus {
  state: AiCanonicalizationState;
  /** How many domains the taxonomy has. */
  domains: number;
  /** The canonicalizer is switched on. */
  enabled: boolean;
  /** The AI checks laya's decisions. */
  verify: boolean;
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

export interface RateLimitState {
  limitedUntil: number | null;
  limitedUntilIso: string | null;
  retryAfterSec: number | null;
}

export async function fetchRateLimit(): Promise<RateLimitState> {
  try {
    return await requestJson<RateLimitState>(
      '/api/plugins/ai-analysis/rate-limit',
    );
  } catch {
    return { limitedUntil: null, limitedUntilIso: null, retryAfterSec: null };
  }
}

export async function triggerAutoBackfill(): Promise<{
  foldersScanned: number;
  videosQueued: number;
} | null> {
  try {
    return await requestJson(
      '/api/plugins/ai-analysis/auto-backfill',
      { method: 'POST' },
    );
  } catch {
    return null;
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


export interface PendingSynonym {
  id: number;
  canonicalDomain: string;
  proposedAlias: string;
  sourceVideoId: number | null;
  confidence: number | null;
  reason: string | null;
  detectedAt: string;
  status: 'pending' | 'approved' | 'rejected';
  resolvedAt: string | null;
}

export async function fetchPendingSynonyms(limit = 100): Promise<PendingSynonym[]> {
  try {
    const r = await requestJson<{ items: PendingSynonym[] }>(
      `/api/plugins/ai-analysis/knowledge/synonyms?limit=${limit}`,
    );
    return r.items ?? [];
  } catch {
    return [];
  }
}

export async function resolvePendingSynonym(
  id: number,
  resolution: 'approved' | 'rejected',
): Promise<boolean> {
  try {
    await requestJson(
      `/api/plugins/ai-analysis/knowledge/synonyms/${id}/resolve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolution }),
      },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The provider + pipeline configuration.
 *
 * The response carries the problems with the configuration, if any — the
 * server reports all of them so the UI can list them.
 */
export async function fetchAiConfig(): Promise<AiConfigResponse> {
  return await requestJson<AiConfigResponse>('/api/plugins/ai-analysis/config');
}

/**
 * Change the configuration.
 *
 * Only the fields in the patch are changed. A provider without an `apiKey`
 * keeps its stored one; an explicit empty string clears it.
 */
export async function saveAiConfig(patch: {
  providers?: AiProviderInput[];
  /**
   * The providers to delete, by name.
   *
   * A provider that is simply left out of the list is **kept** — a stale
   * page must never delete a provider somebody else added. A deletion has to
   * be asked for by name.
   */
  removeProviders?: string[];
  stages?: Partial<AiAnalysisConfig['stages']>;
  pipeline?: Partial<AiPipelineConfig>;
}): Promise<AiConfigResponse> {
  return await requestJson<AiConfigResponse>('/api/plugins/ai-analysis/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/**
 * Probe a provider before trusting it.
 *
 * The provider may be one that has not been saved yet — that is the point of
 * the button.
 */
/**
 * The models a saved provider offers.
 *
 * The list is read with the stored key, so the key never travels to the
 * browser.
 */
export async function fetchProviderModels(providerId: string): Promise<AiProviderModels> {
  return await requestJson<AiProviderModels>(
    `/api/plugins/ai-analysis/providers/${encodeURIComponent(providerId)}/models`
  );
}

export async function testAiProvider(
  provider: AiProviderInput,
  model?: string,
): Promise<AiProviderTestResult> {
  return await requestJson<AiProviderTestResult>('/api/plugins/ai-analysis/config/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider, model }),
  });
}

/**
 * The state of the domain canonicalization.
 *
 * The canonicalizer maps the proposed domains onto the existing taxonomy, an
 * AI check verifies the decision, and the sweep re-checks the earlier posts
 * once the taxonomy has grown.
 */
export async function fetchAiCanonicalization(): Promise<AiCanonicalizationStatus> {
  return await requestJson<AiCanonicalizationStatus>('/api/plugins/ai-analysis/canonicalization');
}

/**
 * Re-check the analysed posts against the current taxonomy.
 *
 * A post whose domain set has grown since it was analysed may fit a newer
 * domain better than the one it was given.
 */
export async function runAiCanonicalization(
  limit = 200,
): Promise<{ state: AiCanonicalizationState }> {
  return await requestJson<{ state: AiCanonicalizationState }>(
    '/api/plugins/ai-analysis/canonicalization/run',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit }),
    },
  );
}
