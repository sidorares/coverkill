import type { ByteRange } from './types.js';

export function mergeRanges(ranges: ByteRange[]): ByteRange[] {
  if (ranges.length === 0) return [];

  const sorted = ranges
    .filter((r) => r.end > r.start)
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (sorted.length === 0) return [];

  const merged: ByteRange[] = [sorted[0]!];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

/** Remove `subtract` ranges from `ranges` (both should be merged for best results). */
export function subtractRanges(ranges: ByteRange[], subtract: ByteRange[]): ByteRange[] {
  if (ranges.length === 0 || subtract.length === 0) return ranges;

  const merged = mergeRanges(ranges);
  const holes = mergeRanges(subtract);
  const result: ByteRange[] = [];

  for (const range of merged) {
    let pos = range.start;
    for (const hole of holes) {
      if (hole.end <= pos || hole.start >= range.end) continue;
      const holeStart = Math.max(hole.start, pos);
      const holeEnd = Math.min(hole.end, range.end);
      if (holeStart > pos) {
        result.push({ start: pos, end: holeStart });
      }
      pos = holeEnd;
    }
    if (pos < range.end) {
      result.push({ start: pos, end: range.end });
    }
  }

  return result;
}

export function invertRanges(length: number, covered: ByteRange[]): ByteRange[] {
  const merged = mergeRanges(covered);
  const uncovered: ByteRange[] = [];
  let pos = 0;

  for (const range of merged) {
    if (range.start > pos) {
      uncovered.push({ start: pos, end: range.start });
    }
    pos = Math.max(pos, range.end);
  }

  if (pos < length) {
    uncovered.push({ start: pos, end: length });
  }

  return uncovered;
}

export function rangesToLineNumbers(source: string, ranges: ByteRange[]): number[] {
  const lineStarts = getLineStarts(source);
  const lines = new Set<number>();

  for (const range of ranges) {
    const startLine = offsetToLine(lineStarts, range.start);
    const endLine = offsetToLine(lineStarts, Math.max(range.start, range.end - 1));
    for (let line = startLine; line <= endLine; line++) {
      lines.add(line);
    }
  }

  return [...lines].sort((a, b) => a - b);
}

function getLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

function offsetToLine(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (lineStarts[mid]! <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low + 1;
}
