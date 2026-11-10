/**
 * Domain canonicalization.
 *
 * The pipeline is four steps, in this order:
 *
 *   1. **laya** maps the domains the analysis proposed onto the existing
 *      taxonomy — a match, an alias, or a genuinely new domain. It is fast
 *      and cheap, but it is a *similarity* judgement: it can put a post into a
 *      domain that is merely the closest one it was offered.
 *   2. **an AI check** verifies the decision. The model sees the post's
 *      content and judges whether the canonical domain is a genuine fit —
 *      including the case where laya only picked it because nothing better
 *      was on the table. A false positive is rejected, and the post is either
 *      moved to a better domain or its original suggestion is registered as a
 *      new domain.
 *   3. **new domains** are registered when nothing fits, so the taxonomy
 *      grows instead of forcing everything into an existing bucket.
 *   4. **a second pass**: once the whole library has been checked and the
 *      taxonomy has grown, the earlier posts are re-checked against it — a
 *      domain that was proposed later may fit them better than the one they
 *      were given.
 */

import { chat } from "./lib/litellm-client.js";
import { canonicalize } from "./lib/laya-client.js";
import {
  applyCanonicalization,
  countDomains,
  findPostsNeedingRecanonicalization,
  getExistingDomainsForCanonicalization,
  getExistingLanguagesForCanonicalization,
  recordPendingSynonym,
  registerNewDomain,
  touchExistingDomain,
  type PostCanonicalization
} from "./storage.js";

/** What laya decided about one proposed domain. */
export interface CanonicalizationCandidate {
  /** The domain the analysis proposed. */
  original: string;
  /** The domain laya mapped it to. */
  canonical: string;
  status: "match" | "alias" | "new";
  confidence: number;
  reason: string;
}

/** What the AI check decided. */
export interface VerifiedDecision {
  /** The domain the analysis proposed. */
  original: string;
  /** The domain the post ends up in. */
  domain: string;
  /**
   * `confirmed` — laya was right.
   * `reassigned` — the post fits a different existing domain.
   * `new` — nothing fits; the original suggestion becomes a new domain.
   */
  outcome: "confirmed" | "reassigned" | "new";
  /** Why. */
  reason: string;
}

const VERIFY_PROMPT = `You are checking whether an automatic taxonomy decision was correct.

A video analysis proposed some domain names. A classifier ("laya") then mapped each
proposed domain onto the EXISTING domain taxonomy, choosing the closest existing
domain — or saying the domain is NEW.

Your job is to catch FALSE POSITIVES. Look at the video's content and judge:
does the domain laya chose genuinely describe this video?

Be strict. A domain that is merely the closest available one is NOT a match:
if the classifier picked it only because nothing better was offered, that is a
false positive and you must reject it.

Output JSON with this exact shape:
{
  "decisions": [
    {
      "original": "the proposed domain, verbatim",
      "verdict": "confirmed" | "rejected",
      "domain": "the domain the video belongs in",
      "proposeNew": false,
      "reason": "one short sentence"
    }
  ]
}

Rules for "domain" and "proposeNew":
- If you CONFIRM: "domain" is the domain laya chose, and "proposeNew" is false.
- If you REJECT and a DIFFERENT EXISTING domain fits better: "domain" is that
  existing domain (it must appear in the existing list) and "proposeNew" is false.
- If you REJECT and NO existing domain fits: "domain" is the original proposed
  domain and "proposeNew" is true — it becomes a new domain.

The existing domains are listed below. Do not invent a domain that is not in
that list unless "proposeNew" is true.

Content of the video:
"""
{content}
"""

Proposed domains and the classifier's answer:
{proposals}

Existing domains:
{existing}

Return ONLY the JSON object. No prose, no markdown.`;

/** Parse the AI's answer leniently — the same way the analyzer parses JSON. */
export function parseVerification(raw: string): VerifiedDecision[] {
  if (!raw) return [];

  const stripped = raw
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) return [];
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return [];
    }
  }

  const decisions = (parsed as { decisions?: unknown })?.decisions;
  if (!Array.isArray(decisions)) return [];

  const out: VerifiedDecision[] = [];
  for (const entry of decisions) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const original = typeof value.original === "string" ? value.original : "";
    if (!original) continue;

    const verdict = value.verdict === "confirmed" ? "confirmed" : "rejected";
    const proposeNew = value.proposeNew === true;
    const domain = typeof value.domain === "string" ? value.domain : original;
    const reason = typeof value.reason === "string" ? value.reason : "";

    out.push({
      original,
      domain: domain.trim() || original,
      outcome: verdict === "confirmed" ? "confirmed" : proposeNew ? "new" : "reassigned",
      reason
    });
  }
  return out;
}

/**
 * Check laya's decisions with the AI.
 *
 * A failure here is not fatal: the decisions laya made are kept, because a
 * plain similarity match is better than nothing.
 */
