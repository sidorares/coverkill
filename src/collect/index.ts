/**
 * The collect half of coverkill: drive the app in Chromium via Playwright
 * scenarios and produce a CoverageReport suitable for pruning.
 * Requires playwright to be installed.
 */
export { collectCoverage, type CollectOptions } from './browser.js';
export { buildCoverageReport, extractJsCoverage } from './extract.js';
export type { JsCoverageEntry, CssCoverageEntry } from './extract.js';
export { saveReport } from '../report/io.js';
export type { CoverageReport, FileCoverageEntry, ByteRange } from '../report/types.js';
export type {
  CollectConfigInput,
  ResolvedCollectConfig,
  ScenarioContext,
  ScenarioFn,
} from '../config/types.js';
