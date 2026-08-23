import { mergeRanges } from './merge.js';
import type { CoverageReport, FileCoverageEntry } from './types.js';
import { extractJsCoverage } from './v8.js';

/**
 * The internal model the pruner consumes. Both report versions collapse into
 * it; v1 arrives pre-classified, v2 is classified here, at prune time.
 */
export type NormalizedReport = {
  rootDir: string;
  collectedAt: string;
  entries: FileCoverageEntry[];
};

export function normalizeReport(report: CoverageReport): NormalizedReport {
  if (report.version === 1) {
    return {
      rootDir: report.rootDir,
      collectedAt: report.collectedAt,
      entries: report.entries,
    };
  }

  const entries: FileCoverageEntry[] = [];

  for (const script of report.scripts) {
    // An entry with neither the executed text nor a hash of it, and no
    // coverage either, says nothing at all — dropping it keeps it from
    // poisoning a file that other entries can still prune safely.
    if (script.functions.length === 0 && !script.source && !script.sourceHash) continue;
    const { covered, stub } = extractJsCoverage(script);
    entries.push({
      url: script.url,
      source: script.source,
      sourceHash: script.sourceHash,
      sourceType: script.sourceType,
      kind: 'js',
      ranges: covered,
      stubRanges: stub.length > 0 ? stub : undefined,
    });
  }

  for (const sheet of report.stylesheets) {
    if (sheet.ranges.length === 0 && !sheet.source && !sheet.sourceHash) continue;
    entries.push({
      url: sheet.url,
      source: sheet.source,
      sourceHash: sheet.sourceHash,
      kind: 'css',
      ranges: mergeRanges(sheet.ranges),
    });
  }

  return { rootDir: report.rootDir, collectedAt: report.meta.collectedAt, entries };
}
