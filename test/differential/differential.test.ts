/**
 * Differential tests: each fixture is a deterministic script whose only
 * observable behavior is console.log output. The fixture runs once as
 * written (under real V8 coverage) and once after coverkill pruning; for
 * every EXECUTED path the output must be identical.
 *
 * These tests intentionally assert against the CURRENT pruner with no
 * skips or known-failure markers: fixtures that fail here document real
 * pruner bugs (early-return body wipe, template-literal whitespace
 * corruption, switch mishandling, dead code never deleted).
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanupDifferential,
  runDifferential,
  type DifferentialResult,
} from './harness.js';

type Fixture = {
  name: string;
  source: string;
  /** Extra assertions beyond behavioral equality (e.g. dead code removal). */
  extra?: (result: DifferentialResult) => void;
  /** Fixture legitimately produces no output (e.g. entirely dead code). */
  expectEmptyOutput?: boolean;
};

// (h) Built line-by-line so trailing whitespace inside the template literal
// survives editors/formatters. The template contains trailing spaces, a
// trailing tab, and four consecutive blank lines; the unexecuted else-branch
// elsewhere guarantees the pruner actually rewrites the file.
const templateLiteralFixture = [
  'function pickPath(x) {',
  '  if (x) {',
  "    console.log('path-a');",
  '  } else {',
  "    console.log('path-b');",
  '  }',
  '}',
  'const banner = `first line   ',
  'second line\t',
  '',
  '',
  '',
  '',
  'last line`;',
  'pickPath(1);',
  'console.log(JSON.stringify(banner));',
  '',
].join('\n');

