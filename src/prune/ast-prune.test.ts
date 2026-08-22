import * as acorn from 'acorn';
import { describe, expect, it } from 'vitest';
import { removeUncoveredRanges } from './ranges.js';
import type { ByteRange } from '../report/types.js';

function expectValidJs(source: string): void {
  expect(() => {
    try {
      acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
    } catch {
      acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
    }
  }).not.toThrow();
}

/** covered = everything except the given uncovered spans (new-extract contract). */
function coveredExcept(source: string, uncovered: ByteRange[]): ByteRange[] {
  const sorted = [...uncovered].sort((a, b) => a.start - b.start);
  const covered: ByteRange[] = [];
  let pos = 0;
  for (const range of sorted) {
    if (range.start > pos) covered.push({ start: pos, end: range.start });
    pos = range.end;
  }
  if (pos < source.length) covered.push({ start: pos, end: source.length });
  return covered;
}

function spanOf(source: string, text: string): ByteRange {
  const start = source.indexOf(text);
  if (start === -1) throw new Error(`fixture text not found: ${text}`);
  return { start, end: start + text.length };
}

describe('AST pruning', () => {
  it('stubs an uncovered ternary branch with an expression, not a semicolon', () => {
    const source = 'var x=a?b:c;';
    const hole = spanOf(source, 'b');
    const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
      stubRanges: [hole],
    });
    expect(result).toBe('var x=a?0:c;');
    expectValidJs(result);
  });

  it('handles minified defineProperty helper ternary', () => {
    const source =
      'var i0=(e,t,n)=>t in e?o0(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n;';
    const q = source.indexOf('?');
    const colon = source.indexOf('):') + 1;
    const hole = { start: q + 1, end: colon };
    const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
      stubRanges: [hole],
    });
    expect(result).toContain('?0:');
    expect(result).not.toMatch(/\?;/);
    expectValidJs(result);
  });

  it('handles nested typeof ternaries', () => {
    const source =
      'var vj=typeof globalThis<"u"?globalThis:typeof window<"u"?window:typeof global<"u"?global:self;';
    const windowBranch = source.indexOf('?window');
    const hole = { start: windowBranch + 1, end: windowBranch + 7 };
    const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
      stubRanges: [hole],
    });
    expectValidJs(result);
    expect(result).not.toMatch(/\?;/);
  });

  it('removes an uncovered else branch entirely (V8 range includes the else keyword)', () => {
    const source = [
      'function test(x) {',
      '  if (x) { console.log("then"); } else { console.log("else"); }',
      '}',
      'test(1);',
    ].join('\n');
    const hole = spanOf(source, ' else { console.log("else"); }');
    const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
      stubRanges: [hole],
    });
    expect(result).toContain('if (x) { console.log("then"); }');
    expect(result).not.toContain('"else"');
    expectValidJs(result);
  });

  it('stubs an uncovered then-block when the else branch ran', () => {
    const source = 'function test(x) { if (x) { foo(); } else { bar(); } }\ntest(0);';
    const hole = spanOf(source, '{ foo(); }');
    const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
      stubRanges: [hole],
    });
    expect(result).toContain('if (x) {} else { bar(); }');
    expectValidJs(result);
  });

  it('deletes functions that never ran', () => {
    const source = 'function used() { a(); }\nfunction dead() { b(); c(); }\nused();';
    const hole = spanOf(source, 'function dead() { b(); c(); }');
    const result = removeUncoveredRanges(source, coveredExcept(source, [hole]));
    expect(result).not.toContain('dead');
    expect(result).toContain('function used() { a(); }');
    expectValidJs(result);
  });

  it('hollows instead of deleting a dead function that covered code references', () => {
    const source =
      'function used() { return typeof dead; }\nfunction dead() { heavy(); }\nused();';
    const hole = spanOf(source, 'function dead() { heavy(); }');
    const result = removeUncoveredRanges(source, coveredExcept(source, [hole]));
    expect(result).toContain('function dead() {}');
    expect(result).not.toContain('heavy');
    expectValidJs(result);
  });

  // Regression: a count-0 tail after an always-taken early return must delete
  // only the tail statements, never the covered statements before them.
  it('early-return tail: deletes only the unexecuted tail statements', () => {
    const source = [
      'function early(x) {',
      '  var r = x + 1;',
      '  if (x > 100) return r;',
      '  log(r);',
      '  log(r + 1);',
      '  return r;',
      '}',
      'early(200);',
    ].join('\n');
    const hole = spanOf(source, '  log(r);\n  log(r + 1);\n  return r;');
    const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
      stubRanges: [hole],
    });
    expect(result).toContain('var r = x + 1;');
    expect(result).toContain('if (x > 100) return r;');
    expect(result).not.toContain('log(r)');
    expectValidJs(result);
  });

  // Regression: ESM sources must be prunable (sourceType module fallback).
  it('prunes ESM sources with import/export', () => {
    const source = [
      "import { a } from './a.js';",
      'export function used() { return a; }',
      'function dead() { gone(); }',
      'used();',
    ].join('\n');
    const hole = spanOf(source, 'function dead() { gone(); }');
    const result = removeUncoveredRanges(source, coveredExcept(source, [hole]));
    expect(result).toContain("import { a } from './a.js';");
    expect(result).toContain('export function used()');
    expect(result).not.toContain('gone');
    expectValidJs(result);
  });

  // Regression: whitespace cleanup must not rewrite template-literal contents.
  it('preserves template literal contents (blank lines, trailing spaces)', () => {
    const template = '`line1   \n\n\n\nline2`';
    const source = `const s = ${template};\nfunction used() { return s; }\nfunction dead() { x(); }\nused();`;
    const hole = spanOf(source, 'function dead() { x(); }');
    const result = removeUncoveredRanges(source, coveredExcept(source, [hole]));
    expect(result).toContain(template);
    expect(result).not.toContain('x()');
    expectValidJs(result);
  });

  // Regression: uncovered switch cases keep their labels; no duplicate default,
  // and the covered case must survive.
  it('stubs uncovered switch cases without touching covered ones', () => {
    const source =
      'function f(k){switch(k){case 1:one();break;case 2:two();break;case 3:three();break;}}\nf(1);';
    const hole = spanOf(source, 'case 2:two();break;case 3:three();break;');
    const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
      stubRanges: [hole],
    });
    expect(result).toContain('case 1:one();break;');
    expect(result).toContain('case 2: break;');
    expect(result).toContain('case 3: break;');
    expect(result).not.toContain('default');
    expectValidJs(result);
  });

  it('handles an uncovered case in a switch that already has a default', () => {
    const source =
      'function f(k){switch(k){case 1:one();break;case 2:two();break;default:def();}}\nf(1);';
    const hole = spanOf(source, 'case 2:two();break;');
    const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
      stubRanges: [hole],
    });
    expect(result).toContain('case 1:one();break;');
    expect(result).toContain('default:def();');
    expect(result).toContain('case 2: break;');
    expectValidJs(result);
  });

  // Regression: an unexecuted callback spanning an op exactly must be hollowed
  // in place, never bubble up to replace the covered enclosing call.
  it('hollows an unexecuted callback without deleting the enclosing call', () => {
    const source = 'function f(){ return run(async () => { await step(); }); }\nf();';
    const hole = spanOf(source, 'async () => { await step(); }');
    const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
      stubRanges: [hole],
    });
    expect(result).toContain('return run(');
    expect(result).toContain('async () => {}');
    expect(result).not.toContain('step');
    expectValidJs(result);
  });

  // Regression: hoisted var bindings survive statement removal.
  it('keeps hoisted var bindings when their declaration statement is pruned', () => {
    const source =
      '"use strict"; function f(x){ if(x){ y = 1; return y; } var y = init(); }\nf(1);';
    const hole = spanOf(source, 'var y = init();');
    const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
      stubRanges: [hole],
    });
    expect(result).toContain('var y;');
    expect(result).not.toContain('init()');
    expectValidJs(result);
  });

  it('never prunes inside catch blocks', () => {
    const source = [
      'function f() {',
      '  try { work(); } catch (err) { report(err); }',
      '}',
      'f();',
    ].join('\n');
    const hole = spanOf(source, '{ report(err); }');
    const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
      stubRanges: [hole],
    });
    expect(result).toContain('report(err)');
    expectValidJs(result);
  });

  it('does not leave stray colons from broken ternary stubs (minified bundle)', () => {
    const source =
      'var i0=(e,t,n)=>t in e?o0(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n;var vj=typeof globalThis<"u"?globalThis:typeof window<"u"?window:typeof global<"u"?global:typeof self<"u"?self:{};';
    const i0Consequent = source.indexOf('?o0');
    const i0Colon = source.indexOf(':', i0Consequent);
    const hole = { start: i0Consequent + 1, end: i0Colon };
    const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
      stubRanges: [hole],
    });
    expect(result).not.toMatch(/\?;/);
    expect(result).not.toMatch(/;\s*:/);
    expectValidJs(result);
  });

  it('leaves comment-separated else branches intact when deletion is ambiguous', () => {
    const source = 'function f(x){if(x){a();}else /* note */ {b();}}\nf(1);';
    const hole = spanOf(source, 'else /* note */ {b();}');
    const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
      stubRanges: [hole],
    });
    expect(result).not.toContain('b()');
    expectValidJs(result);
  });
});
