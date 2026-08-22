import { describe, expect, it } from 'vitest';
import { extractJsCoverage } from './collect.js';

describe('extractJsCoverage', () => {
  it('collects covered ranges and stubs zero-count blocks in executed functions', () => {
    const entry = {
      url: '',
      scriptId: '1',
      source: 'function test(x) { if (x) { a(); } else { b(); } }',
      functions: [
        {
          functionName: 'test',
          isBlockCoverage: true,
          ranges: [
            { startOffset: 0, endOffset: 50, count: 1 },
            { startOffset: 30, endOffset: 48, count: 0 },
          ],
        },
      ],
    };

    const { covered, stub } = extractJsCoverage(entry);
    expect(covered).toEqual([{ start: 0, end: 50 }]);
    expect(stub).toEqual([{ start: 30, end: 48 }]);
  });

  it('does not stub ranges in functions that never ran', () => {
    const entry = {
      url: '',
      scriptId: '1',
      source: 'function dead() { a(); }',
      functions: [
        {
          functionName: 'dead',
          isBlockCoverage: true,
          ranges: [{ startOffset: 0, endOffset: 20, count: 0 }],
        },
      ],
    };

    const { covered, stub } = extractJsCoverage(entry);
    expect(covered).toEqual([]);
    expect(stub).toEqual([]);
  });
});
