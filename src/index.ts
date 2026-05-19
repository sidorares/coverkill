import { loadConfig } from './config/load.js';
import type { CoverkillConfig } from './config/types.js';
import { defineConfig } from './config/defineConfig.js';
import { collectCoverage } from './runner/browser.js';
import { saveReport, loadReport } from './coverage/collect.js';
import type { CoverageReport } from './coverage/types.js';
import { pruneFromReport, formatPruneResult, type PruneOptions } from './prune/prune.js';
import type { ResolvedCoverkillConfig } from './config/types.js';

export { defineConfig };
export type { CoverkillConfig, ResolvedCoverkillConfig, ScenarioFn, ScenarioContext } from './config/types.js';
export type { CoverageReport, FileCoverageEntry, ByteRange } from './coverage/types.js';
export type { PruneResult, PruneFileResult, PruneOptions } from './prune/prune.js';

export type RunOptions = {
  configPath?: string;
  dryRun?: boolean;
  saveReport?: string;
};

export type CollectCliOptions = {
  configPath?: string;
  saveReport?: string;
};

export type PruneCliOptions = {
  configPath?: string;
  reportPath: string;
  dryRun?: boolean;
};

export async function run(options: RunOptions = {}): Promise<void> {
  const config = await loadConfig(options.configPath);
  const report = await collectCoverage(config, {
    onReport: options.saveReport
      ? (r) => saveReport(r, options.saveReport!)
      : undefined,
  });

  const pruneResult = await pruneFromReport(report, config, {
    dryRun: options.dryRun,
  });

  console.log(formatPruneResult(pruneResult, Boolean(options.dryRun)));
}

export async function collect(options: CollectCliOptions = {}): Promise<CoverageReport> {
  const config = await loadConfig(options.configPath);
  const report = await collectCoverage(config, {
    onReport: options.saveReport
      ? (r) => saveReport(r, options.saveReport!)
      : undefined,
  });
  return report;
}

export async function prune(options: PruneCliOptions): Promise<void> {
  const config = await loadConfig(options.configPath);
  const report = await loadReport(options.reportPath);
  const result = await pruneFromReport(report, config, {
    dryRun: options.dryRun,
  });
  console.log(formatPruneResult(result, Boolean(options.dryRun)));
}
