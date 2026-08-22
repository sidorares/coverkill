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
export type { CoverageReport, FileCoverageEntry, ByteRange } from '../report/types.js';
export type { PruneConfigInput, ResolvedPruneConfig } from '../config/types.js';
