/**
 * The collect half of coverkill: drive the app in Chromium via Playwright
 * scenarios and produce a CoverageReport suitable for pruning.
 * Requires playwright to be installed.
 */
export { collectCoverage, type CollectOptions } from './browser.js';
export { buildCoverageReport, buildCoverageReportV2, extractJsCoverage } from './extract.js';
export type { JsCoverageEntry, CssCoverageEntry, BuildReportOptions } from './extract.js';
export { saveReport } from '../report/io.js';
export { hashSource } from '../report/hash.js';
export type {
  CoverageReport,
  CoverageReportV1,
  CoverageReportV2,
  FileCoverageEntry,
  ScriptCoverageEntry,
  StyleSheetCoverageEntry,
  ByteRange,
} from '../report/types.js';
export type {
  CollectConfigInput,
  ResolvedCollectConfig,
  ScenarioContext,
  ScenarioFn,
} from '../config/types.js';
