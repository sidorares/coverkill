export type ByteRange = {
  start: number;
  end: number;
};

/**
 * Normalized coverage for one file, in the coordinate space of the exact text
 * that was executed. This is the model the pruner consumes; both report
 * versions are converted into it by `normalizeReport`.
 */
export type FileCoverageEntry = {
  url: string;
  /** Resolved absolute path on disk, if known */
  filePath?: string;
  /**
   * The text whose offsets the ranges refer to. Optional in report v2: when it
   * is absent `sourceHash` must vouch for the on-disk file instead.
   */
  source?: string;
  /** `sha256-<hex>` of the executed text. Guards the on-disk file. */
  sourceHash?: string;
  /** JS only: parse goal, when the collector knew it. */
  sourceType?: SourceType;
  kind: 'js' | 'css';
  /** Byte ranges that executed at least once */
  ranges: ByteRange[];
  /**
   * JS only: uncovered ranges inside functions that did run.
   * These are stubbed (e.g. `else {}`) instead of deleted to keep valid syntax.
   */
  stubRanges?: ByteRange[];
};

export type SourceType = 'script' | 'module';

/** Report v1: classification already baked in at collect time. */
export type CoverageReportV1 = {
  version: 1;
  collectedAt: string;
  rootDir: string;
  entries: FileCoverageEntry[];
};

/** One range of V8's block coverage output. */
export type V8CoverageRange = {
  startOffset: number;
  endOffset: number;
  count: number;
};

/** One function's coverage, exactly as V8/CDP reports it. */
export type V8FunctionCoverage = {
  functionName: string;
  isBlockCoverage: boolean;
  ranges: V8CoverageRange[];
};

/**
 * One script's coverage in report v2 — V8's native `ScriptCoverage` shape with
 * counts intact, plus the provenance coverkill needs to prune safely.
 *
 * Several entries may share a `url` (inline scripts, re-evaluated modules).
 * Entries whose `sourceHash` differs are in different coordinate spaces and
 * must never have their offsets merged.
 */
export type ScriptCoverageEntry = {
  url: string;
  scriptId?: string;
  sourceType?: SourceType;
  /** `sha256-<hex>` of the executed text. */
  sourceHash?: string;
  /** Optional: the hash alone can drive the on-disk guard. */
  source?: string;
  functions: V8FunctionCoverage[];
};

/** One stylesheet's used-rule ranges, as Chrome's CSS coverage reports them. */
export type StyleSheetCoverageEntry = {
  url: string;
  styleSheetId?: string;
  sourceHash?: string;
  /** Optional: the hash alone can drive the on-disk guard. */
  source?: string;
  ranges: ByteRange[];
};

export type ReportMeta = {
  coverkillVersion?: string;
  collectedAt: string;
  /** Coordinate space of every offset in the report. */
  offsets: 'utf16CodeUnits';
  /** How the coverage was produced, for reports coverkill did not collect. */
  source?: string;
  coverageSettings?: Record<string, unknown>;
};

/**
 * Report v2: carry V8's native shape as the payload so that what counts as
 * covered / stubbed / dead is a prune-time policy rather than something frozen
 * into the report at collect time.
 */
export type CoverageReportV2 = {
  version: 2;
  meta: ReportMeta;
  rootDir: string;
  scripts: ScriptCoverageEntry[];
  stylesheets: StyleSheetCoverageEntry[];
};

export type CoverageReport = CoverageReportV1 | CoverageReportV2;
