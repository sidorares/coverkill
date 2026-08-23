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

  // Regression: escaped braces in selectors are legal (utility-class
  // frameworks emit them) and must not confuse rule-boundary scanning.
  it('handles escaped braces in selectors without corrupting neighbours', () => {
    const source = [
      '.a\\{x { color: rgb(1, 1, 1); }',
      '.mid { color: rgb(2, 2, 2); }',
      '.b\\}y { color: rgb(3, 3, 3); }',
      '.tail { color: rgb(4, 4, 4); }',
      '',
    ].join('\n');
    const mid = '.mid { color: rgb(2, 2, 2); }';
    const tail = '.tail { color: rgb(4, 4, 4); }';
    const covered = [
      { start: source.indexOf(mid), end: source.indexOf(mid) + mid.length },
      { start: source.indexOf(tail), end: source.indexOf(tail) + tail.length },
    ];
    const result = removeUncoveredRanges(source, covered, { kind: 'css' });
    expect(result).toContain(mid);
    expect(result).toContain(tail);
    // The kept tail rule must not be glued onto a dangling selector fragment.
    expect(result).not.toMatch(/\\}\s*\n\.tail/);
    expect(result).not.toContain('rgb(1, 1, 1)');
    expect(result).not.toContain('rgb(3, 3, 3)');
  });

  // Regression: @charset must be the first bytes of a sheet, so a license
  // banner can only follow it — preserveLicenseHeader must keep it there.
  it('preserves a license banner that follows @charset', () => {
    const source = [
      '@charset "utf-8";',
      '/*! Copyright ACME 2026 - MIT */',
      '.used-a { color: rgb(1, 1, 1); }',
      '.unused-b { color: rgb(2, 2, 2); }',
      '',
    ].join('\n');
    const used = '.used-a { color: rgb(1, 1, 1); }';
    const covered = [{ start: source.indexOf(used), end: source.indexOf(used) + used.length }];
    const result = removeUncoveredRanges(source, covered, {
      kind: 'css',
      preserveLicenseHeader: true,
    });
    expect(result).toContain('@charset "utf-8";');
    expect(result).toContain('/*! Copyright ACME 2026 - MIT */');
    expect(result).toContain('.used-a');
    expect(result).not.toContain('.unused-b');
    expect(result.indexOf('@charset')).toBeLessThan(result.indexOf('/*!'));
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
