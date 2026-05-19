import { describe, expect, it } from 'vitest';
import { removeUncoveredRanges, stubReplacement } from './ranges.js';

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

  it('stubs uncovered else branch inside an executed function (nested V8 ranges)', () => {
    const source = [
      'function test(x) {',
      '  if (x) { console.log("then"); } else { console.log("else"); }',
      '}',
    ].join('\n');
    const elseStart = source.indexOf(' else {');
    const elseEnd = source.lastIndexOf('}') + 1;
    const fnStart = source.indexOf('function');
    const fnEnd = source.lastIndexOf('}') + 1;
    // Parent block is "covered" but the else branch has count 0 in V8.
    const covered = [{ start: fnStart, end: fnEnd }];
    const stubRanges = [{ start: elseStart, end: elseEnd }];
    const result = removeUncoveredRanges(source, covered, { stubRanges });
    expect(result).toContain('if (x) { console.log("then"); } else {}');
    expect(result).not.toContain('"else"');
  });

  it('stubs uncovered then block when else ran', () => {
    const source = 'function test(x) { if (x) { foo(); } else { bar(); } }';
    const thenStart = source.indexOf('{ foo');
    const thenEnd = source.indexOf('}', thenStart) + 1;
    const fnStart = source.indexOf('function');
    const fnEnd = source.length;
    const covered = [{ start: fnStart, end: fnEnd }];
    const stubRanges = [{ start: thenStart, end: thenEnd }];
    const result = removeUncoveredRanges(source, covered, { stubRanges });
    expect(result).toBe('function test(x) { if (x) {} else { bar(); } }');
  });

  it('still deletes code in functions that never ran', () => {
    const source = 'function used() { a(); }\nfunction dead() { b(); c(); }';
    const usedStart = source.indexOf('function used');
    const usedEnd = source.indexOf('}', usedStart) + 1;
    const covered = [{ start: usedStart, end: usedEnd }];
    const result = removeUncoveredRanges(source, covered);
    expect(result).toBe('function used() { a(); }');
  });
});

describe('stubReplacement', () => {
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
