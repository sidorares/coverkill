import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ResolvedCoverkillConfig } from '../config/types.js';
import { mergeRanges } from '../coverage/merge.js';
import type { CoverageReport, FileCoverageEntry } from '../coverage/types.js';
import { createMatchers } from '../utils/globs.js';
import { contentMatchesDisk, defaultSourcePath } from '../utils/paths.js';

export type ResolvedPruneTarget = {
  filePath: string;
  source: string;
  ranges: FileCoverageEntry['ranges'];
  stubRanges: FileCoverageEntry['stubRanges'];
  kind: 'js' | 'css';
  url: string;
};

export type ResolveResult = {
  targets: ResolvedPruneTarget[];
  skipped: Array<{ url: string; reason: string }>;
};

export async function resolvePruneTargets(
  report: CoverageReport,
  config: ResolvedCoverkillConfig,
): Promise<ResolveResult> {
  const { isIncluded } = createMatchers(config.rootDir, config.include, config.exclude);
  const targets: ResolvedPruneTarget[] = [];
  const skipped: ResolveResult['skipped'] = [];
  const byPath = new Map<string, ResolvedPruneTarget>();

  for (const entry of report.entries) {
    const filePath = resolveFilePath(entry.url, config);
    if (!filePath) {
      skipped.push({ url: entry.url, reason: 'no sourcePath mapping' });
      continue;
    }

    if (!isIncluded(filePath)) {
      skipped.push({ url: entry.url, reason: 'not in include allowlist' });
      continue;
    }

    if (entry.ranges.length === 0) {
      skipped.push({ url: entry.url, reason: 'no covered ranges (skipped for safety)' });
      continue;
    }

    let source: string;
    try {
      source = await readFile(filePath, 'utf8');
    } catch {
      if (entry.source) {
        source = entry.source;
      } else {
        skipped.push({ url: entry.url, reason: `file not found: ${filePath}` });
        continue;
      }
    }

    if (entry.source && !contentMatchesDisk(entry.source, source)) {
      skipped.push({
        url: entry.url,
        reason: `on-disk content does not match coverage source for ${filePath}`,
      });
      continue;
    }

    const existing = byPath.get(filePath);
    if (existing) {
      existing.ranges = mergeEntryRanges(existing.ranges, entry.ranges);
      existing.stubRanges = mergeEntryRanges(existing.stubRanges ?? [], entry.stubRanges ?? []);
    } else {
      const target: ResolvedPruneTarget = {
        filePath,
        source,
        ranges: [...entry.ranges],
        stubRanges: entry.stubRanges ? [...entry.stubRanges] : [],
        kind: entry.kind,
        url: entry.url,
      };
      byPath.set(filePath, target);
      targets.push(target);
    }
  }

  return { targets, skipped };
}

function resolveFilePath(url: string, config: ResolvedCoverkillConfig): string | null {
  const custom = config.sourcePath?.(url);
  const raw = custom ?? defaultSourcePath(url, config.rootDir);
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(config.rootDir, raw);
}

function mergeEntryRanges(
  a: FileCoverageEntry['ranges'],
  b: FileCoverageEntry['ranges'],
): FileCoverageEntry['ranges'] {
  return mergeRanges([...a, ...b]);
}
