import { describe, expect, it, vi } from 'vitest';

// The canonicalizer reads its settings from the store, which needs the
// database. The test only cares about the decisions, so the store is stubbed
// with a configuration whose canonicalizer has no URL — the "disabled" case.
vi.mock("../../plugins/ai-analysis/src/configStore.js", () => ({
  readAiConfig: vi.fn(async () => ({
    enabled: true,
    providers: [],
    stages: {
      vision: { providerId: "p", model: "", maxTokens: 2000, timeoutMs: 120000, jsonMode: true },
      audio: { providerId: "p", model: "", timeoutMs: 300000, language: null },
      embed: { providerId: "p", model: "", enabled: false, timeoutMs: 60000 },
      canonicalizer: { enabled: true, url: "", timeoutMs: 30000, verify: false }
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

import {
  canonicalizationContent,
  parseVerification,
  sameSet,
  type CanonicalizationCandidate
} from '../../plugins/ai-analysis/src/canonicalize.js';

const CANDIDATES: CanonicalizationCandidate[] = [
  {
    original: 'music/reggaeton',
    canonical: 'arts/music',
    status: 'match',
    confidence: 0.72,
    reason: 'closest existing domain'
  },
  {
    original: 'politics/france',
    canonical: 'politics/europe',
    status: 'alias',
    confidence: 0.55,
    reason: 'narrower than the existing domain'
  }
];

describe('ai-analysis canonicalization', () => {
  it('reads the AI verdict for each proposed domain', () => {
    const decisions = parseVerification(
      JSON.stringify({
        decisions: [
          {
            original: 'music/reggaeton',
            verdict: 'confirmed',
            domain: 'arts/music',
            proposeNew: false,
            reason: 'it is music'
          },
          {
            original: 'politics/france',
            verdict: 'rejected',
            domain: 'news',
            proposeNew: false,
            reason: 'it is news, not politics'
          }
        ]
      })
    );

    expect(decisions).toHaveLength(2);
    expect(decisions[0].outcome).toBe('confirmed');
    expect(decisions[1].outcome).toBe('reassigned');
    expect(decisions[1].domain).toBe('news');
  });

  it('treats a rejection without a domain as a new domain', () => {
    const decisions = parseVerification(
      JSON.stringify({
        decisions: [
          {
            original: 'cooking/fermentation',
            verdict: 'rejected',
            domain: 'cooking/fermentation',
            proposeNew: true,
            reason: 'nothing existing fits'
          }
        ]
      })
    );

    expect(decisions[0].outcome).toBe('new');
    expect(decisions[0].domain).toBe('cooking/fermentation');
  });

  it('copes with a fenced or wrapped answer', () => {
    const fenced = parseVerification(
      '```json\n{"decisions":[{"original":"a","verdict":"confirmed","domain":"a"}]}\n```'
    );
    expect(fenced).toHaveLength(1);
    expect(fenced[0].outcome).toBe('confirmed');

    // Prose around the object is tolerated.
    const embedded = parseVerification(
      'Here is the answer: {"decisions":[{"original":"b","verdict":"rejected","domain":"c","proposeNew":true}]}'
    );
    expect(embedded).toHaveLength(1);
    expect(embedded[0].outcome).toBe('new');
  });

  it('returns nothing for an answer it cannot read', () => {
    expect(parseVerification('')).toEqual([]);
    expect(parseVerification('not json at all')).toEqual([]);
    expect(parseVerification('{"decisions":"nope"}')).toEqual([]);
    // A decision without the original domain cannot be applied.
    expect(parseVerification('{"decisions":[{"verdict":"confirmed"}]}')).toEqual([]);
  });

  it('builds the content the classifier and the check see', () => {
    const content = canonicalizationContent({
      transcript: 'hello world',
      summary: 'a short summary'
    });
    expect(content).toContain('hello world');
    expect(content).toContain('a short summary');

    // A post without a transcript still has its summary.
    expect(canonicalizationContent({ transcript: null, summary: 'only this' })).toContain(
      'only this'
    );
    expect(canonicalizationContent({ transcript: null, summary: null })).toBe('');
  });

  it('compares domain lists regardless of order and case', () => {
    expect(sameSet(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameSet(['a'], ['A'])).toBe(true);
    expect(sameSet(['a'], ['a', 'b'])).toBe(false);
    expect(sameSet(['a'], ['b'])).toBe(false);
  });

  it('does not let an unreachable canonicalizer undo a decision', async () => {
    // The canonicalizer is off or unreachable: the raw suggestions come back.
    // A re-check must NOT write them over the domains the post already has,
    // or an outage would undo every canonicalization in the library.
    const { canonicalizePost } = await import(
      '../../plugins/ai-analysis/src/canonicalize.js'
    );

    const result = await canonicalizePost({
      imageId: 1,
      transcript: null,
      summary: null,
      suggestedDomains: ['music/reggaeton'],
      suggestedLanguage: 'es',
      existingDomains: [{ name: 'arts/music', videoCount: 3 }],
      existingLanguages: ['es'],
      verify: false
    });

    // The service is not configured in the test environment, so it reports
    // that it could not answer.
    expect(result.ok).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.decisions).toEqual([]);
    expect(result.error).toBeTruthy();
  });
});
