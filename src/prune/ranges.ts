import type { ByteRange } from '../coverage/types.js';
import { invertRanges, mergeRanges } from '../coverage/merge.js';

export function removeUncoveredRanges(
  source: string,
  covered: ByteRange[],
  options?: { preserveLicenseHeader?: boolean },
): string {
  if (covered.length === 0) {
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

  const adjustedCovered =
    protectedEnd > 0
      ? mergeRanges([{ start: 0, end: protectedEnd }, ...merged])
      : merged;

  const uncovered = invertRanges(source.length, adjustedCovered);
  let result = source;

  for (let i = uncovered.length - 1; i >= 0; i--) {
    const range = uncovered[i]!;
    result = result.slice(0, range.start) + result.slice(range.end);
  }

  return postProcess(result);
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
