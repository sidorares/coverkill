# AGENTS.md

Orientation for agents and new contributors working on coverkill. Read this
before changing anything under `src/prune/` or `src/collect/` — most of what
follows was learned by breaking it.

## What the library does

coverkill removes unused JavaScript and CSS from files on disk based on what a
real browser actually executed. You drive your app through Playwright scenarios,
coverkill records V8 block coverage and Chrome CSS rule usage, and then rewrites
the covered files: code that never ran is deleted, branches that never ran
inside live functions are stubbed.

The niche it fills: **code that is statically reachable but dynamically dead.**
A tree-shaker cannot remove a function that is genuinely referenced, and
PurgeCSS cannot see a class added by a `setTimeout` callback. Runtime evidence
can. That is the entire reason this tool exists — if static analysis can already
remove it, coverkill is the wrong tool.

### The premise, and its boundary

Anything your scenarios do not exercise is indistinguishable from dead code:
error paths, other locales and viewports, feature-flagged branches, `:hover`
styles nobody hovered, polyfill branches for browsers you did not test. Deleting
those is **not a bug** — it is the premise, and it is the user's responsibility
to cover what matters (or use `cssSafelist`, `--dry-run`, and version control).

Where the tool owes absolute correctness is the other side of that line:

> **Under-pruning is always acceptable. Changing observable behavior on a path
> that executed during collection is never acceptable.**

That single sentence is the design rule. When a change forces a trade-off
between removing more bytes and preserving executed behavior, executed behavior
wins, every time. "Leave the file unchanged" is always a valid answer.

### Non-goals (today)

Not a bundler, not a static analyzer, no source-map support yet (so it prunes
whatever the browser loaded — usually built assets, not `src/`), Chromium-only,
and single-page — see the blind spots below.

## Architecture

Three directories, with a serialized report as the seam between the two halves:

```
scenarios ──► src/collect/ ──► CoverageReport (JSON) ──► src/prune/ ──► files on disk
              needs Playwright     src/report/            pure transform, acorn only
                                        ▲
        any V8 coverage ────────────────┘
   (NODE_V8_COVERAGE, CDP, Playwright, DevTools export) via src/report/import.ts
```

The seam is load-bearing, not cosmetic: `collect` in CI, review the report,
prune later — and library consumers who only prune never resolve Playwright.

**The report carries raw V8 counts (v2), not a classification.** Whether a byte
is covered, stub, or dead is decided in `src/report/v8.ts` at PRUNE time, so a
report collected months ago can be re-pruned under a different policy, and any
V8 coverage — whoever collected it — is prunable. Report v1 (pre-classified byte
ranges) is still read; `normalizeReport` collapses both versions into the same
`FileCoverageEntry[]` the resolver consumes.

| Path | Role |
|---|---|
| `src/collect/browser.ts` | Orchestrates a run: web server, Chromium, coverage session lifecycle. **This is where CSS coverage is cycled per scenario** — see the navigation fact below. |
| `src/collect/extract.ts` | V8 `ScriptCoverage` → report v2 (`buildCoverageReportV2`). Pure; no Playwright at runtime. `buildCoverageReport` still emits v1 for consumers pinned to it. |
| `src/collect/scenarios.ts` | Scenario discovery + loading (jiti, so `.ts` scenarios work). |
| `src/collect/webServer.ts` | Playwright-style dev-server management. |
| `src/report/types.ts` | `CoverageReportV1`/`V2`, `ScriptCoverageEntry`, `FileCoverageEntry`, `ByteRange`. The contract. |
| `src/report/v8.ts` | `extractJsCoverage`: innermost-range-wins flattening of raw V8 counts into covered/stub. Prune-time policy. |
| `src/report/normalize.ts` | Either report version → the internal `FileCoverageEntry[]` model. |
| `src/report/import.ts` | Raw `NODE_V8_COVERAGE` / CDP / Playwright / DevTools JSON → report v2, hashing `file://` sources from disk (only when the file still fits the coverage offsets). |
| `src/report/hash.ts` | `sha256-` hashing of executed text; the guard when a report omits `source`. |
| `src/report/merge.ts` | Range algebra: merge / subtract / invert / range→lines. |
| `src/report/merge-reports.ts` | `coverkill merge`: cross-run union. Deliberately just concatenation — classification and covered-wins live at prune time in the resolver — plus loud failures for cross-run source mismatches (different builds) and v1 inputs. |
| `src/report/io.ts` | `saveReport` / `loadReport` (auto-detects raw V8 input) + structural validation of untrusted JSON. |
| `src/prune/resolve.ts` | URL → disk path, `include`/`exclude`, and the safety guards that decide a file is unprunable. |
| `src/prune/ast-prune.ts` | **The JS planner.** The most delicate file in the repo. |
| `src/prune/css.ts` | Structural CSS pruner (hand-rolled scanner, no dependency). |
| `src/prune/ranges.ts` | Entry point that dispatches JS vs CSS, plus the legacy byte-slicing path behind `COVERKILL_BYTE_PRUNE=1`. |
| `src/prune/prune.ts` | Per-file orchestration, validation gate, atomic writes, result formatting. |
| `src/config/` | One config file feeding both halves; zod schema, jiti-backed loading. |
| `test/differential/` | The behavioral oracle. See below. |

