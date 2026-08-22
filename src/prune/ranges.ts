import type { ByteRange } from '../report/types.js';
import { invertRanges, mergeRanges, subtractRanges } from '../report/merge.js';
import { removeUncoveredRangesAst } from './ast-prune.js';
import { pruneCss } from './css.js';

export type RemoveUncoveredOptions = {
  preserveLicenseHeader?: boolean;
  /** Uncovered ranges inside executed functions — replaced, not deleted */
  stubRanges?: ByteRange[];
  kind?: 'js' | 'css';
  /** CSS only: regex sources; matching selectors/preludes are always kept */
  cssSafelist?: string[];
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
      const licenseEnd = detectLicenseHeaderEnd(source, 0);
      const header = source.slice(0, licenseEnd);
      if (licenseEnd > 0 && !pruned.startsWith(header)) {
        return header + pruned;
      }
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
  let result = source;

  for (const op of ops) {
    const replacement =
      op.kind === 'stub' ? stubReplacement(source, op.start, op.end) : '';
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
export function stubReplacement(source: string, start: number, end: number): string {
  const text = source.slice(start, end);
  const elseMatch = text.match(/^(\s*)else\b/);
  if (elseMatch) {
    return `${elseMatch[1]}else {}`;
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return '{}';
  }
  if (text.includes('\n')) {
    return '{}';
  }
  return '0';
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
