import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashSource } from './hash.js';
import { mergeRanges } from './merge.js';
import type {
  ByteRange,
  CoverageReportV2,
  ScriptCoverageEntry,
  StyleSheetCoverageEntry,
  V8FunctionCoverage,
} from './types.js';
import { coverkillVersion } from '../version.js';

export type ImportOptions = {
  rootDir?: string;
  /** Free-form provenance label recorded in `meta.source`. */
  label?: string;
  /** ISO timestamp for `meta.collectedAt`; defaults to now. */
  collectedAt?: string;
  /** Name used in error messages. */
  sourceName?: string;
};

/**
 * Convert raw V8 / DevTools coverage JSON into a report v2. Accepted shapes:
 *
 * - `{ result: [...] }` — a `NODE_V8_COVERAGE` dump or a CDP
 *   `Profiler.takePreciseCoverage` result.
 * - `[ { url, functions, source? }, ... ]` — Playwright's
 *   `page.coverage.stopJSCoverage()` or Puppeteer's `JSCoverage` output.
 * - `[ { url, text, ranges }, ... ]` — Chrome DevTools' Coverage panel export,
 *   and Playwright's `stopCSSCoverage()`. These carry used ranges only, with
 *   no counts: every used range becomes an executed range and everything else
 *   is treated as never executed (the report-v1 model).
 */
export function importV8Coverage(raw: unknown, options: ImportOptions = {}): CoverageReportV2 {
  const name = options.sourceName ?? 'coverage input';
  const list = toEntryList(raw, name);

  const scripts: ScriptCoverageEntry[] = [];
  const stylesheets: StyleSheetCoverageEntry[] = [];

  for (const [i, item] of list.entries()) {
    if (!item || typeof item !== 'object') {
      throw new Error(`${name}: entry ${i} must be an object.`);
    }
    const entry = item as RawEntry;
    if (typeof entry.url !== 'string') {
      throw new Error(`${name}: entry ${i} has no url.`);
    }
    // Node's own internals are never prunable and only bloat the report.
    if (entry.url === '' || entry.url.startsWith('node:')) continue;

    const source = typeof entry.source === 'string' ? entry.source : entry.text;
    const sourceHash = typeof source === 'string' ? hashSource(source) : undefined;

    if (Array.isArray(entry.functions)) {
      scripts.push({
        url: entry.url,
        scriptId: entry.scriptId,
        sourceType:
          entry.sourceType === 'module' || entry.sourceType === 'script'
            ? entry.sourceType
            : undefined,
        sourceHash,
        source,
        functions: entry.functions as V8FunctionCoverage[],
      });
      continue;
    }

    if (!Array.isArray(entry.ranges)) {
      throw new Error(
        `${name}: entry ${i} (${entry.url}) has neither a "functions" nor a "ranges" array.`,
      );
    }
    const ranges = normalizeUsedRanges(entry.ranges, `${name}: entry ${i}`);

    if (isCssUrl(entry.url)) {
      stylesheets.push({ url: entry.url, sourceHash, source, ranges });
    } else {
      scripts.push({
        url: entry.url,
        scriptId: entry.scriptId,
        sourceHash,
        source,
        functions: usedRangesAsFunctions(ranges),
      });
    }
  }

  return {
    version: 2,
    meta: {
      coverkillVersion: coverkillVersion(),
      collectedAt: options.collectedAt ?? new Date().toISOString(),
      offsets: 'utf16CodeUnits',
      source: options.label,
    },
    rootDir: options.rootDir ?? process.cwd(),
    scripts,
    stylesheets,
  };
}

type RawEntry = {
  url?: unknown;
  scriptId?: string;
  sourceType?: unknown;
  source?: unknown;
  text?: string;
  functions?: unknown;
  ranges?: unknown;
};

function toEntryList(raw: unknown, name: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray((raw as { result?: unknown }).result)) {
    return (raw as { result: unknown[] }).result;
  }
  throw new Error(
    `${name}: expected a V8 coverage array or an object with a "result" array.`,
  );
}

function normalizeUsedRanges(raw: unknown[], label: string): ByteRange[] {
  const ranges: ByteRange[] = raw.map((r, i) => {
    const range = r as { start?: unknown; end?: unknown };
    if (typeof range.start !== 'number' || typeof range.end !== 'number') {
      throw new Error(`${label}: ranges[${i}] must have numeric start/end.`);
    }
    return { start: range.start, end: range.end };
  });
  return mergeRanges(ranges);
}

/**
 * Used-ranges-only input carries no counts, so there is no way to tell an
 * unexecuted branch from a dead function. Emitting each used range as its own
 * count-1 entry (with no whole-script range) makes the flattener produce
 * exactly those ranges as covered and nothing as a stub — offsets belonging to
 * no range at all yield no segment, which is precisely "no data, treat as
 * never executed".
 */
function usedRangesAsFunctions(ranges: ByteRange[]): V8FunctionCoverage[] {
  return ranges.map((r) => ({
    functionName: '',
    isBlockCoverage: false,
    ranges: [{ startOffset: r.start, endOffset: r.end, count: 1 }],
  }));
}