Entry points: `src/index.ts` (root export, composes both halves), `src/cli.ts`,
plus the `coverkill/collect` and `coverkill/prune` subpath exports.

## Invariants — do not break these

Each of these exists because it was violated and shipped broken code. They are
pinned by tests; if a change makes one of these tests fail, the change is wrong,
not the test.

1. **An edit may only replace bytes inside an uncovered range.** The whole
   planner is built on this. Never "climb" from a multi-statement uncovered
   region to an enclosing node and replace that — it deletes covered code, and
   the output still parses so validation cannot catch it.
2. **Covered-wins.** A byte that executed anywhere is covered, always. Merging
   entries must union coverage, never let a count-0 range subtract from it.
3. **Statement deletion is terminator-gated.** A non-function statement is only
   deletable when the previous kept sibling provably ends control flow
   (`return`/`throw`/`break`/`continue`) and contains no `await`/`yield`. This
   defends against a family of V8 misreports (below) — do not weaken it into
   per-shape special cases.
4. **Never prune inside `catch`.** A stubbed catch turns error reporting into
   silent swallowing, which is strictly worse than the unpruned code.
5. **Every removal shape preserves hoisted bindings.** `var` and Annex-B block
   function declarations hoist out of removed subtrees; covered code may read
   them. Applies to if-branches, loop bodies, switch cases, else removal, and
   whole-statement deletion alike.
6. **Deletion is ASI-safe.** Removing a statement between semicolon-less lines
   can glue neighbours into one expression (`let a = 1` + `(iife)()` becomes a
   call). Check the previous sibling's final token, not its node type.
7. **Exported declarations are hollowed, never deleted.** V8 ranges start at the
   `function` keyword, so an uncovered range never contains the `export`; delete
   the declaration and the orphaned keyword absorbs the next statement.
8. **Validated `'use asm'` modules are never touched.** V8 does not instrument
   them, so their count-0 coverage is meaningless.
9. **An entry must prove which text its offsets refer to.** Either it embeds
   the executed `source`, or its `sourceHash` matches the file on disk byte for
   byte (no CRLF tolerance there — differing line endings shift every offset).
   With neither, the file is skipped. A `source` that disagrees with its own
   `sourceHash` means the report is inconsistent; skip too.
