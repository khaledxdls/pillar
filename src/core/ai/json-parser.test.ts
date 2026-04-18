import { describe, it, expect } from 'vitest';
import { parseAIJson, AIResponseParseError } from './json-parser.js';

describe('parseAIJson', () => {
  it('parses plain JSON', () => {
    expect(parseAIJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips a BOM', () => {
    expect(parseAIJson('\uFEFF{"a":1}')).toEqual({ a: 1 });
  });

  it('unwraps ```json fences', () => {
    const src = '```json\n{"a": 1}\n```';
    expect(parseAIJson(src)).toEqual({ a: 1 });
  });

  it('unwraps plain ``` fences', () => {
    const src = '```\n{"a":1}\n```';
    expect(parseAIJson(src)).toEqual({ a: 1 });
  });

  it('extracts JSON from conversational prefixes', () => {
    const src = 'Sure! Here is the plan:\n{"summary":"x","create":[],"modify":[]}';
    expect(parseAIJson(src)).toEqual({ summary: 'x', create: [], modify: [] });
  });

  it('handles trailing commas', () => {
    const src = 'Note: blah\n{"a": [1, 2, 3,], "b": 2,}';
    expect(parseAIJson(src)).toEqual({ a: [1, 2, 3], b: 2 });
  });

  it('handles braces inside strings', () => {
    const src = '{"code": "function() { return { ok: true }; }"}';
    expect(parseAIJson(src)).toEqual({ code: 'function() { return { ok: true }; }' });
  });

  it('throws AIResponseParseError with excerpt on total failure', () => {
    expect(() => parseAIJson('no json at all')).toThrow(AIResponseParseError);
    try {
      parseAIJson('not valid at all');
    } catch (err) {
      expect(err).toBeInstanceOf(AIResponseParseError);
      expect((err as AIResponseParseError).raw).toContain('not valid');
    }
  });

  it('parses top-level arrays', () => {
    const src = '```\n[1,2,3]\n```';
    expect(parseAIJson(src)).toEqual([1, 2, 3]);
  });
});
