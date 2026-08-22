import { describe, expect, it } from 'vitest';
import { removeUncoveredRanges, stubReplacement } from './ranges.js';

describe('removeUncoveredRanges', () => {
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

  it('still deletes code in functions that never ran', () => {
    const source = 'function used() { a(); }\nfunction dead() { b(); c(); }\nused();';
    const deadStart = source.indexOf('function dead');
    const deadEnd = source.indexOf('c(); }') + 'c(); }'.length;
    const covered = [
      { start: 0, end: deadStart },
      { start: deadEnd, end: source.length },
    ];
    const result = removeUncoveredRanges(source, covered);
    expect(result).toContain('function used() { a(); }');
    expect(result).not.toContain('dead');
  });
});

describe('CSS pruning', () => {
  it('keeps used rules and drops unused rules', () => {
    const source = '.used { color: red; }\n.unused { color: blue; }\n';
    const usedRule = '.used { color: red; }';
    const covered = [{ start: source.indexOf(usedRule), end: usedRule.length }];
    const result = removeUncoveredRanges(source, covered, { kind: 'css' });
    expect(result).toContain('.used');
    expect(result).not.toContain('.unused');
  });
});

describe('stubReplacement (legacy byte path)', () => {
  it('replaces else clauses with else {}', () => {
    const source = 'if (a) {} else { work(); }';
    const start = source.indexOf(' else');
    const end = source.length;
    expect(stubReplacement(source, start, end)).toBe(' else {}');
  });

  it('replaces blocks with {}', () => {
    const source = '{ console.log(1); }';
    expect(stubReplacement(source, 0, source.length)).toBe('{}');
  });
});
