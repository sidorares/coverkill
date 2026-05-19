import { writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { ResolvedCoverkillConfig } from '../config/types.js';
import type { CoverageReport } from '../coverage/types.js';
import { invertRanges, rangesToLineNumbers } from '../coverage/merge.js';
import { resolvePruneTargets, type ResolvedPruneTarget } from '../resolve/entries.js';
import { removeUncoveredRanges } from './ranges.js';

export type PruneOptions = {
  dryRun?: boolean;
};

export type PruneFileResult = {
  filePath: string;
  url: string;
  kind: 'js' | 'css';
  bytesBefore: number;
  bytesAfter: number;
  bytesRemoved: number;
  percentRemoved: number;
  uncoveredLines: number[];
  written: boolean;
};

export type PruneResult = {
  files: PruneFileResult[];
  skipped: Array<{ url: string; reason: string }>;
};

export async function pruneFromReport(
  report: CoverageReport,
  config: ResolvedCoverkillConfig,
  options: PruneOptions = {},
): Promise<PruneResult> {
  const { targets, skipped } = await resolvePruneTargets(report, config);
  const files: PruneFileResult[] = [];

  for (const target of targets) {
    const result = await pruneTarget(target, config, options);
    files.push(result);
  }

  return { files, skipped };
}

async function pruneTarget(
  target: ResolvedPruneTarget,
  config: ResolvedCoverkillConfig,
  options: PruneOptions,
): Promise<PruneFileResult> {
  const bytesBefore = Buffer.byteLength(target.source, 'utf8');
  const pruned = removeUncoveredRanges(target.source, target.ranges, {
    preserveLicenseHeader: config.preserveLicenseHeader,
    stubRanges: target.kind === 'js' ? target.stubRanges : undefined,
  });
  const bytesAfter = Buffer.byteLength(pruned, 'utf8');
  const uncovered = invertRanges(target.source.length, target.ranges);
  const uncoveredLines = rangesToLineNumbers(target.source, uncovered);

  let written = false;
  if (!options.dryRun && pruned !== target.source) {
    await writeFileAtomic(target.filePath, pruned);
    written = true;
  }

  const bytesRemoved = bytesBefore - bytesAfter;
  return {
    filePath: target.filePath,
    url: target.url,
    kind: target.kind,
    bytesBefore,
    bytesAfter,
    bytesRemoved,
    percentRemoved: bytesBefore > 0 ? (bytesRemoved / bytesBefore) * 100 : 0,
    uncoveredLines,
    written,
  };
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpName = `.coverkill-${randomBytes(8).toString('hex')}.tmp`;
  const tmpPath = path.join(dir, tmpName);
  await writeFile(tmpPath, content, 'utf8');
  try {
    await rename(tmpPath, filePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

export function formatPruneResult(result: PruneResult, dryRun: boolean): string {
  const lines: string[] = [];
  const prefix = dryRun ? '[dry-run] ' : '';

  for (const file of result.files) {
    lines.push(
      `${prefix}${file.filePath}: removed ${file.bytesRemoved} bytes (${file.percentRemoved.toFixed(1)}%)` +
        (file.uncoveredLines.length > 0
          ? ` — uncovered lines: ${summarizeLines(file.uncoveredLines)}`
          : '') +
        (file.written ? ' [written]' : ''),
    );
  }

  for (const skip of result.skipped) {
    lines.push(`skipped ${skip.url}: ${skip.reason}`);
  }

  return lines.join('\n');
}

function summarizeLines(lines: number[], max = 12): string {
  if (lines.length <= max) return lines.join(', ');
  return `${lines.slice(0, max).join(', ')}, … (+${lines.length - max} more)`;
}
