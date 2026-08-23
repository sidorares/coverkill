import { loadConfig, loadPruneConfig } from './config/load.js';
import { defineConfig } from './config/defineConfig.js';
import { saveReport, loadReport } from './report/io.js';
import { importV8CoverageFiles } from './report/import.js';
import type { CoverageReport, CoverageReportV2 } from './report/types.js';
import { pruneFromReport, formatPruneResult } from './prune/prune.js';

export { defineConfig, loadConfig, loadPruneConfig };
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
export type {
  CoverageReport,
  CoverageReportV1,
  CoverageReportV2,
  FileCoverageEntry,
  ScriptCoverageEntry,
  StyleSheetCoverageEntry,
  V8FunctionCoverage,
  V8CoverageRange,
  ByteRange,
  SourceType,
} from './report/types.js';
export { saveReport, loadReport, validateReport } from './report/io.js';
export { normalizeReport, type NormalizedReport } from './report/normalize.js';
export {
  importV8Coverage,
  importV8CoverageFiles,
  mergeV2Reports,
  type ImportOptions,
  type ImportFilesOptions,
} from './report/import.js';
export { extractJsCoverage } from './report/v8.js';
export { hashSource } from './report/hash.js';
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

export type ImportCliOptions = {
  /** Coverage JSON files and/or NODE_V8_COVERAGE directories. */
  inputs: string[];
  saveReport?: string;
  rootDir?: string;
  /** Keep only source hashes, dropping embedded source text. */
  stripSource?: boolean;
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
  const config = await loadPruneConfig(options.configPath);
  const report = await loadReport(options.reportPath);
  const result = await pruneFromReport(report, config, {
    dryRun: options.dryRun,
  });
  console.log(formatPruneResult(result, Boolean(options.dryRun)));
}

/**
 * Convert raw V8 / DevTools coverage into a coverkill report v2
 * (the `coverkill import` command). Needs no config file: the inputs already
 * describe what ran.
 */
export async function importCoverage(options: ImportCliOptions): Promise<CoverageReportV2> {
  const report = await importV8CoverageFiles(options.inputs, {
    rootDir: options.rootDir,
    stripSource: options.stripSource,
    label: 'imported',
  });
  if (options.saveReport) {
    await saveReport(report, options.saveReport);
  }
  return report;
}
