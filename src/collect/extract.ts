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

type Segment = { start: number; end: number; count: number; isScriptRoot?: boolean };

type FnSpan = { start: number; end: number; executed: boolean };

/**
 * Flatten V8 block coverage into covered/stub byte ranges.
 *
 * V8 reports one entry per function, each with nested ranges where the
 * INNERMOST range containing an offset determines its execution count. Chrome
 * always emits a whole-script entry (functionName "") whose single range spans
 * the entire source with count 1, so a naive "count > 0 means covered" pass
 * would mark everything covered. Instead we:
 *
 * 1. Sweep all ranges (sorted outer-first) with a stack to produce disjoint
 *    segments whose count comes from the innermost enclosing range.
 * 2. Segments with count > 0 are `covered`.
 * 3. Count-0 segments are classified by their innermost enclosing FUNCTION
 *    (each function's root range, ranges[0]): if that function executed, the
 *    segment is an unexecuted branch inside live code and becomes `stub`; if
 *    it never executed, the segment is dead code and is reported as neither
 *    (the pruner deletes what is neither covered nor stub).
 */
export function extractJsCoverage(entry: JsCoverageEntry): {
  covered: ByteRange[];
  stub: ByteRange[];
} {
  let maxEnd = 0;
  for (const fn of entry.functions) {
    for (const r of fn.ranges) {
      if (r.endOffset > maxEnd) maxEnd = r.endOffset;
    }
  }

  const ranges: Segment[] = [];
  for (const fn of entry.functions) {
    // The whole-script entry ("" spanning everything) is the outermost node of
    // the range tree; flag its root so a dead function whose span happens to
    // be byte-identical (script with no trailing newline) still nests inside.
    // count > 0 distinguishes the real script root from a dead anonymous
    // function that happens to span the whole file.
    const isScriptRoot =
      fn.functionName === '' &&
      fn.ranges[0]?.startOffset === 0 &&
      fn.ranges[0]?.endOffset === maxEnd &&
      fn.ranges[0]!.count > 0;
    fn.ranges.forEach((r, i) => {
      if (r.endOffset > r.startOffset) {
        ranges.push({
          start: r.startOffset,
          end: r.endOffset,
          count: r.count,
          isScriptRoot: isScriptRoot && i === 0,
        });
      }
    });
  }
  if (ranges.length === 0) return { covered: [], stub: [] };

  const segments = flattenRanges(ranges);

  const covered: ByteRange[] = [];
  const uncovered: Segment[] = [];
  for (const seg of segments) {
    if (seg.count > 0) {
      covered.push({ start: seg.start, end: seg.end });
    } else {
      uncovered.push(seg);
    }
  }

  const stub: ByteRange[] = uncovered.length > 0 ? classifyStubs(entry, uncovered) : [];

  return { covered: mergeRanges(covered), stub: mergeRanges(stub) };
}

/**
 * Turn overlapping nested ranges into disjoint segments where each segment's
 * count is the count of the innermost range containing it. Sort outer ranges
 * first (start asc, end desc) and sweep with a stack; for identical spans the
 * executed range sorts last so it lands on top of the stack and wins.
 * Offsets covered by no range at all produce no segment.
 */
function flattenRanges(ranges: Segment[]): Segment[] {
  const sorted = [...ranges].sort(
    (a, b) =>
      a.start - b.start ||
      b.end - a.end ||
      Number(b.isScriptRoot ?? false) - Number(a.isScriptRoot ?? false) ||
      a.count - b.count,
  );

  const segments: Segment[] = [];
  const stack: Segment[] = [];
  let pos = sorted[0]!.start;

  const emit = (end: number, count: number) => {
    if (end > pos) {
      segments.push({ start: pos, end, count });
      pos = end;
    }
  };

  for (const range of sorted) {
    while (stack.length > 0 && stack[stack.length - 1]!.end <= range.start) {
      const top = stack.pop()!;
      emit(top.end, top.count);
    }
    if (stack.length > 0) {
      emit(range.start, stack[stack.length - 1]!.count);
    }
    pos = Math.max(pos, range.start);
    stack.push(range);
  }
  while (stack.length > 0) {
    const top = stack.pop()!;
    emit(top.end, top.count);
  }

  return segments;
}

/**
 * For each count-0 segment, find the innermost function whose root range
 * (ranges[0], the full function span) contains it. Segments inside an
 * executed function are stubs; segments whose innermost function never ran
 * are dead code and are dropped. Both lists are sorted by start, so a single
 * forward sweep with a stack of open functions suffices.
 */
function classifyStubs(entry: JsCoverageEntry, uncovered: Segment[]): ByteRange[] {
  const fns: FnSpan[] = [];
  for (const fn of entry.functions) {
    const root = fn.ranges[0];
    if (!root || root.endOffset <= root.startOffset) continue;
    fns.push({
      start: root.startOffset,
      end: root.endOffset,
      executed: fn.ranges.some((r) => r.count > 0),
    });
  }
  // Outer functions first; for identical spans put the dead one innermost so
  // dead code stays deletable.
  fns.sort(
    (a, b) => a.start - b.start || b.end - a.end || Number(b.executed) - Number(a.executed),
  );

  const stub: ByteRange[] = [];
  const stack: FnSpan[] = [];
  let next = 0;

  for (const seg of uncovered) {
    while (next < fns.length && fns[next]!.start <= seg.start) {
      while (stack.length > 0 && stack[stack.length - 1]!.end <= fns[next]!.start) {
        stack.pop();
      }
      stack.push(fns[next]!);
      next++;
    }
    while (stack.length > 0 && stack[stack.length - 1]!.end <= seg.start) {
      stack.pop();
    }

    let enclosing: FnSpan | undefined;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i]!.end >= seg.end) {
        enclosing = stack[i];
        break;
      }
    }

    if (enclosing?.executed) {
      stub.push({ start: seg.start, end: seg.end });
    }
  }

  return stub;
}
