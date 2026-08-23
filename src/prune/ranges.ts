import type { ByteRange, SourceType } from '../report/types.js';
import { invertRanges, mergeRanges, subtractRanges } from '../report/merge.js';
import { removeUncoveredRangesAst } from './ast-prune.js';
import { pruneCss } from './css.js';
import { StubAnnouncer, type PruneMode } from './stubs.js';

export type RemoveUncoveredOptions = {
  preserveLicenseHeader?: boolean;
  /** Uncovered ranges inside executed functions — replaced, not deleted */
  stubRanges?: ByteRange[];
  kind?: 'js' | 'css';
  /** JS only: parse goal, when the report knew it. Falls back to detection. */
  sourceType?: SourceType;
  /** CSS only: regex sources; matching selectors/preludes are always kept */
  cssSafelist?: string[];
  /**
   * JS only: how a pruned-but-still-reachable path behaves at runtime.
   * 'silent' (default) keeps the byte-minimal no-op stubs; 'throw' makes every
   * stub throw when executed; 'beacon' calls
   * `globalThis.__coverkillPrunedPathHit?.(location)` and then behaves like the
   * silent stub.
   */
  pruneMode?: PruneMode;
  /** JS only: file label used in loud stub locations (`label:line`). */
  stubLabel?: string;
};

export function removeUncoveredRanges(
  source: string,
  covered: ByteRange[],
  options?: RemoveUncoveredOptions,
): string {
  if (covered.length === 0) {
    return source;
  }

  const kind = options?.kind ?? 'js';

  if (kind === 'css') {
    const pruned = pruneCss(source, mergeRanges(covered), { safelist: options?.cssSafelist });
    if (options?.preserveLicenseHeader && pruned !== source) {
      return reattachCssLicenseHeader(source, pruned);
    }
    return pruned;
  }

  const astResult = removeUncoveredRangesAst(source, covered, options);
  if (astResult !== null) {
    return astResult;
  }
  if (process.env.COVERKILL_BYTE_PRUNE === '1') {
    console.warn(
      '[coverkill] AST prune failed; falling back to byte pruning (COVERKILL_BYTE_PRUNE=1).',
    );
  } else {
    console.warn(
      '[coverkill] AST prune failed (source does not parse as JS); leaving file unchanged. Set COVERKILL_BYTE_PRUNE=1 to force legacy byte pruning.',
    );
    return source;
  }

  const merged = mergeRanges(covered);
  let protectedEnd = 0;

  if (source.startsWith('#!')) {
    const shebangEnd = source.indexOf('\n');
    protectedEnd = shebangEnd === -1 ? source.length : shebangEnd + 1;
  }

  if (options?.preserveLicenseHeader) {
    const licenseEnd = detectLicenseHeaderEnd(source, protectedEnd);
    protectedEnd = Math.max(protectedEnd, licenseEnd);
  }

  // Covered-wins: a range that executed anywhere is never stubbed out.
  const stubs = subtractRanges(mergeRanges(options?.stubRanges ?? []), merged);

  const adjustedCovered =
    protectedEnd > 0
      ? mergeRanges([{ start: 0, end: protectedEnd }, ...merged])
      : merged;

  const uncovered = invertRanges(source.length, adjustedCovered);
  const ops = buildPruneOps(uncovered, stubs);
  const announcer = new StubAnnouncer(source, options?.pruneMode, options?.stubLabel);
  let result = source;

  for (const op of ops) {
    const replacement =
      op.kind === 'stub' ? stubReplacement(source, op.start, op.end, announcer) : '';
    result = result.slice(0, op.start) + replacement + result.slice(op.end);
  }

  return postProcess(result);
}

type PruneOp = { kind: 'delete' | 'stub'; start: number; end: number };

function buildPruneOps(uncovered: ByteRange[], stubs: ByteRange[]): PruneOp[] {
  const ops: PruneOp[] = [];

  for (const u of uncovered) {
    let pos = u.start;
    for (const stub of stubs) {
      if (stub.end <= pos || stub.start >= u.end) continue;
      const stubStart = Math.max(stub.start, pos);
      const stubEnd = Math.min(stub.end, u.end);
      if (stubStart > pos) {
        ops.push({ kind: 'delete', start: pos, end: stubStart });
      }
      ops.push({ kind: 'stub', start: stubStart, end: stubEnd });
      pos = stubEnd;
    }
    if (pos < u.end) {
      ops.push({ kind: 'delete', start: pos, end: u.end });
    }
  }

  return ops.sort((a, b) => b.start - a.start);
}

/** Replace an uncovered branch/block while keeping surrounding syntax valid. */
export function stubReplacement(
  source: string,
  start: number,
  end: number,
  announcer?: StubAnnouncer,
): string {
  const text = source.slice(start, end);
  const announce = announcer?.statement(start) ?? '';
  const elseMatch = text.match(/^(\s*)else\b/);
  if (elseMatch) {
    return `${elseMatch[1]}else {${announce ? ` ${announce} ` : ''}}`;
  }
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || text.includes('\n')) {
    return announce ? `{ ${announce} }` : '{}';
  }
  return announcer?.expression(start, '0') ?? '0';
}

/**
 * pruneCss drops standalone comments, so a leading license banner must be
 * re-attached. Per spec @charset must be the very first bytes of a sheet,
 * making "@charset, then the banner" the only other valid layout.
 */
function reattachCssLicenseHeader(source: string, pruned: string): string {
  const charset = source.match(/^@charset\s+"[^"]*";\r?\n?/);
  const headerStart = charset ? charset[0].length : 0;
  const headerEnd = detectLicenseHeaderEnd(source, headerStart);
  if (headerEnd <= headerStart) return pruned;
  const header = source.slice(headerStart, headerEnd);
  if (pruned.includes(header.trim())) return pruned;

  if (charset && pruned.startsWith(charset[0].trimEnd())) {
    const insertAt = pruned.startsWith(charset[0]) ? charset[0].length : charset[0].trimEnd().length;
    return `${pruned.slice(0, insertAt)}\n${header}${pruned.slice(insertAt)}`;
  }
  return header + pruned;
}

function detectLicenseHeaderEnd(source: string, fromOffset: number): number {
  const slice = source.slice(fromOffset);
  const block = slice.match(/^\s*\/\*[\s\S]*?\*\//);
  if (block) {
    let end = fromOffset + block[0].length;
    if (source[end] === '\r' && source[end + 1] === '\n') end += 2;
    else if (source[end] === '\n') end += 1;
    return end;
  }
  const line = slice.match(/^\s*\/\/[^\n]*\n/);
  if (line) {
    return fromOffset + line[0].length;
  }
  return fromOffset;
}

function postProcess(source: string): string {
  return source
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\s+$/gm, '');
}
