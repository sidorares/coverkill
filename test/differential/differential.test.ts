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
  // --- Regression fixtures from the adversarial hunt (round 2) ---
  {
    name: 'y: deleting a dead fn after a braceless if must not ASI-join neighbours',
    source: `
function f(v) { console.log('f-called'); return v; }
f(0);
let x = 1;
if (x) x = f
function deadE3() { console.log('DEAD_E3'); }
(function () { console.log('iife-e3'); })();
console.log('x-type:' + typeof x);
let acc = 0;
for (let i = 0; i < 2; i++) acc = i
function deadE4() { console.log('DEAD_E4'); }
[4].forEach(function (v) { console.log('covered', v + acc); });
`,
  },
  {
    name: 'z: removing a dead else after a braceless consequent must not ASI-join',
    source: `
function g(v) { console.log('g-called'); return v; }
let y = 2;
if (y) y = 3
else y = g;
(function () { console.log('iife2'); })();
console.log('y:' + y);
`,
  },
  {
    name: 'aa: dead arrow with parenthesized expression body still lets the file prune',
    source: `
const make = (x) => ({ id: x });
function plainDead1() { console.log('PLAIN_DEAD_1'); }
console.log('type:' + typeof make);
`,
    extra: (result) => {
      expect(result.changed).toBe(true);
      expect(result.prunedSource).not.toContain('PLAIN_DEAD_1');
    },
  },
  {
    name: 'ab: hoist emission skips names shadowing a lexical declaration',
    source: `
'use strict';
function outer(c) {
  let g = () => 'live';
  if (c) {
    function g() { return 'shadow'; }
    console.log('inner:' + g());
  }
  console.log('outer:' + g());
}
outer(false);
function plainDead2() { console.log('PLAIN_DEAD_2'); }
console.log('done');
`,
    extra: (result) => {
      expect(result.prunedSource).not.toContain('PLAIN_DEAD_2');
    },
  },
  {
    name: 'ac: statements after a short-circuited await survive V8 misreporting',
    source: `
(async () => {
  const flag = false;
  const v = flag && (await Promise.resolve('skipped'));
  console.log('v:' + v);
  console.log('after-logical');
  const w = null ?? 'default';
  console.log('w:' + w);
})();
`,
  },
  {
    name: 'ad: do-while loop update after await-ternary is never deleted',
    source: `
(async () => {
  let i = 0;
  do {
    const r = i === 0 ? await Promise.resolve('x' + i) : 'plain-' + i;
    console.log('got:' + r);
    i += 1;
  } while (i < 2);
  console.log('after-do:' + i);
})();
`,
  },
  {
    name: 'ae: executed return after await-ternary keeps its value',
    source: `
async function pick(mode) {
  const r = mode ? await Promise.resolve('fast') : await Promise.resolve('slow');
  return r + '-done';
}
pick(true).then((v) => console.log('resolved:' + v));
`,
  },
  {
    name: 'af: zero-iteration for(let) loop containing a closure must not eat the continuation',
    source: `
const handlers = [];
for (let i = 0; i < 0; i++) {
  handlers.push(() => i);
}
console.log('handlers:' + handlers.length);
console.log('tail');
function f() {
  for (let i = 0; i < 0; i++) { const g = () => i; handlers.push(g); }
  console.log('f-ran');
  return 42;
}
console.log('ret:' + f());
`,
  },
  {
    name: 'ag: generator consumed partially keeps its executed resumption behavior',
    source: `
function* seq() {
  console.log('gen-start');
  yield 1;
  console.log('gen-middle');
  yield 2;
  console.log('gen-tail');
  yield 3;
}
const it = seq();
console.log('a:' + it.next().value);
console.log('b:' + it.next().value);
`,
  },
  {
    name: 'ah: first prune pass reaches the fixed point (no second-run shrink)',
    source: `
function used(x) { return x + 1; }
function orphan(p) { console.log('ORPHAN_BODY', p); }
function route(p) {
  if (p === 1) { console.log('one', used(p)); }
  else { orphan(p); }
}
route(1);
`,
    extra: (result) => {
      // orphan's only reference lives in the else branch removed by this same
      // pass, so the pass itself must already delete the declaration.
      expect(result.prunedSource).not.toContain('orphan');
    },
  },
  {
    name: 'ai: hoist collision in one scope must not drop hoists in other scopes',
    source: `
function outer1(c) {
  let g = 1;
  if (c) { function g() {} }
  console.log('o1:' + g);
}
function outer2(c) {
  if (c) { function g() {} }
  console.log('o2:' + g);
}
outer1(false);
outer2(false);
`,
  },
  {
    name: 'aj: validated asm.js modules are never pruned (V8 does not instrument them)',
    source: `
function AsmModule() {
  'use asm';
  function add(x, y) { x = x | 0; y = y | 0; return (x + y) | 0; }
  function deadOp(x) { x = x | 0; return (x * 2) | 0; }
  return { add: add, deadOp: deadOp };
}
const m = AsmModule();
console.log('asm:' + m.add(2, 3));
`,
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

// Loud stub modes (issue #6) must not change behavior on EXECUTED paths
// either: a deterministic replay never reaches a pruned path, so no throw
// fires and no beacon reports — the differential oracle applies unchanged.
const loudFixtures: Array<Fixture & { pruneMode: 'throw' | 'beacon' }> = [
  {
    name: 'loud-throw: dead branches and a hollowed referenced function never fire on replay',
    pruneMode: 'throw',
    source: `
function branch(x) {
  if (x > 0) {
    console.log('then:' + x);
  } else {
    console.log('else:' + x);
  }
  return x > 0 ? 'pos' : 'neg';
}
function deadHelper() { console.log('DEAD_HELPER'); }
function keep() { return typeof deadHelper; }
console.log('r:' + branch(3));
console.log('t:' + keep());
`,
    extra: (result) => {
      expect(result.prunedSource).toContain('coverkill: pruned path executed');
      expect(result.prunedSource).not.toContain('DEAD_HELPER');
    },
  },
  {
    name: 'loud-throw: switch case, guarded tail, and ternary stubs stay dormant on replay',
    pruneMode: 'throw',
    source: `
function pick(k) {
  switch (k) {
    case 'a': return 1;
    case 'b': return 2;
  }
  return 0;
}
function guard(x) {
  if (x > 100) return 'big';
  console.log('small:' + x);
  return 'small';
}
console.log('p:' + pick('a'));
console.log('g:' + guard(5));
console.log('f:' + (pick('a') === 1 ? 'yes' : 'no'));
`,
  },
  {
    name: 'loud-beacon: no beacon fires on replay even with the collector installed',
    pruneMode: 'beacon',
    source: `
globalThis.__coverkillPrunedPathHit = function (loc) { console.log('beacon:' + loc); };
globalThis.__coverkillPrunedPathHit('warmup');
function branch(x) {
  if (x > 0) {
    console.log('then:' + x);
  } else {
    console.log('else:' + x);
  }
}
branch(2);
console.log('v:' + (branch.length > 0 ? 'has-arg' : 'no-arg'));
`,
    extra: (result) => {
      expect(result.prunedSource).toContain('globalThis.__coverkillPrunedPathHit?.(');
    },
  },
  {
    name: 'loud-beacon: absent collector global makes beacons a no-op',
    pruneMode: 'beacon',
    source: `
function branch(x) {
  if (x > 0) {
    console.log('then:' + x);
  } else {
    console.log('else:' + x);
  }
}
branch(2);
`,
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

  it.each(loudFixtures)('$name', async (fixture) => {
    const result = await runDifferential(fixture.source, { pruneMode: fixture.pruneMode });
    expect(result.original.length).toBeGreaterThan(0);
    expect(result.changed).toBe(true);
    expect(result.pruned).toEqual(result.original);
    fixture.extra?.(result);
  });
});
