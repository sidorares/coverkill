# coverkill

Remove unused JavaScript and CSS based on Chrome coverage collected via Playwright.

## Install

```bash
npm install -D coverkill playwright
npx playwright install chromium
```

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
    // Map browser URLs to files on disk
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
| `coverkill collect` | Collect coverage only |
| `coverkill prune --report <file>` | Prune from a saved JSON report |

### Flags

- `--config <path>` — config file path
- `--dry-run` — show what would be removed without writing
- `--save-report <path>` — write coverage JSON

## Config

| Option | Description |
|--------|-------------|
| `baseURL` | Base URL for scenarios |
| `scenarios` | Glob paths to scenario modules |
| `webServer` | Dev server command + URL (Playwright-style) |
| `include` | Allowlist globs; only these files are pruned |
| `exclude` | Deny globs applied after `include` |
| `sourcePath(url)` | Map coverage URL → local file path |
| `coverage.js` | `resetOnNavigation`, `reportAnonymousScripts` |
| `coverage.css` | Enable CSS coverage (default `true`) |
| `preserveLicenseHeader` | Keep leading license comments (default `true`) |

## How it works

1. Launches Chromium and starts JS/CSS coverage.
2. Runs each scenario module (default export or `scenario` named export).
3. Merges executed byte ranges per file.
4. Removes uncovered ranges from allowlisted files (in place).

Coverage reflects **what the browser executed** (often built assets). To prune original `src/`, either serve sources directly, point `sourcePath` at the built files you want to shrink, or wait for future source-map support.

## Local development

```bash
pnpm install
pnpm build
pnpm test
pnpm start -- --config examples/minimal-vite/coverkill.config.ts --dry-run
pnpm example -- --dry-run
```

Run the example app manually:

```bash
cd examples/minimal-vite && npm install && npm run start
```

## Programmatic API

```ts
import { run, collect, prune, defineConfig } from 'coverkill';

await run({ configPath: './coverkill.config.ts', dryRun: true });
```

## License

MIT
