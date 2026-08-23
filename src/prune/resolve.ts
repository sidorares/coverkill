import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ResolvedPruneConfig } from '../config/types.js';
import { sourceMatchesHash } from '../report/hash.js';
import { mergeRanges } from '../report/merge.js';
import { normalizeReport, type NormalizedReport } from '../report/normalize.js';
import type { CoverageReport, FileCoverageEntry, SourceType } from '../report/types.js';
import { createMatchers } from '../utils/globs.js';
import { contentMatchesDisk, defaultSourcePath } from '../utils/paths.js';

export type ResolvedPruneTarget = {
  filePath: string;
  source: string;
  ranges: FileCoverageEntry['ranges'];
  stubRanges: FileCoverageEntry['stubRanges'];
  kind: 'js' | 'css';
  /** JS only: parse goal, when the report knew it. */
  sourceType?: SourceType;
  url: string;
};

export type ResolveResult = {
  targets: ResolvedPruneTarget[];
  skipped: Array<{ url: string; reason: string }>;
};

export async function resolvePruneTargets(
  report: CoverageReport | NormalizedReport,
  config: ResolvedPruneConfig,
): Promise<ResolveResult> {
  const normalized = 'version' in report ? normalizeReport(report) : report;
  const { isIncluded } = createMatchers(config.rootDir, config.include, config.exclude);
  let targets: ResolvedPruneTarget[] = [];
  const skipped: ResolveResult['skipped'] = [];
  const byPath = new Map<string, ResolvedPruneTarget>();
  const poisoned = new Set<string>();

  // A file is only prunable when EVERY coverage entry mapping to it could be
  // merged: pruning from a subset of entries would delete code that executed
  // during the dropped entry's run. Poisoning removes the file entirely.
  const poison = (filePath: string, url: string, reason: string) => {
    skipped.push({ url, reason });
    poisoned.add(filePath);
    if (byPath.has(filePath)) {
      byPath.delete(filePath);
      targets = targets.filter((t) => t.filePath !== filePath);
    }
  };

  for (const entry of normalized.entries) {
    const filePath = resolveFilePath(entry.url, config);
    if (!filePath) {
      skipped.push({ url: entry.url, reason: 'no sourcePath mapping' });
      continue;
    }

    if (poisoned.has(filePath)) {
      skipped.push({
        url: entry.url,
        reason: `another coverage entry for ${filePath} could not be used; file skipped for safety`,
      });
      continue;
    }

    if (!isIncluded(filePath)) {
      skipped.push({ url: entry.url, reason: 'not in include allowlist' });
      continue;
    }

    // Range offsets are only meaningful against the exact text V8 executed.
    // Report v2 may omit that text, but then its hash must vouch for the file
    // on disk. With neither, the entry's usage data is unrecoverable and the
    // whole file is unsafe to prune from its remaining entries. (Checked
    // before the zero-range guard: sourceless entries carry empty ranges.)
    if (!entry.source && !entry.sourceHash) {
      poison(
        filePath,
        entry.url,
        'report entry has no embedded source text and no sourceHash (file skipped for safety)',
      );
      continue;
    }

    if (entry.ranges.length === 0) {
      if (entry.kind === 'css') {
        // Chrome CSS coverage does not survive navigations: a page instance
        // navigated away from comes back as a zero-range entry even when its
        // rules WERE used. For JS a zero-range entry genuinely means nothing
        // executed, but for CSS it means the usage data was lost — pruning
        // this file from its other entries would delete rules used on the
        // zero-range instance's page.
        poison(
          filePath,
          entry.url,
          'CSS usage for one page instance was lost (Chrome resets CSS coverage on navigation); file skipped for safety',
        );
      } else {
        skipped.push({ url: entry.url, reason: 'no covered ranges (skipped for safety)' });
      }
      continue;
    }

    let diskSource: string | undefined;
    try {
      diskSource = await readFile(filePath, 'utf8');
    } catch {
      skipped.push({ url: entry.url, reason: `file not found: ${filePath}` });
      continue;
    }

    let source: string;
    if (entry.source !== undefined) {
      // A hash that disagrees with the text it accompanies means the report
      // itself is inconsistent; neither can be trusted to place offsets.
      if (entry.sourceHash && !sourceMatchesHash(entry.source, entry.sourceHash)) {
        poison(
          filePath,
          entry.url,
          `coverage source for ${filePath} does not match its own sourceHash; file skipped`,
        );
        continue;
      }
      if (!contentMatchesDisk(entry.source, diskSource)) {
        poison(
          filePath,
          entry.url,
          `on-disk content does not match coverage source for ${filePath}; file skipped`,
        );
        continue;
      }
      // Byte offsets in the report refer to the script text V8 executed — prefer that over disk.
      source = entry.source;
    } else {
      // Source omitted: the on-disk file is usable only if it hashes to what
      // the collector recorded. Exact match required — the CRLF tolerance
      // above cannot apply, since differing line endings shift every offset.
      if (!sourceMatchesHash(diskSource, entry.sourceHash!)) {
        poison(
          filePath,
          entry.url,
          `on-disk content does not match sourceHash for ${filePath} (report omits source text); file skipped`,
        );
        continue;
      }
      source = diskSource;
    }

    const existing = byPath.get(filePath);
    if (existing) {
      // Ranges are offsets into the script text; entries whose text differs
      // (e.g. two inline scripts sharing a page URL, or line-ending drift
      // between navigations) are in different coordinate spaces.
      if (existing.source !== source || existing.kind !== entry.kind) {
        poison(
          filePath,
          entry.url,
          `coverage entries for ${filePath} disagree on source text or kind; file skipped`,
        );
        continue;
      }
      existing.ranges = mergeEntryRanges(existing.ranges, entry.ranges);
      existing.stubRanges = mergeEntryRanges(existing.stubRanges ?? [], entry.stubRanges ?? []);
      // Entries disagreeing on the parse goal fall back to auto-detection.
      if (existing.sourceType === undefined) {
        existing.sourceType = entry.sourceType;
      } else if (entry.sourceType !== undefined && entry.sourceType !== existing.sourceType) {
        existing.sourceType = undefined;
      }
    } else {
      const target: ResolvedPruneTarget = {
        filePath,
        source,
        ranges: [...entry.ranges],
        stubRanges: entry.stubRanges ? [...entry.stubRanges] : [],
        kind: entry.kind,
        sourceType: entry.sourceType,
        url: entry.url,
      };
      byPath.set(filePath, target);
      targets.push(target);
    }
  }

  return { targets, skipped };
}

function resolveFilePath(url: string, config: ResolvedPruneConfig): string | null {
  // When the user supplies sourcePath, its answer is final: an explicit null
  // means "do not prune this URL", never "fall back to guessing".
  const raw = config.sourcePath
    ? config.sourcePath(url)
    : defaultSourcePath(url, config.rootDir);
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(config.rootDir, raw);
}

function mergeEntryRanges(
  a: FileCoverageEntry['ranges'],
  b: FileCoverageEntry['ranges'],
): FileCoverageEntry['ranges'] {
  return mergeRanges([...a, ...b]);
}