export async function verifyCanonicalizations(input: {
  content: string;
  candidates: CanonicalizationCandidate[];
  existingDomains: { name: string; videoCount: number }[];
}): Promise<VerifiedDecision[] | null> {
  if (input.candidates.length === 0) return [];

  const proposals = input.candidates
    .map(
      (candidate) =>
        `- "${candidate.original}" → "${candidate.canonical}" (${candidate.status}, confidence ${candidate.confidence})`
    )
    .join("\n");

  const existing = input.existingDomains
    .map((domain) => `- ${domain.name} (${domain.videoCount} videos)`)
    .join("\n");

  const result = await chat({
    json: true,
    messages: [
      {
        role: "user",
        content: VERIFY_PROMPT.replace("{content}", input.content || "(no transcript)")
          .replace("{proposals}", proposals)
          .replace("{existing}", existing || "(none yet)")
      }
    ]
  });

  return parseVerification(result.content);
}

/** The content the verification and laya see: the transcript, then the summary. */
export function canonicalizationContent(post: {
  transcript?: string | null;
  summary?: string | null;
}): string {
  const parts: string[] = [];
  if (post.transcript && post.transcript.trim()) {
    parts.push(`Transcript:\n${post.transcript.trim()}`);
  }
  if (post.summary && post.summary.trim()) {
    parts.push(`Summary: ${post.summary.trim()}`);
  }
  return parts.join("\n\n");
}

/**
 * Canonicalize one post: laya first, then the AI check.
 *
 * Returns the domains the post ends up in.
 */
export async function canonicalizePost(input: {
  imageId: number;
  transcript: string | null;
  summary: string | null;
  suggestedDomains: string[];
  suggestedLanguage: string | null;
  existingDomains: { name: string; videoCount: number }[];
  existingLanguages: string[];
  /** Verify laya's decision with the AI. */
  verify: boolean;
}): Promise<{
  /**
   * False when the canonicalizer could not be reached. The answer is then the
   * raw suggestions, and MUST NOT be written over a decision that was already
   * made.
   */
  ok: boolean;
  /**
   * True when the AI check ran. False means laya's decision is unverified —
   * good enough for a fresh post, not good enough to overrule one.
   */
  verified: boolean;
  domains: string[];
  decisions: VerifiedDecision[];
  /** The canonicalized language, when laya confirmed one. */
  language: string | null;
  error: string | null;
}> {
  const content = canonicalizationContent(input);
  const layaResp = await canonicalize({
    content,
    suggestedDomains: input.suggestedDomains,
    suggestedLanguage: input.suggestedLanguage,
    existingDomains: input.existingDomains,
    existingLanguages: input.existingLanguages
  });

  if (layaResp.ok === false) {
    // The canonicalizer is off or unreachable — the raw suggestions stand.
    return {
      ok: false,
      verified: false,
      domains: input.suggestedDomains,
      decisions: [],
      language: null,
      error: layaResp.reason
    };
  }

  const candidates: CanonicalizationCandidate[] = layaResp.domains.map((domain) => ({
    original: domain.original,
    canonical: domain.canonical,
    status: domain.status,
    confidence: domain.confidence,
    reason: domain.reason ?? ""
  }));

  let decisions: VerifiedDecision[] = candidates.map((candidate) => ({
    original: candidate.original,
    domain: candidate.canonical,
    outcome: candidate.status === "new" ? "new" : "confirmed",
    reason: candidate.reason
  }));

  let error: string | null = null;
  let verified = false;

  if (input.verify && candidates.length > 0) {
    try {
      const checked = await verifyCanonicalizations({
        content,
        candidates,
        existingDomains: input.existingDomains
      });
      if (checked && checked.length > 0) {
        verified = true;
        // Keep laya's decision for any candidate the AI did not mention.
        const byOriginal = new Map(checked.map((entry) => [entry.original, entry]));
        decisions = candidates.map((candidate) => {
          const decision = byOriginal.get(candidate.original);
          if (!decision) {
            return {
              original: candidate.original,
              domain: candidate.canonical,
              outcome: candidate.status === "new" ? "new" : "confirmed",
              reason: candidate.reason
            };
          }
          return decision;
        });
      }
    } catch (e) {
      // The check is a safety net, not a gate: a failure keeps laya's answer.
      error = e instanceof Error ? e.message : String(e);
    }
  } else if (!input.verify) {
    // The operator turned the check off, so laya's answer is the answer.
    verified = true;
  }

  const domains: string[] = [];
  for (const decision of decisions) {
    if (decision.outcome === "new") {
      // Nothing existing fits — the original suggestion becomes a new domain.
      await registerNewDomain(decision.domain);
      domains.push(decision.domain);
      continue;
    }

    if (decision.outcome === "reassigned") {
      // The AI moved it to a better existing domain.
      await touchExistingDomain(decision.domain);
      domains.push(decision.domain);
      continue;
    }

    // Confirmed: keep laya's answer and record the alias for review.
    const candidate = candidates.find((entry) => entry.original === decision.original);
    if (candidate?.status === "new") {
      await registerNewDomain(candidate.canonical);
      domains.push(candidate.canonical);
    } else {
      await touchExistingDomain(candidate?.canonical ?? decision.domain);
      domains.push(candidate?.canonical ?? decision.domain);
      if (candidate?.status === "alias") {
        await recordPendingSynonym(
          candidate.canonical,
          candidate.original,
          input.imageId,
          candidate.confidence,
          candidate.reason || decision.reason || null
        );
      }
    }
  }

  return {
    ok: true,
    verified,
    domains,
    decisions,
    language: layaResp.language?.canonical ?? null,
    error
  };
}

