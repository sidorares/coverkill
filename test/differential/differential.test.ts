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
];

describe('differential: pruned script behaves identically on executed paths', () => {
  afterAll(async () => {
    await cleanupDifferential();
  });

  it.each(fixtures)('$name', async (fixture) => {
    const result = await runDifferential(fixture.source);
    // Every fixture must print evidence of its executed path.
    expect(result.original.length).toBeGreaterThan(0);
    expect(result.pruned).toEqual(result.original);
    fixture.extra?.(result);
  });
});
