import type { Browser, Page } from 'playwright';
import type { ResolvedCollectConfig } from '../config/types.js';
import type { CoverageReport } from '../report/types.js';
import { buildCoverageReport } from './extract.js';
import { loadScenarios } from './scenarios.js';
import { startWebServer, stopWebServer, type WebServerHandle } from './webServer.js';

export type CollectOptions = {
  onReport?: (report: CoverageReport) => Promise<void>;
};

async function loadChromium(): Promise<typeof import('playwright').chromium> {
  try {
    const playwright = await import('playwright');
    return playwright.chromium;
  } catch {
    throw new Error(
      'coverkill collect requires playwright. Install it with:\n' +
        '  npm install -D playwright && npx playwright install chromium',
    );
  }
}

export async function collectCoverage(
  config: ResolvedCollectConfig,
  options: CollectOptions = {},
): Promise<CoverageReport> {
  const chromium = await loadChromium();
  let webServer: WebServerHandle | null = null;
  let browser: Browser | undefined;

  try {
    if (config.webServer) {
      webServer = await startWebServer(config.webServer);
    }

    browser = await chromium.launch({
      headless: config.browser.headless ?? true,
      channel: config.browser.channel,
    });

    const context = await browser.newContext({ baseURL: config.baseURL });
    const page = await context.newPage();
    const scenarios = await loadScenarios(config);

    // JS coverage accumulates across navigations (resetOnNavigation false),
    // but Chrome discards CSS rule usage on every navigation regardless of
    // settings — the navigated-away page instance comes back as a zero-range
    // entry. Cycling CSS coverage per scenario captures each scenario's last
    // page correctly; navigations WITHIN one scenario still lose the earlier
    // pages' CSS usage, which the resolver detects and skips for safety.
    await page.coverage.startJSCoverage({
      resetOnNavigation: config.coverage.js.resetOnNavigation,
      reportAnonymousScripts: config.coverage.js.reportAnonymousScripts,
    });

    const css: Awaited<ReturnType<Page['coverage']['stopCSSCoverage']>> = [];
    let firstScenario = true;
    for (const { fn } of scenarios) {
      if (config.coverage.css.enabled) {
        if (!firstScenario) {
          // Unload the previous scenario's page first: starting a CSS session
          // while its stylesheets are still loaded re-registers them, and the
          // next navigation turns them into zero-range ghost entries that the
          // resolver must then treat as lost usage.
          await page.goto('about:blank');
        }
        await page.coverage.startCSSCoverage({
          resetOnNavigation: config.coverage.css.resetOnNavigation,
        });
      }
      firstScenario = false;
      await fn({ page, baseURL: config.baseURL });
      if (config.coverage.css.enabled) {
        css.push(...(await page.coverage.stopCSSCoverage()));
      }
    }

    const js = await page.coverage.stopJSCoverage();
    const report = buildCoverageReport(config.rootDir, js, css);

    if (options.onReport) {
      await options.onReport(report);
    }

    return report;
  } finally {
    if (browser) await browser.close();
    await stopWebServer(webServer);
  }
}

export async function startCoverage(page: Page, config: ResolvedCollectConfig): Promise<void> {
  await page.coverage.startJSCoverage({
    resetOnNavigation: config.coverage.js.resetOnNavigation,
    reportAnonymousScripts: config.coverage.js.reportAnonymousScripts,
  });
  if (config.coverage.css.enabled) {
    // Playwright defaults resetOnNavigation to true, which would discard CSS
    // coverage from every page except the last one visited.
    await page.coverage.startCSSCoverage({
      resetOnNavigation: config.coverage.css.resetOnNavigation,
    });
  }
}

export async function stopCoverage(
  page: Page,
  config: ResolvedCollectConfig,
): Promise<{
  js: Awaited<ReturnType<Page['coverage']['stopJSCoverage']>>;
  css: Awaited<ReturnType<Page['coverage']['stopCSSCoverage']>>;
}> {
  const js = await page.coverage.stopJSCoverage();
  const css = config.coverage.css.enabled ? await page.coverage.stopCSSCoverage() : [];
  return { js, css };
}
