import { describe, expect, it } from 'vitest';
import { removeUncoveredRanges } from './ranges.js';

describe('removeUncoveredRanges', () => {
  it('removes uncovered byte ranges', () => {
    const source = 'aaaaBBBBcccc';
    const covered = [{ start: 4, end: 8 }];
    expect(removeUncoveredRanges(source, covered)).toBe('BBBB');
  });

  it('preserves shebang', () => {
    const source = '#!/usr/bin/env node\nused();\nunused();\n';
    const usedStart = source.indexOf('used();');
    const usedEnd = usedStart + 'used();'.length;
    const covered = [{ start: usedStart, end: usedEnd }];
    const result = removeUncoveredRanges(source, covered);
    expect(result.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(result).toContain('used();');
    expect(result).not.toContain('unused');
  });

  it('preserves block license header when enabled', () => {
    const source = '/*! license */\nused();\nremoved();\n';
    const usedStart = source.indexOf('used();');
    const usedEnd = usedStart + 'used();'.length;
    const covered = [{ start: usedStart, end: usedEnd }];
    const result = removeUncoveredRanges(source, covered, { preserveLicenseHeader: true });
    expect(result.startsWith('/*! license */\n')).toBe(true);
    expect(result).toContain('used();');
    expect(result).not.toContain('removed');
  });

  it('returns source unchanged when nothing covered', () => {
    const source = 'hello';
    expect(removeUncoveredRanges(source, [])).toBe('hello');
  });
});
