/**
 * Loud stub modes (issue #6): in `throw` mode every stub throws when a pruned
 * path executes; in `beacon` mode it calls
 * `globalThis.__coverkillPrunedPathHit?.(location)` and then behaves like the
 * silent stub. These tests run the pruned output in a VM and drive it down
 * both the executed path (must behave identically) and the pruned path (must
 * announce).
 */
import * as acorn from 'acorn';
import vm from 'node:vm';
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

const THROW_MARKER = 'coverkill: pruned path executed';

describe('loud stub modes', () => {
  describe('throw mode', () => {
    it('makes a stubbed ternary branch throw with file:line, and leaves the live branch intact', () => {
      const source = 'var x=a?b:c;';
      const hole = spanOf(source, 'b');
      const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
        stubRanges: [hole],
        pruneMode: 'throw',
        stubLabel: 'app.js',
      });
      expect(result).toContain(`throw new Error("${THROW_MARKER} (app.js:1)")`);
      expectValidJs(result);

      // Live branch: identical behavior.
      const live = vm.runInNewContext(`${result}\nx`, { a: 0, c: 'ok' });
      expect(live).toBe('ok');
      // Pruned branch: announces instead of silently evaluating to 0.
      expect(() => vm.runInNewContext(result, { a: 1, c: 'ok' })).toThrowError(
        `${THROW_MARKER} (app.js:1)`,
      );
    });

    it('reports the line of the stub in the ORIGINAL source', () => {
      const source =
        'function used() { return typeof dead; }\nfunction dead() { heavy(); }\nused();';
      const hole = spanOf(source, 'function dead() { heavy(); }');
      const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
        pruneMode: 'throw',
        stubLabel: 'bundle.js',
      });
      expect(result).toContain(`(bundle.js:2)`);
      expectValidJs(result);
      // The hollowed-but-referenced function announces when finally called.
      expect(() => vm.runInNewContext(`${result}\ndead();`, {})).toThrowError(
        `${THROW_MARKER} (bundle.js:2)`,
      );
    });

    it('keeps a pruned else branch as an announcing else instead of deleting it', () => {
      const source = [
        'function test(x) {',
        '  if (x) { out.push("then"); } else { out.push("else"); }',
        '}',
        'test(1);',
      ].join('\n');
      const hole = spanOf(source, ' else { out.push("else"); }');
      const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
        stubRanges: [hole],
        pruneMode: 'throw',
        stubLabel: 'app.js',
      });
      expect(result).toMatch(/else \{ throw new Error/);
      expectValidJs(result);

      const out: string[] = [];
      vm.runInNewContext(`${result}\ntest(1);`, { out });
      expect(out).toEqual(['then', 'then']);
      expect(() => vm.runInNewContext(`${result}\ntest(0);`, { out: [] })).toThrowError(
        `${THROW_MARKER} (app.js:2)`,
      );
    });

    it('makes a stubbed then-branch announce while the else branch still runs', () => {
      const source = 'function test(x) { if (x) { foo(); } else { out.push("bar"); } }\ntest(0);';
      const hole = spanOf(source, '{ foo(); }');
      const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
        stubRanges: [hole],
        pruneMode: 'throw',
        stubLabel: 'app.js',
      });
      expectValidJs(result);
      const out: string[] = [];
      vm.runInNewContext(`${result}\ntest(0);`, { out });
      expect(out).toEqual(['bar', 'bar']);
      expect(() => vm.runInNewContext(`${result}\ntest(1);`, { out: [] })).toThrowError(
        THROW_MARKER,
      );
    });

    it('makes a stubbed switch case announce, keeping its label and live siblings', () => {
      const source = [
        'function pick(x) { switch (x) { case 1: return "one"; case 2: return "two-" + x; } }',
        'pick(1);',
      ].join('\n');
      const hole = spanOf(source, 'case 2: return "two-" + x;');
      const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
        stubRanges: [hole],
        pruneMode: 'throw',
        stubLabel: 'app.js',
      });
      expect(result).toContain('case 2:');
      expectValidJs(result);
      expect(vm.runInNewContext(`${result}\npick(1)`, {})).toBe('one');
      expect(() => vm.runInNewContext(`${result}\npick(2)`, {})).toThrowError(THROW_MARKER);
    });

    it('announces on a terminator-justified tail instead of silently deleting it', () => {
      // endsWithTerminator accepts an if where only ONE arm returns, so the
      // tail is still reachable when production takes the other arm — the
      // exact scenario loud mode exists for.
      const source = [
        'function f(x) {',
        '  if (x > 10) return "big";',
        '  log("tail:" + x);',
        '  return "small";',
        '}',
        'f(50);',
      ].join('\n');
      const hole = spanOf(source, 'log("tail:" + x);\n  return "small";');
      const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
        stubRanges: [hole],
        pruneMode: 'throw',
        stubLabel: 'app.js',
      });
      expectValidJs(result);
      expect(vm.runInNewContext(`${result}\nf(50)`, { log: () => {} })).toBe('big');
      expect(() => vm.runInNewContext(`${result}\nf(5)`, { log: () => {} })).toThrowError(
        `${THROW_MARKER} (app.js:3)`,
      );
    });

    it('announces through a dropped const initializer', () => {
      const source = [
        'function f(x) {',
        '  if (x) return 1;',
        '  const cfg = buildExpensiveConfiguration(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16);',
        '  return cfg;',
        '}',
        'f(1);',
      ].join('\n');
      const hole = spanOf(
        source,
        'const cfg = buildExpensiveConfiguration(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16);',
      );
      const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
        stubRanges: [hole],
        pruneMode: 'throw',
        stubLabel: 'app.js',
      });
      expect(result).not.toContain('buildExpensiveConfiguration');
      expect(result).toMatch(/const cfg = \(\(\) => \{ throw new Error/);
      expectValidJs(result);
      expect(() => vm.runInNewContext(`${result}\nf(0)`, {})).toThrowError(
        `${THROW_MARKER} (app.js:3)`,
      );
    });

    it('hollows a dead class expression with an announcing static block', () => {
      const source =
        'var C = flag ? class { heavyMethod() { heavyBody(1, 2, 3); } } : null;\nvar r = C;';
      const hole = spanOf(source, 'class { heavyMethod() { heavyBody(1, 2, 3); } }');
      const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
        stubRanges: [hole],
        pruneMode: 'throw',
        stubLabel: 'app.js',
      });
      expect(result).toContain('static {');
      expect(result).not.toContain('heavyBody');
      expectValidJs(result);
      expect(vm.runInNewContext(`${result}\nr`, { flag: false })).toBe(null);
      // Evaluating the pruned class definition announces immediately.
      expect(() => vm.runInNewContext(result, { flag: true })).toThrowError(THROW_MARKER);
    });
  });

  describe('beacon mode', () => {
    it('reports the location through the global and then yields the silent stub value', () => {
      const source = 'var x=a?b:c;';
      const hole = spanOf(source, 'b');
      const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
        stubRanges: [hole],
        pruneMode: 'beacon',
        stubLabel: 'app.js',
      });
      expect(result).toContain('globalThis.__coverkillPrunedPathHit?.("app.js:1")');
      expectValidJs(result);

      const hits: string[] = [];
      const sandbox = { a: 1, c: 'ok', __coverkillPrunedPathHit: (loc: string) => hits.push(loc) };
      const value = vm.runInNewContext(`${result}\nx`, sandbox);
      expect(value).toBe(0); // same value the silent stub would produce
      expect(hits).toEqual(['app.js:1']);
    });

    it('is a harmless no-op when the beacon global is not defined', () => {
      const source = 'var x=a?b:c;';
      const hole = spanOf(source, 'b');
      const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
        stubRanges: [hole],
        pruneMode: 'beacon',
        stubLabel: 'app.js',
      });
      expect(vm.runInNewContext(`${result}\nx`, { a: 1, c: 'ok' })).toBe(0);
    });

    it('beacons from a hollowed function body without breaking its return shape', () => {
      const source =
        'function used() { return typeof dead; }\nfunction dead() { heavy(); }\nused();';
      const hole = spanOf(source, 'function dead() { heavy(); }');
      const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
        pruneMode: 'beacon',
        stubLabel: 'bundle.js',
      });
      expectValidJs(result);
      const hits: string[] = [];
      const value = vm.runInNewContext(`${result}\ndead()`, {
        __coverkillPrunedPathHit: (loc: string) => hits.push(loc),
      });
      expect(value).toBeUndefined();
      expect(hits).toEqual(['bundle.js:2']);
    });
  });

  it('escapes hostile file labels when embedding them in stub code', () => {
    const source = 'var x=a?b:c;';
    const hole = spanOf(source, 'b');
    const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
      stubRanges: [hole],
      pruneMode: 'throw',
      stubLabel: 'weird ");evil()//\n\\.js',
    });
    expectValidJs(result);
    expect(() => vm.runInNewContext(result, { a: 1, c: 1 })).toThrowError(THROW_MARKER);
  });

  it('default mode stays silent', () => {
    const source = 'var x=a?b:c;';
    const hole = spanOf(source, 'b');
    const result = removeUncoveredRanges(source, coveredExcept(source, [hole]), {
      stubRanges: [hole],
    });
    expect(result).toBe('var x=a?0:c;');
  });
});
