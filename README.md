# coverkill

Remove unused JavaScript and CSS based on Chrome coverage collected via Playwright.

coverkill has two halves with a JSON coverage report as the contract between them:

- **collect** — drives your app in Chromium through scenario scripts and records
  what actually executed (V8 block coverage for JS, used-rule coverage for CSS).
  Requires `playwright`.
- **prune** — a pure file transform that rewrites the covered files on disk,
  deleting code that never ran and stubbing branches that never executed inside
  live functions. Needs no browser and no playwright.

`coverkill run` composes both; `coverkill collect` and `coverkill prune` run them
separately (for example: collect in CI, review the report, prune later).

The report carries V8's own numbers, so **coverkill can prune coverage it did not
collect**: a `NODE_V8_COVERAGE` directory, a `@playwright/test` or Puppeteer
coverage dump, or a Chrome DevTools Coverage panel export all go straight into
`coverkill prune`. See [Pruning coverage from other tools](#pruning-coverage-from-other-tools).

## Install

```bash
npm install -D coverkill playwright
npx playwright install chromium
```

Playwright is an optional peer dependency: it is only needed for `collect`/`run`.
If you only ever prune from saved reports, you can skip it.

## Quick start

1. Create `coverkill.config.ts`:

```ts
import { defineConfig } from 'coverkill';

export default defineConfig({
  baseURL: 'http://localhost:3000',
  scenarios: ['./e2e/scenarios/*.ts'],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
  include: ['src/**/*.{js,ts,css}'],
  sourcePath(url) {
    // Map browser URLs to files on disk. Returning null skips the URL.
    const path = new URL(url).pathname;
    if (path === '/app.js') return './dist/app.js';
    return null;
  },
});
```

2. Add a scenario (Playwright-style `Page` API):

```ts
import type { ScenarioContext } from 'coverkill';

export default async function ({ page, baseURL }: ScenarioContext) {
  await page.goto(baseURL);
  await page.getByRole('button', { name: 'Submit' }).click();
}
```

3. Run (dry-run first):

```bash
npx coverkill --dry-run
npx coverkill
```

By default, matching files are **modified in place**. Use git so you can revert.

## Commands

| Command | Description |
|---------|-------------|
| `coverkill` / `coverkill run` | Collect coverage and prune |
| `coverkill collect` | Collect coverage and write a report file |
| `coverkill prune --report <file>` | Prune from a saved report, a raw V8 coverage file, or a `NODE_V8_COVERAGE` directory |
| `coverkill import <inputs...>` | Convert raw V8 / DevTools coverage into a coverkill report |
| `coverkill merge <reports...>` | Union coverage from multiple runs into one report (covered-anywhere-wins) |

### Flags

- `-c, --config <path>` — config file path (global)
- `run --dry-run` — show what would be removed without writing
- `run --save-report <path>` — also write the coverage report JSON
- `collect -o, --out <path>` — report destination (default `coverkill-coverage.json`)
- `prune -r, --report <path>` — report to prune from (required)
- `prune --dry-run` — show what would be removed without writing
- `import -o, --out <path>` — report destination (default `coverkill-coverage.json`)
- `import --root-dir <path>` — `rootDir` recorded in the report (default: cwd)
- `import --strip-source` — store only source hashes, not the source text
- `merge -o, --out <path>` — merged report destination (default `coverkill-coverage.json`)
- `merge --root-dir <path>` — `rootDir` recorded in the merged report (required when inputs disagree)

`prune` and `import` use only the prune half of the config, so a config file for
them needs no `baseURL` or `scenarios`; `merge` needs no config at all.

## Merging coverage across runs

A single run is one browser session, one viewport, one locale, one set of
feature flags — anything it does not exercise is indistinguishable from dead
code. `coverkill merge` unions the evidence from several runs before pruning,
turning "we think this is dead" into "no configuration we tested reaches this":

```bash
coverkill collect -o run-desktop.json   # one report per viewport / locale / flag set
coverkill collect -o run-mobile.json
coverkill merge -o merged.json run-desktop.json run-mobile.json
coverkill prune -r merged.json
```

Union semantics are **covered-anywhere-wins**: a byte that executed in any run
is covered, and a branch is only stubbed (or a function deleted) if no run
executed it. Inputs can be coverkill v2 reports, raw V8/DevTools dumps, or
`NODE_V8_COVERAGE` directories — anything `prune -r` accepts, except report v1
(its pre-classified ranges cannot be merged; re-collect or re-import).

All runs must come from the same build: when the same URL carries different
source text in two inputs, the offsets are in different coordinate spaces and
the merge fails with an error — rather than producing a report whose files
would all be silently skipped at prune time. Zero-range CSS entries (Chrome
losing usage data on navigation) are carried through verbatim, so they still
protect their file from being pruned on partial evidence.

## Pruning coverage from other tools

Any V8 coverage is usable, whoever produced it:

```bash
# An existing Playwright/Vitest/Node run
NODE_V8_COVERAGE=./cov node ./dist/server.js
npx coverkill prune -r ./cov --dry-run

# Or convert first, review the report, prune later
npx coverkill import ./cov -o coverage.json --strip-source
npx coverkill prune -r coverage.json
```

Accepted inputs:

| Input | Shape |
|-------|-------|
| `NODE_V8_COVERAGE` directory or one of its dumps | `{ "result": [ { url, functions } ] }` |
| CDP `Profiler.takePreciseCoverage` | same |
| Playwright `page.coverage.stopJSCoverage()` JSON | `[ { url, source, functions } ]` |
| Playwright `stopCSSCoverage()` / DevTools Coverage export | `[ { url, text, ranges } ]` |

Used-ranges-only inputs (the last row) carry no execution counts, so there is no
way to tell an unexecuted branch from a never-called function: every used range
counts as executed and everything else as never executed.

Entries without embedded source text are matched to disk by a `sha256-` hash, so
a file edited between collection and pruning is skipped rather than mis-sliced.
For that guard to exist at all, an imported entry needs either its source text
or a `file://` URL that coverkill can hash at import time; entries with neither
are skipped. When hashing from disk, the file must still fit the coverage
offsets (V8's whole-script range spans exactly the text it compiled) — a file
already edited by the time you import is left unverifiable, and skipped.

### Report format

`coverkill collect` writes **report v2**, which carries V8's `ScriptCoverage`
verbatim — counts, function names, and block-coverage flags intact:

```jsonc
{
  "version": 2,
  "meta": { "collectedAt": "…", "offsets": "utf16CodeUnits", "coverageSettings": { … } },
  "rootDir": "/path/to/project",
  "scripts": [
    {
      "url": "http://localhost:3000/app.js",
      "sourceType": "module",
      "sourceHash": "sha256-…",
      "source": "…",              // optional; set report.includeSource=false to omit
      "functions": [ /* raw V8 ranges, counts intact */ ]
    }
  ],
  "stylesheets": [ { "url": "…", "sourceHash": "…", "ranges": [ { "start": 0, "end": 42 } ] } ]
}
```

Because the counts survive, covered / stub / dead is decided when you prune, not
when you collect. Report v1 (pre-classified byte ranges) is still read.

## Config

One config file feeds both halves. Collect-side options:

| Option | Description |
|--------|-------------|
| `baseURL` | Base URL for scenarios |
| `scenarios` | Glob paths to scenario modules |
| `webServer` | Dev server command + URL (Playwright-style) |
| `browser` | `headless`, `channel` |
| `coverage.js` | `resetOnNavigation`, `reportAnonymousScripts` (both default `false`) |
| `coverage.css` | `false` to disable, or `{ resetOnNavigation }` (default enabled, no reset) |
| `report.includeSource` | Embed executed source text in the report (default `true`); `false` keeps only its hash |

Prune-side options:

| Option | Description |
|--------|-------------|
| `include` | Allowlist globs; only these files are pruned |
| `exclude` | Deny globs applied after `include` |
| `sourcePath(url)` | Map coverage URL → local file path; `null` skips the URL |
| `preserveLicenseHeader` | Keep leading license comments (default `true`) |
| `cssSafelist` | Regexes; CSS rules whose selector matches are always kept |

`rootDir` (shared) anchors relative paths and glob matching; it defaults to the
process working directory.

## How it works

1. Launches Chromium, starts JS + CSS coverage, and runs each scenario module
   (default export or `scenario` named export).
2. Interprets V8 block coverage with innermost-range-wins semantics: the
   effective count of every byte comes from the smallest range containing it,
   so dead functions are visible even though V8 also reports a whole-script
   covered range. Bytes are classified covered / stub (unexecuted branch inside
   a function that ran) / dead (inside a function that never ran).
3. Maps URLs to disk files (`sourcePath`, then `include`/`exclude`), skipping
   any file whose on-disk content no longer matches what the browser executed
   (by text when the report embeds it, by `sourceHash` when it does not).
4. Prunes JS on the AST (acorn; ES modules and scripts both supported). Edits
   only ever replace bytes inside uncovered ranges:
   - dead functions are deleted — or hollowed to `function name() {}` when
     covered code still references the name;
   - unexecuted statements are removed; `var`/`let`/`const` statements keep
     their bindings; uncovered `else` branches are dropped; ternary and
     logical-expression branches become `0`; unexecuted callbacks keep their
     signature with an emptied body; switch cases keep their own labels;
   - `catch` blocks are never pruned, so error reporting survives;
   - the result must re-parse or the file is left unchanged.
5. Prunes CSS structurally: whole rules only. `@media`/`@supports`/`@layer`
   shells are preserved whenever any inner rule survives, and at-rules Chrome
   never tracks (`@keyframes`, `@font-face`, `@import`, `@property`, …) are
   always kept.

## Safety model and limits

Coverage reflects **what the browser executed during your scenarios**. Anything
your scenarios did not exercise — error paths, other locales or viewports,
feature-flagged branches, `:hover` styles you never hovered — is indistinguishable
from dead code. Use `--dry-run`, review diffs, keep everything under version
control, and use `cssSafelist` for styles that only apply in states your
scenarios do not visit.

Known blind spots: coverage is Chromium-only and per-page — code running in web
workers, service workers, iframes, or popups is not observed. Files served with
transforms (dev-server HMR, on-the-fly transpilation) are skipped because the
executed text does not match the file on disk; run against built output instead.

Chrome discards CSS rule-usage on navigation, so coverkill cycles CSS coverage
per scenario: navigating between pages in *separate* scenarios works, but a
stylesheet shared across pages visited *within one* scenario is skipped for
safety (its earlier pages' usage is unrecoverable). JS coverage accumulates
across navigations normally.

## Local development

```bash
npm install
npm run build
npm test
npm start -- --config examples/minimal-vite/coverkill.config.ts run --dry-run
```

The test suite includes a differential harness (`test/differential`) that runs
fixtures under `NODE_V8_COVERAGE`, prunes them with the real pipeline, re-runs
the pruned output, and asserts observable behavior is unchanged.

Releases are automated with [release-please](https://github.com/googleapis/release-please),
which derives the version and changelog from
[Conventional Commits](https://www.conventionalcommits.org) — use `fix:`,
`feat:`, and `feat!:`/`BREAKING CHANGE:` prefixes. Merging the release PR it
opens tags the release and publishes to npm.

Run the example app manually:

```bash
cd examples/minimal-vite && npm install && npm run start
```

## Programmatic API

```ts
import { run, collect, prune, defineConfig } from 'coverkill';

await run({ configPath: './coverkill.config.ts', dryRun: true });
```

Or use the halves directly — `coverkill/prune` never imports playwright:

```ts
import { collectCoverage } from 'coverkill/collect';
import { pruneFromReport, loadReport } from 'coverkill/prune';
```

To prune coverage collected by your own runner, hand the raw payload to
`importV8Coverage` (pure) or `importV8CoverageFiles` (reads files/directories):

```ts
import { importV8Coverage, pruneFromReport } from 'coverkill/prune';

const report = importV8Coverage(await page.coverage.stopJSCoverage(), { rootDir });
await pruneFromReport(report, { rootDir, include: ['dist/**'], preserveLicenseHeader: true });
```

## License

MIT
