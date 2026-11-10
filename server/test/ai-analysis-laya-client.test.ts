import { describe, expect, it, vi } from 'vitest';

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

import {
  buildDomainQuestion,
  buildLanguageQuestion,
  buildQuestions,
  readAnswers,
  slugifyDomain
} from '../../plugins/ai-analysis/src/lib/laya-client.js';

const REQUEST = {
  content: 'hola, reggae en español',
  suggestedDomains: ['music/reggaeton', 'politics/france'],
  suggestedLanguage: 'es',
  existingDomains: [
    { name: 'arts/music', videoCount: 120 },
    { name: 'news', videoCount: 80 }
  ],
  existingLanguages: ['en', 'es']
};

describe('laya client', () => {
  it('asks about every proposed domain and about the language', () => {
    const questions = buildQuestions(REQUEST);
    expect(Object.keys(questions)).toEqual(['domain_0', 'domain_1', 'language']);
    expect(questions.domain_0.instructions).toContain('music/reggaeton');
    // The existing domains are the options, and NEW is always one of them.
    expect(Object.keys(questions.domain_0.criteria)).toEqual([
      'arts/music',
      'news',
      'NEW'
    ]);
    expect(Object.keys(questions.language.criteria)).toEqual(['en', 'es', 'NEW']);
  });

  it('leaves the language out when there is none', () => {
    const questions = buildQuestions({ ...REQUEST, suggestedLanguage: null });
    expect(Object.keys(questions)).toEqual(['domain_0', 'domain_1']);
  });

  it('reads a match, an alias and a new domain', () => {
    const { domains } = readAnswers(
      {
        domain_0: { choice: 'arts/music', confidence: 0.9 },
        domain_1: { choice: 'NEW', confidence: 0.2 }
      },
      REQUEST
    );

    // A different existing domain than the suggestion is an alias.
    expect(domains[0].status).toBe('alias');
    expect(domains[0].canonical).toBe('arts/music');
    expect(domains[0].confidence).toBe(0.9);

    // NEW means the suggestion becomes a domain of its own.
    expect(domains[1].status).toBe('new');
    expect(domains[1].canonical).toBe('politics/france');
  });

  it('calls a domain a match when the name is unchanged', () => {
    const { domains } = readAnswers(
      { domain_0: { choice: 'music/reggaeton', confidence: 0.8 } },
      { ...REQUEST, suggestedDomains: ['music/reggaeton'] }
    );
    expect(domains[0].status).toBe('match');
  });

  it('reads the language', () => {
    const known = readAnswers({ language: { choice: 'es', confidence: 0.95 } }, REQUEST);
    expect(known.language).toEqual({ status: 'known', canonical: 'es', confidence: 0.95 });

    const fresh = readAnswers({ language: { choice: 'NEW', confidence: 0.4 } }, REQUEST);
    expect(fresh.language).toEqual({
      status: 'new',
      canonical: 'es',
      confidence: 0.4
    });
  });

  it('treats a missing answer as NEW', () => {
    const { domains } = readAnswers({}, REQUEST);
    expect(domains.every((entry) => entry.status === 'new')).toBe(true);
  });

  it('slugs a domain laya did not recognise', () => {
    expect(slugifyDomain('Music Reggaeton')).toBe('music-reggaeton');
    expect(slugifyDomain('music/reggaeton')).toBe('music/reggaeton');
    expect(slugifyDomain('   ')).toBe('misc/unknown');
  });

  it('posts the questions to the service and reads the answers', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'english',
        answers: {
          domain_0: { choice: 'arts/music', confidence: 0.77 },
          domain_1: { choice: 'NEW', confidence: 0.11 },
          language: { choice: 'es', confidence: 0.99 }
        },
        routing: { model: 'english', reason: 'Latin-script / default', script: 'latin' }
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { canonicalize } = await import(
      '../../plugins/ai-analysis/src/lib/laya-client.js'
    );
    const result = await canonicalize(REQUEST, 30_000);

    // The service is asked on the routing endpoint, so it can pick the
    // checkpoint from the script of the content.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://laya:11123/v1/route');
    const body = JSON.parse(String(init.body)) as {
      state: { text: string };
      questions: Record<string, unknown>;
    };
    expect(body.state.text).toBe(REQUEST.content);
    expect(Object.keys(body.questions)).toContain('domain_0');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.domains[0].canonical).toBe('arts/music');
      expect(result.language?.canonical).toBe('es');
      expect(result.model).toBe('english');
    }

    vi.unstubAllGlobals();
  });

  it('reports an unreachable service instead of throwing', async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }));

    const { canonicalize } = await import(
      '../../plugins/ai-analysis/src/lib/laya-client.js'
    );
    const result = await canonicalize(REQUEST, 30_000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unreachable');

    vi.unstubAllGlobals();
  });
});
