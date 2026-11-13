import { describe, expect, it } from 'vitest';

import { parseJsonLenient } from '../../plugins/ai-analysis/src/analyzer.js';

interface Answer {
  summary: string;
  summary_es: string;
  domains: string[];
  tags: string[];
  language: string;
  sentiment: string;
}

describe('the answer of the model', () => {
  it('reads plain JSON', () => {
    const answer = parseJsonLenient<Answer>(
      '{"summary":"a","summary_es":"b","domains":["x"],"tags":["t"],"language":"es","sentiment":"neutral"}'
    );
    expect(answer?.summary).toBe('a');
    expect(answer?.domains).toEqual(['x']);
  });

  it('reads JSON inside a code fence', () => {
    const answer = parseJsonLenient<Answer>(
      '```json\n{"summary":"a","domains":[],"tags":[]}\n```'
    );
    expect(answer?.summary).toBe('a');
  });

  it('reads JSON with something around it', () => {
    const answer = parseJsonLenient<Answer>(
      'Here is the JSON you asked for:\n{"summary":"a","domains":[],"tags":[]}\nHope it helps.'
    );
    expect(answer?.summary).toBe('a');
  });

  it('keeps what there is when the answer was cut off', () => {
    // The model hit the output limit in the middle of a sentence: the
    // summary and the domains arrived, the rest did not.
    const answer = parseJsonLenient<Answer>(
      '{"summary":"a Family Guy scene satirizes patriotism","summary_es":"Una escena de ' +
      'Family Guy satiriza el patriotismo, la'
    );
    expect(answer?.summary).toBe('a Family Guy scene satirizes patriotism');
    expect(answer?.summary_es).toBe('Una escena de Family Guy satiriza el patriotismo, la');
  });

  it('keeps the values that arrived before the cut', () => {
    const answer = parseJsonLenient<Answer>(
      '{"summary":"a","domains":["music","comedy"],"tags":["x"],"language":"es","sentiment":"neutral","transcript":"the model kept thinking and'
    );
    expect(answer?.summary).toBe('a');
    expect(answer?.domains).toEqual(['music', 'comedy']);
    expect(answer?.language).toBe('es');
  });

  it('gives up when there is nothing to read', () => {
    expect(parseJsonLenient<Answer>('')).toBeNull();
    expect(parseJsonLenient<Answer>('no json here')).toBeNull();
  });
});
