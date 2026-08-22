import { mergeRanges } from '../report/merge.js';
import type { ByteRange, CoverageReport, FileCoverageEntry } from '../report/types.js';

/**
 * Shape of one script's coverage as reported by Playwright's
 * page.coverage.stopJSCoverage() (mirrors V8's block coverage output).
 */
export type JsCoverageEntry = {
  url: string;
  scriptId?: string;
  source?: string;
  functions: Array<{
    functionName: string;
    isBlockCoverage: boolean;
    ranges: Array<{ startOffset: number; endOffset: number; count: number }>;
  }>;
};

/** Shape of one stylesheet's coverage from page.coverage.stopCSSCoverage(). */
export type CssCoverageEntry = {
  url: string;
  text?: string;
  ranges: Array<{ start: number; end: number }>;
};

export function buildCoverageReport(
  rootDir: string,
  js: JsCoverageEntry[],
  css: CssCoverageEntry[],
): CoverageReport {
  const entries: FileCoverageEntry[] = [];

  for (const entry of js) {
    const source = entry.source ?? '';
    const { covered, stub } = extractJsCoverage(entry);
    if (source.length === 0 && covered.length === 0 && stub.length === 0) continue;
    entries.push({
      url: entry.url,
      source,
      kind: 'js',
      ranges: mergeRanges(covered),
      stubRanges: stub.length > 0 ? mergeRanges(stub) : undefined,
    });
  }

  for (const entry of css) {
    const source = entry.text ?? '';
    const ranges = entry.ranges.map((r) => ({ start: r.start, end: r.end }));
    if (source.length === 0 && ranges.length === 0) continue;
    entries.push({
      url: entry.url,
      source,
      kind: 'css',
      ranges: mergeRanges(ranges),
    });
  }

  return {
    version: 1,
    collectedAt: new Date().toISOString(),
    rootDir,
    entries,
  };
}

export function extractJsCoverage(entry: JsCoverageEntry): {
  covered: ByteRange[];
  stub: ByteRange[];
} {
  const covered: ByteRange[] = [];
  const stub: ByteRange[] = [];

  for (const fn of entry.functions) {
    const fnRanges = fn.ranges.filter((r) => r.endOffset > r.startOffset);
    const executed = fnRanges.some((r) => r.count > 0);

    for (const range of fnRanges) {
      const byteRange = { start: range.startOffset, end: range.endOffset };
      if (range.count > 0) {
        covered.push(byteRange);
      } else if (executed) {
        stub.push(byteRange);
      }
    }
  }

  return { covered, stub };
}