10. **Unmergeable coverage entries poison the whole file.** If any entry mapping
    to a file cannot be used (source-text or kind disagreement, unprovable
    source per #9, disk mismatch, lost CSS usage), the file is skipped
    entirely. Pruning from a subset of entries deletes code that ran during the
    dropped entry's run.
11. **Re-parse validation is a backstop, not a strategy.** If a mainstream
    syntax shape routinely trips it, that is a planner bug — the symptom is a
    whole file silently going unpruned.
12. **Whitespace cleanup never enters string or template literals.** Cosmetic
    regexes over the whole file silently change runtime values.

## Platform facts that are expensive to rediscover

Verified against real Chromium and real `NODE_V8_COVERAGE`, not documentation.

**V8 / JS coverage**

- V8 always emits a **whole-script entry** (`functionName: ""`) whose range
  spans the entire file with count ≥ 1. A naive "count > 0 means covered" union
  therefore marks every file fully covered and nothing is ever deletable. You
  must apply innermost-range-wins semantics (the v8-to-istanbul model).
- Never-called functions **are** in the payload — as `isBlockCoverage: false`
  entries with a single count-0 root range. They are easy to miss because the
  whole-script range covers them.
- **V8 misreports executed code as count-0** in at least these shapes: the
  continuation after a conditionally-skipped `await`/`yield` (in ternaries,
  `&&`/`||`/`??`, optional chains), and the region after a zero-iteration
  `for (let …)` loop whose body contains a function literal. This is why
  invariant 3 exists.
- Offsets are **UTF-16 code units**, not bytes. Astral characters shift them.
  Report v2 states this in `meta.offsets`; a report claiming anything else is
  rejected rather than guessed at.
- Coverage stops the instant the last scenario returns; late async work
  (post-click fetches, debounced handlers) is counted as unexecuted.

**Chrome CSS coverage**

- A used rule is reported as its **full span**. But a used at-rule is reported
  as **the condition text only** — `@media` keyword and both braces excluded.
  Byte-slicing to used ranges therefore emits `(min-width: 100px) .x { … }`,
  which browsers drop wholesale, destroying styles that *were* used.
- `@keyframes`, `@font-face`, and `@import` are **never reported**, even when
  demonstrably in use. They must be kept unconditionally.
- **CSS usage does not survive navigation**, regardless of `resetOnNavigation`.
  The page instance navigated away from returns a zero-range entry even though
  its rules were used. Hence per-scenario cycling in `browser.ts` (with an
  `about:blank` step so the previous page's sheets cannot re-register as ghost
  entries) and the zero-range poisoning rule in `resolve.ts`.
- Chrome strips a BOM from the text it returns, which then mismatches the disk
  file and safely skips it.

**Blind spots**: `page.coverage` sees one page. Web workers, service workers,
cross-origin iframes, and popups are invisible; a bundle shared with a worker
will have its worker-only paths stubbed.

## How to verify a change

`test/differential/` is the oracle and the reason the pruner can be trusted.
Each fixture is a deterministic script whose only observable behavior is
`console.log` output. The harness runs it under real `NODE_V8_COVERAGE`, wraps
the raw payload in a report v2, serializes and validates it, classifies it at
prune time, prunes it with the real pipeline, runs the pruned output, and
asserts the output is identical. That catches the class of bug syntax validation cannot: **output that
parses but behaves differently.**

**Any behavioral change to the pruner needs a differential fixture.** The 36
fixtures `a`–`aj` are regression pins; each corresponds to a real shipped bug,
so treat a newly failing one as a genuine regression.

When hand-crafting coverage ranges in unit tests, keep them V8-realistic:
`covered` and `stub` ranges are **disjoint**, and a dead function's span appears
in **neither** list. Ranges V8 cannot produce prove nothing.

```bash
npm test                      # everything (unit + differential)
npm run typecheck
npm run build
npx vitest run src/prune      # just the pruner units
npx vitest run test/differential
npm run example -- --dry-run  # end-to-end against examples/minimal-vite
```

`vitest.config.ts` includes both `src/**/*.test.ts` and `test/**/*.test.ts`.
The suite needs no browser — the differential harness uses Node's own V8
coverage — so no `playwright install` step is required to run it. Running the
example app does need `npm install` inside `examples/minimal-vite` first.

Useful escape hatches while debugging: `COVERKILL_DEBUG_AST=1` explains planner
bail-outs, `COVERKILL_DEBUG_GLOBS=1` explains include/exclude decisions.

## Conventions

- Conventional Commits — release-please derives the version and changelog from
  them, with `bump-minor-pre-major` so breaking changes stay below 1.0.0.
- The prune half must not import Playwright, even for types at runtime. Keep
  the collect-side types in `src/collect/`.
- Prefer leaving a file unchanged over emitting a guess.

## Where the project is going

Open issues carry the roadmap and the design reasoning behind each item
(**#3**, raw V8 `ScriptCoverage` as the report format, shipped as report v2):

- **#4** — source maps, so pruning targets `src/` instead of ephemeral `dist/`.
- **#5** — `coverkill merge` to union coverage across runs (locales, viewports,
  flag assignments); shipped as the `merge` command.
- **#6** — loud stub mode: pruned paths `throw` or beacon instead of silently
  evaluating to `0`/`{}`; shipped as `pruneMode: 'silent' | 'throw' | 'beacon'`
  (`src/prune/stubs.ts`, announcement text injected by every stub shape in
  `ast-prune.ts`).
- **#7** — `/* coverkill-keep */` pragmas and max-percent-removed thresholds.
- **#8** — warn when workers, service workers, iframes, or popups ran.
- **#9** — per-navigation CSS deltas via CDP, so shared stylesheets are prunable
  within a single scenario.
- **#10** — lazy-load transform for large never-executed async functions;
  contains an assessment of why the advisory version should ship first.
