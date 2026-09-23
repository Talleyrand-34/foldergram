/**
 * laya-client — thin HTTP client for the laya-classifier service.
 *
 * Sends a /canonicalize request to the service running on minisforum.
 * Falls back gracefully (returns null) if the service is unreachable,
 * which lets the worker proceed with M3's raw suggestions and just
 * register the canonical one as the original. The taxonomy still grows
 * organically; we just lose synonym detection for that video.
 */

const LAYA_URL = process.env.LAYA_CLASSIFIER_URL ?? '';

export interface CanonicalDomainResult {
  original: string;
  status: 'match' | 'alias' | 'new';
  canonical: string;
  confidence: number;
  reason: string;
}

export interface CanonicalLanguageResult {
  status: 'known' | 'new';
  canonical: string;
  confidence: number;
}

export interface CanonicalResult {
  domains: CanonicalDomainResult[];
  language: CanonicalLanguageResult | null;
  model: string;
}

export interface CanonicalRequest {
  state: string;
  suggestedDomains: string[];
  suggestedLanguage: string | null;
  existingDomains: { name: string; videoCount: number }[];
  existingLanguages: string[];
}

export interface CanonicalFailure {
  ok: false;
  reason: 'disabled' | 'unreachable' | 'bad-response' | string;
}

export type CanonicalResponse =
  | (CanonicalResult & { ok: true })
  | CanonicalFailure;

export async function canonicalize(
  req: CanonicalRequest,
  timeoutMs = 30_000,
): Promise<CanonicalResponse> {
  if (!LAYA_URL) {
    return { ok: false, reason: 'disabled' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${LAYA_URL.replace(/\/$/, '')}/canonicalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      return { ok: false, reason: `bad-response:${r.status}` };
    }
    const data = (await r.json()) as Partial<CanonicalResult>;
    if (!data || !Array.isArray(data.domains)) {
      return { ok: false, reason: 'bad-response' };
    }
    return { ok: true, ...(data as CanonicalResult) } as
      CanonicalResult & { ok: true };
  } catch (e) {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
