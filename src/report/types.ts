export type ByteRange = {
  start: number;
  end: number;
};

export type FileCoverageEntry = {
  url: string;
  /** Resolved absolute path on disk, if known */
  filePath?: string;
  source: string;
  kind: 'js' | 'css';
  /** Byte ranges that executed at least once */
  ranges: ByteRange[];
  /**
   * JS only: uncovered ranges inside functions that did run.
   * These are stubbed (e.g. `else {}`) instead of deleted to keep valid syntax.
   */
  stubRanges?: ByteRange[];
};

export type CoverageReport = {
  version: 1;
  collectedAt: string;
  rootDir: string;
  entries: FileCoverageEntry[];
};