const fixtures: Fixture[] = [
  {
    name: 'a: early-return guard clause with unexecuted tail statements',
    source: `
function compute(x) {
  const r = x + 7;
  console.log('computed:' + r);
  if (x > 100) return r;
  console.log('tail-small:' + x);
  return r * 2;
}
console.log('result:' + compute(150));
`,
  },
  {
    name: 'b: if/else where only the then-branch runs',
    source: `
function branch(x) {
  if (x > 0) {
    console.log('then-branch:' + x);
  } else {
    console.log('else-branch:' + x);
  }
  return x;
}
console.log('ret:' + branch(3));
`,
  },
  {
    name: 'c: if/else where only the else-branch runs',
    source: `
function branch(x) {
  if (x > 0) {
    console.log('then-branch:' + x);
  } else {
    console.log('else-branch:' + x);
  }
  return x;
}
console.log('ret:' + branch(-3));
`,
  },
  {
    name: 'd: never-called top-level function is actually removed',
    source: `
function alive() {
  console.log('alive ran');
}
function deadHelper() {
  console.log('DEAD_HELPER_MARKER_9f3b');
}
alive();
console.log('after alive');
`,
    extra: (result) => {
      expect(result.changed).toBe(true);
      expect(result.prunedSource).not.toContain('DEAD_HELPER_MARKER_9f3b');
    },
  },
  {
    name: 'e: switch with default, one case unexercised, side-effect-free tests',
    source: `
function classify(v) {
  switch (v) {
    case 'a':
      console.log('got-a');
      break;
    case 'b':
      console.log('got-b');
      break;
    default:
      console.log('got-default:' + v);
  }
}
classify('a');
classify('z');
`,
  },
  {
    name: 'f: switch with side-effectful case tests, later case matches',
    source: `
function tag(label, value) {
  console.log('eval-case:' + label);
  return value;
}
function match(x) {
  switch (x) {
    case tag('one', 1):
      console.log('body-one');
      break;
    case tag('two', 2):
      console.log('body-two');
      break;
    case tag('three', 3):
      console.log('body-three');
      break;
  }
  console.log('match-done');
}
match(2);
`,
  },
  {
    name: 'g: hoisted var declaration after early return (strict mode)',
    source: `
"use strict";
function f(x) {
  if (x) {
    y = 1;
    console.log('y-is:' + y);
    return;
  }
  var y;
}
f(true);
console.log('after-f');
`,
  },
  {
    name: 'h: multi-line template literal with trailing spaces and blank lines',
    source: templateLiteralFixture,
  },
  {
    name: 'i: callback passed to executed higher-order function, never invoked',
    source: `
function applyMaybe(cb) {
  console.log('applyMaybe-with:' + typeof cb);
  return 42;
}
const out = applyMaybe(function neverCalled() {
  console.log('CALLBACK_BODY_MARKER');
});
console.log('out:' + out);
`,
  },
  {
    name: 'j: ternary with one branch unexecuted, result printed',
    source: `
function describeNum(n) {
  return n >= 0 ? 'non-negative:' + n : 'negative:' + n;
}
console.log(describeNum(12));
console.log('ternary-done');
`,
  },
  {
    name: 'k: nested functions - outer called, one inner dead, one inner live',
    source: `
function outer() {
  function innerDead() {
    console.log('INNER_DEAD_MARKER');
  }
  function innerLive() {
    console.log('inner-live ran');
  }
  console.log('outer ran');
  innerLive();
}
outer();
`,
  },
  {
    name: 'l: function referenced but never called, typeof printed',
    source: `
function referencedOnly() {
  console.log('REFERENCED_ONLY_BODY');
}
const holder = referencedOnly;
console.log('typeof-holder:' + typeof holder);
console.log('typeof-direct:' + typeof referencedOnly);
`,
  },
  // --- Regression fixtures from the adversarial hunt (round 1) ---
  {
    name: 'm: zero-iteration loop bodies must not swallow the next statement',
    source: `
const arr = [];
for (const x of arr) {
  console.log('never-for-of', x);
}
console.log('after-for-of');
for (let i = 0; i < 0; i++) { console.log('never-for'); }
console.log('after-for');
let n = 9;
while (n > 100) { console.log('never-while'); }
console.log('after-while:' + n);
function f() {
  for (let i = 0; i < 0; i++) { console.log('never-inner'); }
  return 42;
}
console.log('ret:' + f());
`,
  },
  {
    name: 'n: deleting a dead function must not create ASI joins',
    source: `
let a = 1
function deadAsi() { return 2 }
(function () { console.log('iife', a) })()
let b = 3
function deadAsi2() { return 4 }
[1, 2].forEach(function (v) { console.log('el', v + b) })
const t = String
function deadAsi3() { return 5 }
\`template\`;
console.log('t-type:' + typeof t)
let c = 10
function deadAsi4() { return 6 }
-1;
console.log('c:' + c)
`,
  },
  {
    name: 'o: unexercised switch case keeps its hoisted var binding',
    source: `
function f(k) {
  switch (k) {
    case 1:
      var y = 10;
      console.log('one');
      break;
    case 2:
      console.log('two');
      break;
  }
  console.log('y-is:' + y);
}
f(2);
`,
  },
  {
    name: 'p: untaken if-consequent keeps hoisted var bindings',
    source: `
function f(c) {
  if (c) {
    var x = 1;
    console.log('taken');
  }
  console.log('x-is:' + x);
}
f(false);
function g(e) {
  if (e) var t = 1;
  console.log('t-is:' + t);
}
g(false);
`,
  },
  {
    name: 'q: dead else branch with Annex-B function keeps the hoisted binding',
    source: `
if (true) {
  console.log('main');
} else {
  function helper() { return 1; }
}
console.log('helper-is:' + typeof helper);
`,
  },
  {
    name: 'r: dead tail containing for(var) keeps the hoisted loop variable',
    source: `
function f(c) {
  console.log('i-is:' + i);
  if (c) return 'early';
  for (var i = 0; i < 3; i++) {
    console.log('loop', i);
  }
  return i;
}
console.log(f(true));
`,
  },
  {
    name: 's: dead function referenced only through direct eval survives as a binding',
    source: `
function evalTarget() { return 'from-eval'; }
function unrelatedDead() { console.log('UNRELATED_DEAD'); }
console.log('eval-type:' + eval('typeof evalTarget'));
`,
  },
  {
    name: 't: continuation after await-in-ternary survives V8 misreporting',
    source: `
(async () => {
  const mode = 'fast';
  const result = mode === 'fast' ? await Promise.resolve('quick') : await Promise.resolve('slow');
  console.log(result);
})();
`,
  },
  {
    name: 'u: dead function written via destructuring assignment is not deleted',
    source: `
"use strict";
function reassigned() { console.log('REASSIGNED_ORIGINAL'); }
[reassigned] = [() => console.log('replacement ran')];
reassigned();
`,
  },
  {
    name: 'v: removing an inner else must not re-associate the outer else',
    source: `
function pick(a, b) {
  if (a)
    if (b) console.log('a-and-b');
    else console.log('a-not-b');
  else console.log('not-a');
}
pick(true, true);
pick(false, false);
`,
  },
  {
    // With correct innermost-wins semantics this file has ZERO covered bytes
    // (the dead function's count-0 root nests inside the whole-script range
    // even when the spans are byte-identical), so the no-covered-ranges
    // safety guard leaves the file untouched rather than emptying it.
    name: 'w: whole-script dead function (no trailing newline) hits the zero-covered guard',
    source: `function wholeFileDead(){ console.log('WHOLE_FILE_DEAD'); }`,
    expectEmptyOutput: true,
    extra: (result) => {
      expect(result.changed).toBe(false);
    },
  },
  {
    name: 'x: CJS script with top-level return is still prunable',
    source: `
console.log('before-return');
function deadCjsFn() { console.log('DEAD_CJS_MARKER'); }
if (typeof module === 'undefined') {
  console.log('not-cjs');
}
return console.log('top-level-return');
`,
    extra: (result) => {
      expect(result.changed).toBe(true);
      expect(result.prunedSource).not.toContain('DEAD_CJS_MARKER');
    },
  },
];

describe('differential: pruned script behaves identically on executed paths', () => {
  afterAll(async () => {
    await cleanupDifferential();
  });

  it.each(fixtures)('$name', async (fixture) => {
    const result = await runDifferential(fixture.source);
    // Every fixture must print evidence of its executed path (unless it is
    // deliberately all-dead code).
    if (!fixture.expectEmptyOutput) {
      expect(result.original.length).toBeGreaterThan(0);
    }
    expect(result.pruned).toEqual(result.original);
    fixture.extra?.(result);
  });
});
