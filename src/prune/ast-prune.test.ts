import * as acorn from 'acorn';
import { describe, expect, it } from 'vitest';
import { removeUncoveredRanges } from './ranges.js';

const PARSE_OPTS: acorn.Options = {
  ecmaVersion: 'latest',
  sourceType: 'script',
  allowHashBang: true,
};

function expectValidJs(source: string): void {
  expect(() => acorn.parse(source, PARSE_OPTS)).not.toThrow();
}

describe('AST pruning', () => {
  it('stubs uncovered ternary branch with an expression, not semicolon', () => {
    const source = 'var x=a?b:c;';
    const bStart = source.indexOf('b');
    const covered = [
      { start: 0, end: bStart },
      { start: bStart + 1, end: source.length },
    ];
    const stubRanges = [{ start: bStart, end: bStart + 1 }];
    const result = removeUncoveredRanges(source, covered, { stubRanges });
    expect(result).toBe('var x=a?0:c;');
    expectValidJs(result);
  });

  it('handles minified defineProperty helper ternary', () => {
    const source =
      'var i0=(e,t,n)=>t in e?o0(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n;';
    const q = source.indexOf('?');
    const colon = source.indexOf(':');
    const covered = [
      { start: 0, end: q + 1 },
      { start: colon, end: source.length },
    ];
    const stubRanges = [{ start: q + 1, end: colon }];
    const result = removeUncoveredRanges(source, covered, { stubRanges });
    expect(result).toContain('?0:');
    expect(result).not.toMatch(/\?;/);
    expectValidJs(result);
  });

  it('handles nested typeof ternaries', () => {
    const source =
      'var vj=typeof globalThis<"u"?globalThis:typeof window<"u"?window:typeof global<"u"?global:self;';
    const windowBranch = source.indexOf('?window');
    const stubRanges = [{ start: windowBranch + 1, end: windowBranch + 7 }];
    const covered = [
      { start: 0, end: windowBranch + 1 },
      { start: windowBranch + 7, end: source.length },
    ];
    const result = removeUncoveredRanges(source, covered, { stubRanges });
    expectValidJs(result);
    expect(result).not.toMatch(/\?;/);
  });

  it('stubs uncovered else branch inside an executed function', () => {
    const source = [
      'function test(x) {',
      '  if (x) { console.log("then"); } else { console.log("else"); }',
      '}',
    ].join('\n');
    const elseStart = source.indexOf(' else {');
    const elseEnd = source.indexOf('}', elseStart) + 1;
    const fnStart = source.indexOf('function');
    const fnEnd = source.lastIndexOf('}') + 1;
    const covered = [{ start: fnStart, end: fnEnd }];
    const stubRanges = [{ start: elseStart, end: elseEnd }];
    const result = removeUncoveredRanges(source, covered, { stubRanges });
    expect(result).toContain('if (x) { console.log("then"); } else {}');
    expectValidJs(result);
  });

  it('does not leave stray colons from broken ternary stubs (minified bundle)', () => {
    const source =
      'var i0=(e,t,n)=>t in e?o0(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n;var vj=typeof globalThis<"u"?globalThis:typeof window<"u"?window:typeof global<"u"?global:typeof self<"u"?self:{};';
    const i0Consequent = source.indexOf('?o0');
    const i0Colon = source.indexOf(':', i0Consequent);
    const covered = [
      { start: 0, end: i0Consequent + 1 },
      { start: i0Colon, end: source.indexOf(';') + 1 },
    ];
    const stubRanges = [{ start: i0Consequent + 1, end: i0Colon }];
    const result = removeUncoveredRanges(source, covered, { stubRanges });
    expect(result).not.toMatch(/\?;/);
    expect(result).not.toMatch(/;\s*:/);
    expectValidJs(result);
  });

  it('still deletes functions that never ran', () => {
    const source = 'function used() { a(); }\nfunction dead() { b(); c(); }';
    const usedStart = source.indexOf('function used');
    const usedEnd = source.indexOf('}', usedStart) + 1;
    const covered = [{ start: usedStart, end: usedEnd }];
    const result = removeUncoveredRanges(source, covered);
    expect(result).toBe('function used() { a(); }');
    expectValidJs(result);
  });
});
