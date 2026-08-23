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
| `coverkill prune --report <file>` | Prune from a saved JSON report |

### Flags

- `-c, --config <path>` — config file path (global)
- `run --dry-run` — show what would be removed without writing
- `run --save-report <path>` — also write the coverage report JSON
- `collect -o, --out <path>` — report destination (default `coverkill-coverage.json`)
- `prune -r, --report <path>` — report to prune from (required)
- `prune --dry-run` — show what would be removed without writing

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
   any file whose on-disk content no longer matches what the browser executed.
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

## License

MIT
