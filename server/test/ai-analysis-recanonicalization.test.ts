import { describe, expect, it, vi } from 'vitest';

/**
 * The re-check sweep must not overrule a decision with an unverified one.
 *
 * laya is a similarity match: it can put a post into a domain that is merely
 * the closest one it was offered. The AI check catches that. When the check
 * cannot run — no balance, the service is down — the sweep has to leave the
 * post alone rather than file it on an unchecked answer.
 */

const canonicalizeMock = vi.fn();
const chatMock = vi.fn();

vi.mock("../../plugins/ai-analysis/src/lib/laya-client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../plugins/ai-analysis/src/lib/laya-client.js")
  >("../../plugins/ai-analysis/src/lib/laya-client.js");
  return { ...actual, canonicalize: (...args: unknown[]) => canonicalizeMock(...args) };
});

vi.mock("../../plugins/ai-analysis/src/lib/litellm-client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../plugins/ai-analysis/src/lib/litellm-client.js")
  >("../../plugins/ai-analysis/src/lib/litellm-client.js");
  return { ...actual, chat: (...args: unknown[]) => chatMock(...args) };
});

vi.mock("../../plugins/ai-analysis/src/configStore.js", () => ({
  readAiConfig: vi.fn(async () => ({
    enabled: true,
    providers: [],
    stages: {
      vision: { providerId: "p", model: "", maxTokens: 2000, timeoutMs: 120000, jsonMode: true },
      audio: { providerId: "p", model: "", timeoutMs: 300000, language: null },
      embed: { providerId: "p", model: "", enabled: false, timeoutMs: 60000 },
      canonicalizer: { enabled: true, url: "http://laya:11123", timeoutMs: 30000, verify: true }
    },
    pipeline: {
      frameCount: 3,
      framePositions: [0.1, 0.5, 0.95],
      extractAudio: true,
      writeCaption: true,
      updateKnowledgeGraph: true,
      minDurationSeconds: 0,
      maxDurationSeconds: 0
    },
    usageLimits: { enabled: false, budget: 0, hourly: 0, daily: 0, weekly: 0, monthly: 0 }
  })),
  cachedAiConfig: vi.fn(() => null),
  setCachedAiConfig: vi.fn(),
  writeAiConfig: vi.fn(),
  saveAiConfigPatch: vi.fn(),
  toConfigView: vi.fn(),
  maskApiKey: vi.fn(() => "")
}));

const applyCanonicalizationMock = vi.fn(async () => {});
const registerNewDomainMock = vi.fn(async () => {});
const touchExistingDomainMock = vi.fn(async () => {});
const recordPendingSynonymMock = vi.fn(async () => {});

vi.mock("../../plugins/ai-analysis/src/storage.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../plugins/ai-analysis/src/storage.js")
  >("../../plugins/ai-analysis/src/storage.js");
  return {
    ...actual,
    applyCanonicalization: (...args: unknown[]) => applyCanonicalizationMock(...args),
    registerNewDomain: (...args: unknown[]) => registerNewDomainMock(...args),
    touchExistingDomain: (...args: unknown[]) => touchExistingDomainMock(...args),
    recordPendingSynonym: (...args: unknown[]) => recordPendingSynonymMock(...args),
    countDomains: vi.fn(async () => 7),
    getExistingDomainsForCanonicalization: vi.fn(async () => [
      { name: "arts/music", videoCount: 3 }
    ]),
    getExistingLanguagesForCanonicalization: vi.fn(async () => ["en", "es"]),
    findPostsNeedingRecanonicalization: vi.fn(async () => [
      {
        imageId: 42,
        summary: "un concierto de reggae",
        transcript: "reggae en español",
        language: "es",
        analyzedAt: "2026-01-01T00:00:00.000Z",
        // The post was filed under "news" — the domain laya picked.
        currentDomains: ["news"],
        suggestedDomains: ["music/reggaeton"]
      }
    ])
  };
});

describe('re-check sweep', () => {
  it('leaves a post alone when the AI check cannot run', async () => {
    // laya answers — with the wrong domain, which is the whole point of the
    // check — and the check itself fails.
    canonicalizeMock.mockResolvedValue({
      ok: true,
      model: "english",
      language: { status: "known", canonical: "es", confidence: 0.9 },
      domains: [
        {
          original: "music/reggaeton",
          status: "alias",
          canonical: "news",
          confidence: 0.7,
          reason: ""
        }
      ]
    });
    chatMock.mockRejectedValue(new Error("insufficient balance"));
    applyCanonicalizationMock.mockClear();

    const { runRecanonicalizationSweep } = await import(
      "../../plugins/ai-analysis/src/canonicalize.js"
    );
    const state = await runRecanonicalizationSweep(10, true);

    // The post was looked at, but not moved: an unverified answer is not
    // allowed to overrule a decision that was already made.
    expect(state.checked).toBe(1);
    expect(state.moved).toBe(0);
    expect(state.skipped).toBe(1);
    expect(applyCanonicalizationMock).not.toHaveBeenCalled();
  });

  it('moves a post when the AI check confirms the better domain', async () => {
    canonicalizeMock.mockResolvedValue({
      ok: true,
      model: "english",
      language: { status: "known", canonical: "es", confidence: 0.9 },
      domains: [
        {
          original: "music/reggaeton",
          status: "alias",
          canonical: "news",
          confidence: 0.7,
          reason: ""
        }
      ]
    });
    // The AI rejects laya's answer and names a better domain.
    chatMock.mockResolvedValue({
      content: JSON.stringify({
        decisions: [
          {
            original: "music/reggaeton",
            verdict: "rejected",
            domain: "arts/music",
            proposeNew: false,
            reason: "it is a music video"
          }
        ]
      }),
      model: "local",
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });
    applyCanonicalizationMock.mockClear();

    const { runRecanonicalizationSweep } = await import(
      "../../plugins/ai-analysis/src/canonicalize.js"
    );
    const state = await runRecanonicalizationSweep(10, true);

    expect(state.checked).toBe(1);
    expect(state.moved).toBe(1);
    expect(state.skipped).toBe(0);
    expect(applyCanonicalizationMock).toHaveBeenCalledTimes(1);
    // The post is filed under the domain the AI chose.
    const [, domains] = applyCanonicalizationMock.mock.calls[0] as [
      number,
      string[],
      string | null,
      string
    ];
    expect(domains).toEqual(["arts/music"]);
  });
});
