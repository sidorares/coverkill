import { loadConfig } from './config/load.js';
import { defineConfig } from './config/defineConfig.js';
import { saveReport, loadReport } from './report/io.js';
import type { CoverageReport } from './report/types.js';
import { pruneFromReport, formatPruneResult } from './prune/prune.js';

export { defineConfig, loadConfig };
export type {
  CoverkillConfig,
  CollectConfigInput,
  PruneConfigInput,
  ResolvedCoverkillConfig,
  ResolvedCollectConfig,
  ResolvedPruneConfig,
  ScenarioFn,
  ScenarioContext,
} from './config/types.js';
export type { CoverageReport, FileCoverageEntry, ByteRange } from './report/types.js';
export { saveReport, loadReport, validateReport } from './report/io.js';
export {
  pruneFromReport,
  formatPruneResult,
  type PruneResult,
  type PruneFileResult,
  type PruneOptions,
} from './prune/prune.js';
export { collectCoverage, type CollectOptions } from './collect/browser.js';

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

/** Collect coverage and prune in one go (the `coverkill run` command). */
export async function run(options: RunOptions = {}): Promise<void> {
  const config = await loadConfig(options.configPath);
  const { collectCoverage } = await import('./collect/browser.js');
  const report = await collectCoverage(config, {
    onReport: options.saveReport ? (r) => saveReport(r, options.saveReport!) : undefined,
  });

  const pruneResult = await pruneFromReport(report, config, {
    dryRun: options.dryRun,
  });

  console.log(formatPruneResult(pruneResult, Boolean(options.dryRun)));
}

/** Collect coverage only (the `coverkill collect` command). */
export async function collect(options: CollectCliOptions = {}): Promise<CoverageReport> {
  const config = await loadConfig(options.configPath);
  const { collectCoverage } = await import('./collect/browser.js');
  const report = await collectCoverage(config, {
    onReport: options.saveReport ? (r) => saveReport(r, options.saveReport!) : undefined,
  });
  return report;
}

/** Prune from a saved report (the `coverkill prune` command). */
export async function prune(options: PruneCliOptions): Promise<void> {
  const config = await loadConfig(options.configPath);
  const report = await loadReport(options.reportPath);
  const result = await pruneFromReport(report, config, {
    dryRun: options.dryRun,
  });
  console.log(formatPruneResult(result, Boolean(options.dryRun)));
}
