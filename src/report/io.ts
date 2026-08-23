import { readFile, stat, writeFile } from 'node:fs/promises';
import { importV8CoverageFiles } from './import.js';
import type {
  ByteRange,
  CoverageReport,
  CoverageReportV1,
  CoverageReportV2,
  FileCoverageEntry,
  ScriptCoverageEntry,
  StyleSheetCoverageEntry,
} from './types.js';

export async function saveReport(report: CoverageReport, filePath: string): Promise<void> {
  await writeFile(filePath, JSON.stringify(report, null, 2), 'utf8');
}

/**
 * Load a coverage report. Accepts coverkill's own v1 and v2 reports, and —
 * so external coverage can be pruned directly — raw V8 / DevTools JSON: a
 * `NODE_V8_COVERAGE` directory, one of its dumps, a CDP result, or a
 * Playwright/Puppeteer/DevTools coverage export.
 */
export async function loadReport(filePath: string): Promise<CoverageReport> {
  const info = await stat(filePath).catch(() => null);
  if (info?.isDirectory()) {
    return importV8CoverageFiles([filePath]);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (err) {
    throw new Error(
      `Failed to read coverage report ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!isCoverkillReport(raw)) {
    return importV8CoverageFiles([filePath]);
  }
  return validateReport(raw, filePath);
}

function isCoverkillReport(raw: unknown): boolean {
  return Boolean(raw) && typeof raw === 'object' && 'version' in (raw as object);
}

export function validateReport(raw: unknown, sourceName = 'report'): CoverageReport {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${sourceName}: coverage report must be a JSON object.`);
  }
  const version = (raw as { version?: unknown }).version;
  if (version === 1) return validateReportV1(raw as Partial<CoverageReportV1>, sourceName);
  if (version === 2) return validateReportV2(raw as Partial<CoverageReportV2>, sourceName);
  throw new Error(`${sourceName}: unsupported report version: ${String(version)}`);
}

function validateReportV1(report: Partial<CoverageReportV1>, sourceName: string): CoverageReportV1 {
  if (typeof report.rootDir !== 'string') {
    throw new Error(`${sourceName}: missing rootDir.`);
  }
  if (!Array.isArray(report.entries)) {
    throw new Error(`${sourceName}: missing entries array.`);
  }
  report.entries.forEach((entry, i) => validateEntry(entry, `${sourceName}: entries[${i}]`));
  return report as CoverageReportV1;
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

function validateReportV2(report: Partial<CoverageReportV2>, sourceName: string): CoverageReportV2 {
  if (typeof report.rootDir !== 'string') {
    throw new Error(`${sourceName}: missing rootDir.`);
  }
  const meta = report.meta as CoverageReportV2['meta'] | undefined;
  if (!meta || typeof meta !== 'object') {
    throw new Error(`${sourceName}: missing meta object.`);
  }
  // Offsets are the whole contract: a report measured in bytes or UTF-8 code
  // units would silently misplace every edit on any file with astral chars.
  if (meta.offsets !== 'utf16CodeUnits') {
    throw new Error(
      `${sourceName}: meta.offsets must be "utf16CodeUnits", got ${JSON.stringify(meta.offsets)}.`,
    );
  }
  if (typeof meta.collectedAt !== 'string') {
    throw new Error(`${sourceName}: missing meta.collectedAt.`);
  }
  if (!Array.isArray(report.scripts)) {
    throw new Error(`${sourceName}: missing scripts array.`);
  }
  if (report.stylesheets === undefined) {
    report.stylesheets = [];
  }
  if (!Array.isArray(report.stylesheets)) {
    throw new Error(`${sourceName}: stylesheets must be an array.`);
  }
  report.scripts.forEach((script, i) => validateScript(script, `${sourceName}: scripts[${i}]`));
  report.stylesheets.forEach((sheet, i) =>
    validateStyleSheet(sheet, `${sourceName}: stylesheets[${i}]`),
  );
  return report as CoverageReportV2;
}

function validateScript(script: unknown, label: string): asserts script is ScriptCoverageEntry {
  if (!script || typeof script !== 'object') {
    throw new Error(`${label}: must be an object.`);
  }
  const s = script as Partial<ScriptCoverageEntry>;
  if (typeof s.url !== 'string') {
    throw new Error(`${label}: missing url.`);
  }
  validateSourceFields(s, label);
  if (s.sourceType !== undefined && s.sourceType !== 'script' && s.sourceType !== 'module') {
    throw new Error(`${label}: sourceType must be "script" or "module".`);
  }
  if (!Array.isArray(s.functions)) {
    throw new Error(`${label}: missing functions array.`);
  }
  const limit = s.source?.length;
  s.functions.forEach((fn, i) => {
    const f = fn as Partial<ScriptCoverageEntry['functions'][number]>;
    if (!f || typeof f !== 'object') {
      throw new Error(`${label}.functions[${i}]: must be an object.`);
    }
    if (typeof f.functionName !== 'string') {
      throw new Error(`${label}.functions[${i}]: missing functionName.`);
    }
    if (!Array.isArray(f.ranges)) {
      throw new Error(`${label}.functions[${i}]: missing ranges array.`);
    }
    f.ranges.forEach((r, j) => {
      const range = r as { startOffset?: unknown; endOffset?: unknown; count?: unknown };
      if (
        !Number.isInteger(range.startOffset) ||
        !Number.isInteger(range.endOffset) ||
        !Number.isInteger(range.count)
      ) {
        throw new Error(
          `${label}.functions[${i}].ranges[${j}]: startOffset/endOffset/count must be integers.`,
        );
      }
      const start = range.startOffset as number;
      const end = range.endOffset as number;
      if (start < 0 || end < start) {
        throw new Error(`${label}.functions[${i}].ranges[${j}]: invalid range ${start}..${end}.`);
      }
      if (limit !== undefined && end > limit) {
        throw new Error(
          `${label}.functions[${i}].ranges[${j}]: range ${start}..${end} exceeds source length ${limit}.`,
        );
      }
    });
  });
}

function validateStyleSheet(
  sheet: unknown,
  label: string,
): asserts sheet is StyleSheetCoverageEntry {
  if (!sheet || typeof sheet !== 'object') {
    throw new Error(`${label}: must be an object.`);
  }
  const s = sheet as Partial<StyleSheetCoverageEntry>;
  if (typeof s.url !== 'string') {
    throw new Error(`${label}: missing url.`);
  }
  validateSourceFields(s, label);
  validateRanges(s.ranges, s.source?.length, `${label}.ranges`);
}

function validateSourceFields(
  entry: { source?: unknown; sourceHash?: unknown },
  label: string,
): void {
  if (entry.source !== undefined && typeof entry.source !== 'string') {
    throw new Error(`${label}: source must be a string when present.`);
  }
  if (entry.sourceHash !== undefined && typeof entry.sourceHash !== 'string') {
    throw new Error(`${label}: sourceHash must be a string when present.`);
  }
}

function validateRanges(
  ranges: unknown,
  sourceLength: number | undefined,
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
    if (sourceLength !== undefined && range.end > sourceLength) {
      throw new Error(
        `${label}[${i}]: range ${range.start}..${range.end} exceeds source length ${sourceLength}.`,
      );
    }
  });
}