function isCssUrl(url: string): boolean {
  const withoutQuery = url.split(/[?#]/)[0] ?? url;
  return withoutQuery.toLowerCase().endsWith('.css');
}

/** Concatenate v2 reports; the resolver unions ranges per file (covered-wins). */
export function mergeV2Reports(reports: CoverageReportV2[], rootDir?: string): CoverageReportV2 {
  const first = reports[0];
  return {
    version: 2,
    meta: {
      coverkillVersion: coverkillVersion(),
      collectedAt: first?.meta.collectedAt ?? new Date().toISOString(),
      offsets: 'utf16CodeUnits',
      source: first?.meta.source,
    },
    rootDir: rootDir ?? first?.rootDir ?? process.cwd(),
    scripts: reports.flatMap((r) => r.scripts),
    stylesheets: reports.flatMap((r) => r.stylesheets),
  };
}

export type ImportFilesOptions = ImportOptions & {
  /** Drop embedded source text, keeping only its hash, to shrink the report. */
  stripSource?: boolean;
};

/**
 * Import raw coverage from files and/or `NODE_V8_COVERAGE` directories.
 *
 * Entries that carry no source text get a `sourceHash` read from disk when
 * their URL is a `file://` URL, so the prune-time guard can still prove the
 * file has not changed since import. Entries whose source cannot be recovered
 * stay hash-less and the resolver will refuse to prune them.
 */
export async function importV8CoverageFiles(
  inputs: string[],
  options: ImportFilesOptions = {},
): Promise<CoverageReportV2> {
  const files = await expandInputs(inputs);
  if (files.length === 0) {
    throw new Error(`No coverage JSON files found in: ${inputs.join(', ')}`);
  }

  const reports: CoverageReportV2[] = [];
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      throw new Error(
        `Failed to read coverage input ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    reports.push(importV8Coverage(raw, { ...options, sourceName: file }));
  }

  const merged = mergeV2Reports(reports, options.rootDir);
  await hydrateFromDisk(merged, options.stripSource ?? false);
  return merged;
}

async function hydrateFromDisk(report: CoverageReportV2, stripSource: boolean): Promise<void> {
  const cache = new Map<string, string | null>();

  const hydrate = async (
    entry: { url: string; source?: string; sourceHash?: string },
    fits: (text: string) => boolean,
  ) => {
    // The hash was computed from the text the input carried, so dropping the
    // text keeps the guard intact while shrinking the report.
    if (stripSource) delete entry.source;
    if (entry.sourceHash) return;
    const filePath = fileUrlToPath(entry.url);
    if (!filePath) return;
    if (!cache.has(filePath)) {
      cache.set(
        filePath,
        await readFile(filePath, 'utf8').catch(() => null),
      );
    }
    const text = cache.get(filePath);
    if (text == null) return;
    if (!fits(text)) {
      // The offsets cannot belong to this text, so hashing it would vouch for
      // the wrong coordinate space. Leaving the entry hash-less makes the
      // resolver skip the file instead of slicing it at shifted offsets.
      console.warn(
        `[coverkill] ${filePath} does not match the coverage offsets (edited since the run?); entry left unverifiable.`,
      );
      return;
    }
    // Hash only: the file on disk is evidence of what the offsets refer to,
    // not proof that this exact text executed. Recording the hash lets the
    // resolver detect any change between import and prune.
    entry.sourceHash = hashSource(text);
  };

  for (const script of report.scripts) {
    await hydrate(script, (text) => scriptOffsetsFit(script, text));
  }
  for (const sheet of report.stylesheets) {
    await hydrate(sheet, (text) => sheet.ranges.every((r) => r.end <= text.length));
  }
}

/**
 * V8 emits a whole-script range spanning exactly the text it compiled, so its
 * end offset is a free length check on the file we are about to vouch for —
 * the one drift signal available when the payload carries no source at all.
 */
function scriptOffsetsFit(script: ScriptCoverageEntry, text: string): boolean {
  let maxEnd = 0;
  for (const fn of script.functions) {
    for (const range of fn.ranges) {
      if (range.endOffset > maxEnd) maxEnd = range.endOffset;
    }
    const root = fn.ranges[0];
    if (fn.functionName === '' && root && root.startOffset === 0 && root.count > 0) {
      if (root.endOffset !== text.length) return false;
    }
  }
  return maxEnd <= text.length;
}

function fileUrlToPath(url: string): string | null {
  if (!url.startsWith('file://')) return null;
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

async function expandInputs(inputs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const input of inputs) {
    const info = await stat(input).catch(() => null);
    if (!info) throw new Error(`Coverage input not found: ${input}`);
    if (info.isDirectory()) {
      const names = (await readdir(input)).filter((n) => n.endsWith('.json')).sort();
      files.push(...names.map((n) => path.join(input, n)));
    } else {
      files.push(input);
    }
  }
  return files;
}
