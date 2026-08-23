import { readFile, writeFile } from 'node:fs/promises';
import type { ByteRange, CoverageReport, FileCoverageEntry } from './types.js';

export async function saveReport(report: CoverageReport, filePath: string): Promise<void> {
  await writeFile(filePath, JSON.stringify(report, null, 2), 'utf8');
}

export async function loadReport(filePath: string): Promise<CoverageReport> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (err) {
    throw new Error(
      `Failed to read coverage report ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateReport(raw, filePath);
}

export function validateReport(raw: unknown, sourceName = 'report'): CoverageReport {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${sourceName}: coverage report must be a JSON object.`);
  }
  const report = raw as Partial<CoverageReport>;
  if (report.version !== 1) {
    throw new Error(`${sourceName}: unsupported report version: ${String(report.version)}`);
  }
  if (typeof report.rootDir !== 'string') {
    throw new Error(`${sourceName}: missing rootDir.`);
  }
  if (!Array.isArray(report.entries)) {
    throw new Error(`${sourceName}: missing entries array.`);
  }
  report.entries.forEach((entry, i) => validateEntry(entry, `${sourceName}: entries[${i}]`));
  return report as CoverageReport;
}

function validateEntry(entry: unknown, label: string): asserts entry is FileCoverageEntry {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`${label}: must be an object.`);
  }
  const e = entry as Partial<FileCoverageEntry>;
  if (typeof e.url !== 'string') {
    throw new Error(`${label}: missing url.`);
  }
  if (e.kind !== 'js' && e.kind !== 'css') {
    throw new Error(`${label}: kind must be "js" or "css".`);
  }
  if (typeof e.source !== 'string') {
    throw new Error(`${label}: missing source text.`);
  }
  validateRanges(e.ranges, e.source.length, `${label}.ranges`);
  if (e.stubRanges !== undefined) {
    validateRanges(e.stubRanges, e.source.length, `${label}.stubRanges`);
  }
}

function validateRanges(
  ranges: unknown,
  sourceLength: number,
  label: string,
): asserts ranges is ByteRange[] {
  if (!Array.isArray(ranges)) {
    throw new Error(`${label}: must be an array of {start, end}.`);
  }
  ranges.forEach((r, i) => {
    const range = r as Partial<ByteRange>;
    if (
      typeof range.start !== 'number' ||
      typeof range.end !== 'number' ||
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end)
    ) {
      throw new Error(`${label}[${i}]: start/end must be integers.`);
    }
    if (range.start < 0 || range.end < range.start) {
      throw new Error(`${label}[${i}]: invalid range ${range.start}..${range.end}.`);
    }
    if (range.end > sourceLength) {
      throw new Error(
        `${label}[${i}]: range ${range.start}..${range.end} exceeds source length ${sourceLength}.`,
      );
    }
  });
}
