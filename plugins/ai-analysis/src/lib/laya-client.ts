/**
 * laya-client — HTTP client for the laya-decisions service.
 *
 * The service lives on minisforum and answers *questions* about a piece of
 * state, so the client builds the questions and reads the answers:
 *
 *   POST {base}/v1/route  { state, questions }  →  { model, answers, routing }
 *
 * `/v1/route` (rather than `/v1/decisions`) is used because it picks the
 * checkpoint from the script of the content: a Spanish video goes to the
 * English model, a Hindi one to the multilingual model. The plugin analyses
 * videos in every language, so that choice matters.
 *
 * The plugin asks two kinds of question:
 *
 *   - for each proposed domain: "does this match an existing domain, or is
 *     it NEW?";
 *   - for the language: "what is the canonical ISO 639-1 code?".
 *
 * A failure is never fatal: the caller keeps the raw suggestions.
 */

import { readAiConfig } from "../configStore.js";

/** One proposed domain and laya's answer about it. */
export interface CanonicalDomainResult {
  original: string;
  status: "match" | "alias" | "new";
  canonical: string;
  confidence: number;
  reason: string;
}

export interface CanonicalLanguageResult {
  status: "known" | "new";
  canonical: string;
  confidence: number;
}

export interface CanonicalResult {
  domains: CanonicalDomainResult[];
  language: CanonicalLanguageResult | null;
  model: string;
}

export interface CanonicalRequest {
  /** The content the questions are asked about — the transcript and summary. */
  content: string;
  suggestedDomains: string[];
  suggestedLanguage: string | null;
  existingDomains: { name: string; videoCount: number }[];
  existingLanguages: string[];
}

export interface CanonicalFailure {
  ok: false;
  reason: "disabled" | "unreachable" | "bad-response" | string;
}

export type CanonicalResponse = (CanonicalResult & { ok: true }) | CanonicalFailure;

/** The choice question laya answers. */
interface LayaQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, null>;
}

type LayaQuestions = Record<string, LayaQuestion>;

interface LayaAnswer {
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

interface LayaRouteResponse {
  model?: string;
  answers?: Record<string, LayaAnswer>;
  routing?: { model?: string; reason?: string; script?: string };
  elapsed_ms?: number;
}

/** A slug for a domain that laya did not recognise. */
export function slugifyDomain(value: string): string {
  const out: string[] = [];
  for (const ch of value.toLowerCase().trim()) {
    if (/[a-z0-9]/.test(ch) || ch === "/" || ch === "-") {
      out.push(ch);
    } else if (ch === " " || ch === "_") {
      out.push("-");
    }
  }
  const slug = out.join("").replace(/^-+|-+$/g, "");
  return slug || "misc/unknown";
}

/**
 * The question for one proposed domain.
 *
 * The existing domains are the options; `NEW` is always one of them, so the
 * model can say "none of these fit".
 */
export function buildDomainQuestion(
  suggestion: string,
  index: number,
  existingNames: string[]
): LayaQuestion {
  const criteria: Record<string, null> = {};
  for (const name of existingNames) criteria[name] = null;
  criteria["NEW"] = null;

  return {
    type: "choice",
    instructions:
      `Domain suggestion #${index}: "${suggestion}". ` +
      "Match an existing node by meaning, or pick NEW if it is genuinely novel.",
    criteria
  };
}

/** The question for the language. */
export function buildLanguageQuestion(existingLanguages: string[]): LayaQuestion {
  const criteria: Record<string, null> = {};
  for (const language of existingLanguages) criteria[language] = null;
  criteria["NEW"] = null;

  return {
    type: "choice",
    instructions:
      "Pick the canonical ISO 639-1 code for this text. " +
      "Prefer an existing known language. If the text is in a language " +
      "not in the existing list, pick NEW with the correct code.",
    criteria
  };
}

/** Build every question the canonicalization needs. */
export function buildQuestions(request: CanonicalRequest): LayaQuestions {
  const existingNames = request.existingDomains.map((domain) => domain.name);
  const questions: LayaQuestions = {};

  request.suggestedDomains.forEach((suggestion, index) => {
    questions[`domain_${index}`] = buildDomainQuestion(
      suggestion,
      index,
      existingNames
    );
  });

  if (request.suggestedLanguage) {
    questions["language"] = buildLanguageQuestion(request.existingLanguages);
  }

  return questions;
}

/**
 * Turn laya's answers into the plugin's decision shape.
 *
 * A proposed domain that laya matched to an existing one is a "match" when
 * the names are the same and an "alias" when it picked a different one.
 */
export function readAnswers(
  answers: Record<string, LayaAnswer>,
  request: CanonicalRequest
): { domains: CanonicalDomainResult[]; language: CanonicalLanguageResult | null } {
  const domains: CanonicalDomainResult[] = [];

  request.suggestedDomains.forEach((suggestion, index) => {
    const answer = answers[`domain_${index}`] ?? {};
    const choice = typeof answer.choice === "string" ? answer.choice : "NEW";
    const confidence = typeof answer.confidence === "number" ? answer.confidence : 0;

    if (choice === "NEW") {
      domains.push({
        original: suggestion,
        status: "new",
        canonical: slugifyDomain(suggestion),
        confidence,
        reason: ""
      });
      return;
    }

    const isSame = choice.toLowerCase() === suggestion.trim().toLowerCase();
    domains.push({
      original: suggestion,
      status: isSame ? "match" : "alias",
      canonical: choice,
      confidence,
      reason: ""
    });
  });

  let language: CanonicalLanguageResult | null = null;
  if (request.suggestedLanguage) {
    const answer = answers["language"] ?? {};
    const choice = typeof answer.choice === "string" ? answer.choice : "NEW";
    const confidence = typeof answer.confidence === "number" ? answer.confidence : 0;
    language =
      choice === "NEW"
        ? { status: "new", canonical: request.suggestedLanguage, confidence }
        : { status: "known", canonical: choice, confidence };
  }

  return { domains, language };
}

/**
 * Ask the canonicalizer.
 *
 * The service's URL is the base — the client appends the path — so the
 * configuration holds `http://10.0.2.31:11123` and not the full endpoint.
 */
export async function canonicalize(
  request: CanonicalRequest,
  timeoutMs?: number
): Promise<CanonicalResponse> {
  const config = await readAiConfig();
  const stage = config.stages.canonicalizer;

  if (!stage.enabled || !stage.url) {
    return { ok: false, reason: "disabled" };
  }

  const questions = buildQuestions(request);
  if (Object.keys(questions).length === 0) {
    return { ok: false, reason: "bad-response" };
  }

  const base = stage.url.replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? stage.timeoutMs);

  try {
    const response = await fetch(`${base}/v1/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: { text: request.content },
        questions
      }),
      signal: ctrl.signal
    });

    if (!response.ok) {
      return { ok: false, reason: `bad-response:${response.status}` };
    }

    const data = (await response.json()) as LayaRouteResponse;
    if (!data || typeof data.answers !== "object" || data.answers === null) {
      return { ok: false, reason: "bad-response" };
    }

    const { domains, language } = readAnswers(data.answers, request);

    return {
      ok: true,
      domains,
      language,
      model: data.model ?? data.routing?.model ?? "unknown"
    };
  } catch {
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
