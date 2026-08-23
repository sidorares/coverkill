import { hashSource } from '../report/hash.js';
import { mergeRanges } from '../report/merge.js';
import { extractJsCoverage } from '../report/v8.js';
import type {
  CoverageReportV1,
  CoverageReportV2,
  FileCoverageEntry,
  ScriptCoverageEntry,
  StyleSheetCoverageEntry,
} from '../report/types.js';
import { coverkillVersion } from '../version.js';

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

export type BuildReportOptions = {
  collectedAt?: string;
  /** Recorded in meta so a report explains how it was produced. */
  coverageSettings?: Record<string, unknown>;
  /** Embed the executed source text alongside its hash (default true). */
  includeSource?: boolean;
};

/**
 * Build a report v2: V8's native counts, carried verbatim. Classification into
 * covered / stub / dead happens at prune time, so a report collected today can
 * be pruned under a different policy tomorrow.
 */
export function buildCoverageReportV2(
  rootDir: string,
  js: JsCoverageEntry[],
  css: CssCoverageEntry[],
  options: BuildReportOptions = {},
): CoverageReportV2 {
  const includeSource = options.includeSource ?? true;
  const scripts: ScriptCoverageEntry[] = [];
  const stylesheets: StyleSheetCoverageEntry[] = [];

  for (const entry of js) {
    const source = entry.source;
    scripts.push({
      url: entry.url,
      scriptId: entry.scriptId,
      sourceHash: source === undefined ? undefined : hashSource(source),
      source: includeSource ? source : undefined,
      functions: entry.functions,
    });
  }

  for (const entry of css) {
    const source = entry.text;
    // An entry with neither text nor ranges carries no information at all;
    // keeping it would poison a file other entries can still prune.
    if (source === undefined && entry.ranges.length === 0) continue;
    stylesheets.push({
      url: entry.url,
      sourceHash: source === undefined ? undefined : hashSource(source),
      source: includeSource ? source : undefined,
      ranges: mergeRanges(entry.ranges.map((r) => ({ start: r.start, end: r.end }))),
    });
  }

  return {
    version: 2,
    meta: {
      coverkillVersion: coverkillVersion(),
      collectedAt: options.collectedAt ?? new Date().toISOString(),
      offsets: 'utf16CodeUnits',
      source: 'coverkill collect',
      coverageSettings: options.coverageSettings,
    },
    rootDir,
    scripts,
    stylesheets,
  };
}

/**
 * Build a report v1 — classification baked in at collect time.
 *
 * @deprecated Superseded by {@link buildCoverageReportV2}; kept so consumers
 * pinned to the v1 shape (and its pre-flattened ranges) still have a builder.
 */
export function buildCoverageReport(
  rootDir: string,
  js: JsCoverageEntry[],
  css: CssCoverageEntry[],
): CoverageReportV1 {
  const entries: FileCoverageEntry[] = [];

  for (const entry of js) {
    const source = entry.source ?? '';
    if (source.length === 0) {
      // Without the executed text the ranges are uninterpretable (and a saved
      // report containing them would fail its own validation). Keep a
      // zero-range marker when there WAS coverage, so the resolver knows this
      // file's usage data is incomplete and skips it.
      if (entry.functions.length > 0) {
        entries.push({ url: entry.url, source: '', kind: 'js', ranges: [] });
      }
      continue;
    }
    const { covered, stub } = extractJsCoverage(entry);
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
    if (source.length === 0) {
      if (entry.ranges.length > 0) {
        entries.push({ url: entry.url, source: '', kind: 'css', ranges: [] });
      }
      continue;
    }
    entries.push({
      url: entry.url,
      source,
      kind: 'css',
      ranges: mergeRanges(entry.ranges.map((r) => ({ start: r.start, end: r.end }))),
    });
  }

  return {
    version: 1,
    collectedAt: new Date().toISOString(),
    rootDir,
    entries,
  };
}

export { extractJsCoverage };
