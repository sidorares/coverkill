import { chromium, type Browser, type Page } from 'playwright';
import type { ResolvedCoverkillConfig } from '../config/types.js';
import { startCoverage, stopCoverage, buildCoverageReport } from '../coverage/collect.js';
import type { CoverageReport } from '../coverage/types.js';
import { runScenarios } from './scenarios.js';
import { startWebServer, stopWebServer, type WebServerHandle } from './webServer.js';

export type CollectOptions = {
  onReport?: (report: CoverageReport) => Promise<void>;
};

export async function collectCoverage(
  config: ResolvedCoverkillConfig,
  options: CollectOptions = {},
): Promise<CoverageReport> {
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
    await startCoverage(page, config);
    await runScenarios(page, config);
    const { js, css } = await stopCoverage(page, config);
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
