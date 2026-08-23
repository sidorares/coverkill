/**
 * The prune half of coverkill: given a CoverageReport, rewrite the
 * allowlisted files on disk with uncovered code removed or stubbed.
 * Pure file transform — no browser, no playwright dependency.
 */
export {
  pruneFromReport,
  formatPruneResult,
  type PruneOptions,
  type PruneResult,
  type PruneFileResult,
} from './prune.js';
export { removeUncoveredRanges, type RemoveUncoveredOptions } from './ranges.js';
export { resolvePruneTargets, type ResolvedPruneTarget, type ResolveResult } from './resolve.js';
export { loadReport, validateReport } from '../report/io.js';
export { normalizeReport, type NormalizedReport } from '../report/normalize.js';
export {
  importV8Coverage,
  importV8CoverageFiles,
  mergeV2Reports,
  type ImportOptions,
  type ImportFilesOptions,
} from '../report/import.js';
export { extractJsCoverage } from '../report/v8.js';
export { hashSource } from '../report/hash.js';
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
} from '../report/types.js';
export type { PruneConfigInput, ResolvedPruneConfig } from '../config/types.js';
