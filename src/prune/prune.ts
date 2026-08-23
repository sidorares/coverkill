import { writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { ResolvedPruneConfig } from '../config/types.js';
import type { CoverageReport } from '../report/types.js';
import type { NormalizedReport } from '../report/normalize.js';
import { invertRanges, rangesToLineNumbers } from '../report/merge.js';
import { resolvePruneTargets, type ResolvedPruneTarget } from './resolve.js';
import { isParseableJs } from './ast-prune.js';
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
  report: CoverageReport | NormalizedReport,
  config: ResolvedPruneConfig,
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
  config: ResolvedPruneConfig,
  options: PruneOptions,
): Promise<PruneFileResult> {
  const bytesBefore = Buffer.byteLength(target.source, 'utf8');
  let pruned = removeUncoveredRanges(target.source, target.ranges, {
    preserveLicenseHeader: config.preserveLicenseHeader,
    stubRanges: target.kind === 'js' ? target.stubRanges : undefined,
    kind: target.kind,
    sourceType: target.kind === 'js' ? target.sourceType : undefined,
    cssSafelist: config.cssSafelist,
    pruneMode: target.kind === 'js' ? config.pruneMode : undefined,
    stubLabel: stubLabelFor(config.rootDir, target.filePath),
  });

  if (
    target.kind === 'js' &&
    pruned !== target.source &&
    !isParseableJs(pruned, target.sourceType)
  ) {
    console.warn(
      `[coverkill] ${target.filePath}: pruned output is invalid JS; file left unchanged.`,
    );
    pruned = target.source;
  }
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

/** Loud stubs cite `label:line`; a rootDir-relative path keeps it greppable. */
function stubLabelFor(rootDir: string, filePath: string): string {
  const relative = path.relative(rootDir, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative
    : filePath;
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