/** The state of the re-check sweep. */
export interface RecanonicalizationState {
  running: boolean;
  /** How many posts were looked at. */
  checked: number;
  /** How many of them were moved to a different domain. */
  moved: number;
  /**
   * How many were left alone because the decision could not be verified.
   */
  skipped: number;
  /** How many domains the taxonomy has. */
  domains: number;
  lastRunAt: string | null;
  error: string | null;
  log: string[];
}

const MAX_LOG = 40;
let sweepState: RecanonicalizationState = {
  running: false,
  checked: 0,
  moved: 0,
  skipped: 0,
  domains: 0,
  lastRunAt: null,
  error: null,
  log: []
};

export function getRecanonicalizationState(): RecanonicalizationState {
  return sweepState;
}

function logLine(message: string): void {
  sweepState = {
    ...sweepState,
    log: [...sweepState.log, message].slice(-MAX_LOG)
  };
}

/**
 * Re-check the earlier posts against the grown taxonomy.
 *
 * A post is a candidate when a domain was created after the post was
 * analysed: that domain was not on the table when the post was filed, so it
 * may fit better than the one the post got.
 */
export async function runRecanonicalizationSweep(
  limit = 200,
  verify = true
): Promise<RecanonicalizationState> {
  if (sweepState.running) {
    return sweepState;
  }

  sweepState = {
    ...sweepState,
    running: true,
    checked: 0,
    moved: 0,
    error: null
  };
  logLine(`Re-checking up to ${limit} posts against the current taxonomy`);

  try {
    const posts = await findPostsNeedingRecanonicalization(limit);
    const existingDomains = await getExistingDomainsForCanonicalization();
    const existingLanguages = await getExistingLanguagesForCanonicalization();

    let moved = 0;
    let skipped = 0;
    for (const post of posts) {
      const suggestions = post.suggestedDomains.length > 0
        ? post.suggestedDomains
        : post.currentDomains;
      if (suggestions.length === 0) continue;

      const result = await canonicalizePost({
        imageId: post.imageId,
        transcript: post.transcript,
        summary: post.summary,
        suggestedDomains: suggestions,
        suggestedLanguage: post.language,
        existingDomains,
        existingLanguages,
        verify
      });

      // A decision that could not be verified must NOT overrule one that
      // was: laya's similarity match is exactly the false positive the check
      // exists to catch, so an unverified answer is not allowed to move a
      // post that was already filed.
      if (!result.ok) {
        sweepState = { ...sweepState, checked: sweepState.checked + 1 };
        continue;
      }
      if (verify && !result.verified) {
        sweepState = { ...sweepState, checked: sweepState.checked + 1 };
        skipped += 1;
        continue;
      }

      const changed =
        result.domains.length > 0 &&
        !sameSet(result.domains, post.currentDomains);

      if (changed) {
        moved += 1;
        await applyCanonicalization(
          post.imageId,
          result.domains,
          result.language ?? post.language ?? null,
          JSON.stringify({
            domains: result.decisions,
            recheck: true,
            at: new Date().toISOString()
          })
        );
        logLine(`${post.imageId}: ${post.currentDomains.join(", ") || "—"} → ${result.domains.join(", ")}`);
      }

      sweepState = { ...sweepState, checked: sweepState.checked + 1, moved };
    }

    sweepState = {
      ...sweepState,
      running: false,
      moved,
      skipped,
      domains: await countDomains(),
      lastRunAt: new Date().toISOString()
    };
    logLine(
      `Done — ${sweepState.checked} checked, ${moved} moved, ${skipped} left alone`
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    sweepState = {
      ...sweepState,
      running: false,
      error: message,
      lastRunAt: new Date().toISOString()
    };
    logLine(`Failed: ${message}`);
  }

  return sweepState;
}

/** Do two domain lists hold the same domains? */
export function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a.map((entry) => entry.trim().toLowerCase()));
  for (const entry of b) {
    if (!left.has(entry.trim().toLowerCase())) return false;
  }
  return true;
}

export type { PostCanonicalization };
