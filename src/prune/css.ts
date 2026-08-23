/**
 * Structure-aware CSS pruner driven by Chrome CSS coverage ranges.
 *
 * What Chrome (playwright `page.coverage.start/stopCSSCoverage`) ACTUALLY
 * reports — observed against a live chromium on 2026-08-22 with a probe
 * stylesheet (offsets are into the stylesheet text Chrome hands back):
 *
 *   [   0,   29) "body { color: rgb(1, 2, 3); }"            <- used style rule: the FULL rule
 *                                                              span, selector through closing `}`
 *   [  63,   82) "(min-width: 100px) "                      <- used @media: the CONDITION TEXT ONLY,
 *                                                              starting after `@media ` and ending
 *                                                              just before `{` (trailing space
 *                                                              included). The `@media` keyword and
 *                                                              both braces are NOT covered.
 *   [  86,  125) ".used-in-media { color: rgb(4, 5, 6); }"  <- used rule inside @media: full span
 *   [ 319,  367) ".spinner { animation: spin 1s linear infinite; }"
 *   [ 369,  416) ".btn:hover { outline: 1px solid rgb(7, 8, 9); }"   <- hovered during the session
 *   [ 565,  615) ".uses-font { font-family: \"CalFont\", sans-serif; }"
 *   [ 627,  643) "(display: flex) "                         <- nested @supports > @media: one
 *   [ 654,  672) "(min-width: 50px) "                          condition-only range per level
 *   [ 678,  709) ".nested-used { display: flex; }"
 *
 * Never reported at all, even when demonstrably in use:
 *   - @keyframes  (a running `animation: spin …` element was on screen)
 *   - @font-face  (its font-family was referenced by a kept, used rule)
 *   - @import statements
 * Unused rules and fully-unmatched @media blocks get no ranges — not even the
 * prelude. `:hover` rules are only reported if actually hovered.
 *
 * Consequence: raw byte-slicing the sheet down to the used ranges produces
 * `(min-width: 100px) .used-in-media { … }` — invalid CSS that browsers drop,
 * destroying styles that WERE used — and unconditionally deletes every
 * @keyframes/@font-face. Hence this pruner: parse the stylesheet into a rule
 * tree, keep a style rule iff its full [start, end) span intersects any used
 * range, keep a group at-rule iff any child is kept (rebuilding it as
 * `prelude { kept children }`), and always keep the constructs coverage
 * cannot see. Kept nodes are emitted verbatim from the source. Anything we
 * cannot parse falls back to returning the source unchanged.
 *
 * Two cascade-order subtleties (both confirmed against live Chrome):
 *
 *  - A used named `@layer name { … }` block is reported as one range from the
 *    name through the closing brace; an unused one gets no range at all. But a
 *    named layer block also DECLARES the layer's position in the layer order,
 *    so dropping it outright reorders the cascade (a later `@layer base {…}`
 *    re-declaration would then beat `@layer override`). A dropped named layer
 *    block is therefore replaced with the statement `@layer name;`, which
 *    preserves the declaration order at near-zero byte cost. Anonymous
 *    `@layer { … }` blocks have no re-declarable name and are dropped outright.
 *
 *  - `@import` is only honored before any other rule (and `@namespace` before
 *    any style/group rule); `@charset` only as the very first bytes. A
 *    mid-sheet `@import`/`@namespace` after a style rule is silently IGNORED
 *    by the browser — but if pruning deletes the rules ahead of it, keeping it
 *    would promote it into a valid position where it suddenly activates
 *    (fetching a never-loaded stylesheet, or turning on a default namespace
 *    that un-matches every kept selector). Such inert statements are dead code
 *    and are dropped. `@layer name-list;` statements and `@charset` do NOT end
 *    the import-valid region, but a `@layer { … }` BLOCK does (it is a rule).
 */

import type { ByteRange } from '../report/types.js';
import { mergeRanges } from '../report/merge.js';

export type PruneCssOptions = {
  /**
   * Regex source strings tested against each rule's trimmed prelude:
   * the selector text for style rules (e.g. `.btn:hover`), or the full
   * at-prelude including the keyword for group at-rules (e.g. `@media print`).
   * A safelisted rule is kept regardless of coverage; a safelisted group
   * at-rule keeps its whole block. Invalid patterns are ignored.
   */
  safelist?: string[];
};

type StyleRuleNode = {
  type: 'style';
  start: number;
  end: number;
  /** Index of the `{` opening the declaration block. */
  blockStart: number;
};

type AtGroupNode = {
  type: 'at-group';
  name: string;
  start: number;
  end: number;
  /** Index of the `{` opening the rule-list block. */
  blockStart: number;
  children: CssNode[];
};

/** Block at-rule treated as a single opaque unit (@font-face, @keyframes, …). */
type AtLeafNode = {
  type: 'at-leaf';
  name: string;
  start: number;
  end: number;
};

/** Semicolon-terminated at-rule (@import, @charset, @namespace, @layer a, b;). */
type AtStatementNode = {
  type: 'at-statement';
  name: string;
  start: number;
  end: number;
};

type CssNode = StyleRuleNode | AtGroupNode | AtLeafNode | AtStatementNode;

/** At-rules whose block is a nested rule list; kept iff any child is kept. */
const GROUP_AT_RULES = new Set([
  'media',
  'supports',
  'layer',
  'container',
  'scope',
  'document',
]);

/**
 * At-rules whose block is one opaque unit. Chrome CSS coverage never reports
 * these (verified for @font-face and @keyframes), so they are always kept.
 */
const LEAF_AT_RULES = new Set([
  'font-face',
  'keyframes',
  'page',
  'property',
  'counter-style',
  'font-feature-values',
  'viewport',
]);

/**
 * Statements the browser only honors near the top of the sheet: `@import`
 * before any other rule, `@namespace` before any style/group rule, `@charset`
 * as the very first bytes. Once the top-level walk has passed any block-bearing
 * rule these are inert, and emitting them could promote them into validity
 * (see the header comment). `@layer name-list;` statements are position-
 * independent and never filtered.
 */
const POSITION_DEPENDENT_STATEMENTS = new Set(['import', 'namespace', 'charset']);

class CssParseError extends Error {}

export function pruneCss(
  source: string,
  usedRanges: ByteRange[],
  options?: PruneCssOptions,
): string {
  // Safety convention shared with the JS pruner: no coverage data (or only
  // zero-length ranges) means "don't touch the file".
  const merged = mergeRanges(usedRanges ?? []);
  if (merged.length === 0) {
    return source;
  }

  let nodes: CssNode[];
  try {
    nodes = parseRuleList(source, 0, source.length);
  } catch {
    // Malformed / unparseable stylesheet: never guess, return it unchanged.
    return source;
  }

  const safelist: RegExp[] = [];
  for (const pattern of options?.safelist ?? []) {
    try {
      safelist.push(new RegExp(pattern));
    } catch {
      // Ignore invalid safelist patterns rather than failing the prune.
    }
  }

  /** merged is sorted and disjoint; binary-search for an overlap. */
  const intersects = (start: number, end: number): boolean => {
    let lo = 0;
    let hi = merged.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = merged[mid]!;
      if (r.end <= start) lo = mid + 1;
      else if (r.start >= end) hi = mid - 1;
      else return true;
    }
    return false;
  };

  const preludeOf = (node: StyleRuleNode | AtGroupNode): string =>
    source.slice(node.start, node.blockStart).trim();

  const isSafelisted = (node: StyleRuleNode | AtGroupNode): boolean =>
    safelist.some((re) => re.test(preludeOf(node)));

  /** Leading whitespace of the line the node starts on (for rebuilt groups). */
  const indentOf = (start: number): string => {
    let i = start;
    while (i > 0 && (source[i - 1] === ' ' || source[i - 1] === '\t')) i--;
    return i === 0 || source[i - 1] === '\n' ? source.slice(i, start) : '';
  };

  /**
   * Prelude text after the at-keyword, trimmed: for `@layer theme.dark {`
   * this is `theme.dark`; for anonymous `@layer {` it is the empty string.
   */
  const atPreludeAfterKeyword = (node: AtGroupNode): string => {
    let i = node.start + 1;
    while (i < node.blockStart && /[A-Za-z0-9_-]/.test(source[i]!)) i++;
    return source.slice(i, node.blockStart).trim();
  };

  type Emitted = { text: string; verbatim: boolean };

  const emitNode = (node: CssNode): Emitted | null => {
    switch (node.type) {
      case 'at-statement':
      case 'at-leaf':
        // Coverage never reports these; dropping them is never safe. (Inert
        // position-dependent statements are filtered by the top-level walk
        // below before this is reached.)
        return { text: source.slice(node.start, node.end), verbatim: true };
      case 'style':
        if (intersects(node.start, node.end) || isSafelisted(node)) {
          return { text: source.slice(node.start, node.end), verbatim: true };
        }
        return null;
      case 'at-group': {
        if (isSafelisted(node)) {
          return { text: source.slice(node.start, node.end), verbatim: true };
        }
        const kept: { node: CssNode; emitted: Emitted }[] = [];
        for (const child of node.children) {
          const emitted = emitNode(child);
          if (emitted !== null) kept.push({ node: child, emitted });
        }
        if (kept.length === 0) {
          if (node.name === 'layer') {
            const layerName = atPreludeAfterKeyword(node);
            if (layerName === '') {
              // Anonymous layer: it has no name to re-declare, and an
              // anonymous layer's order slot dies with its block anyway.
              return null;
            }
            if (!/[\s,/]/.test(layerName)) {
              // Dropping a named layer block would erase the layer's implicit
              // position in the layer order; a bare statement re-declares it
              // in place (this substitution applies at any nesting depth).
              return { text: `@layer ${layerName};`, verbatim: false };
            }
            // Odd prelude (a comment, or a comma list — invalid in block
            // form): we cannot confidently reduce it to a statement, so keep
            // the whole block verbatim rather than risk changing the cascade.
            return { text: source.slice(node.start, node.end), verbatim: true };
          }
          return null;
        }
        if (
          kept.length === node.children.length &&
          kept.every((k) => k.emitted.verbatim)
        ) {
          // Nothing inside was pruned: keep the whole block byte-identical.
          return { text: source.slice(node.start, node.end), verbatim: true };
        }
        const head = source.slice(node.start, node.blockStart + 1);
        const body = kept
          .map((k) => indentOf(k.node.start) + k.emitted.text)
          .join('\n');
        return {
          text: `${head}\n${body}\n${indentOf(node.start)}}`,
          verbatim: false,
        };
      }
    }
  };

  const pieces: string[] = [];
  // Tracks whether the ORIGINAL sheet's import-valid region has ended: any
  // style rule, group at-rule (a @layer BLOCK included) or leaf block at-rule
  // ends it; statements (@charset, @import, @namespace, @layer name-list;) do
  // not. A position-dependent statement past that point was ignored by the
  // browser, so emitting it after pruning could activate it — drop it instead.
  let importRegionEnded = false;
  for (const node of nodes) {
    if (node.type !== 'at-statement') {
      importRegionEnded = true;
    } else if (importRegionEnded && POSITION_DEPENDENT_STATEMENTS.has(node.name)) {
      continue;
    }
    const emitted = emitNode(node);
    if (emitted !== null) pieces.push(indentOf(node.start) + emitted.text);
  }

  let out = pieces.join('\n');
  if (source.endsWith('\n') && out.length > 0 && !out.endsWith('\n')) {
    out += '\n';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lightweight structural scanner. No tokenizer dependency: we only need to
// walk comments, strings, url() tokens, parens and brace nesting accurately
// enough to find rule boundaries; everything between boundaries stays opaque.
// ---------------------------------------------------------------------------

function parseRuleList(source: string, pos: number, end: number): CssNode[] {
  const nodes: CssNode[] = [];
  pos = skipTrivia(source, pos, end);

  while (pos < end) {
    const ch = source[pos]!;

    if (ch === '}') {
      throw new CssParseError(`unexpected "}" at ${pos}`);
    }
    if (ch === ';') {
      // Stray semicolons between rules are tolerated by browsers; skip them.
      pos = skipTrivia(source, pos + 1, end);
      continue;
    }

    if (ch === '@') {
      let i = pos + 1;
      while (i < end && /[A-Za-z0-9_-]/.test(source[i]!)) i++;
      if (i === pos + 1) {
        throw new CssParseError(`bare "@" at ${pos}`);
      }
      const rawName = source.slice(pos + 1, i).toLowerCase();
      const name = rawName.replace(/^-[a-z]+-/, ''); // -webkit-keyframes -> keyframes

      const prelude = scanPrelude(source, i, end);
      if (prelude.terminator === ';') {
        nodes.push({ type: 'at-statement', name, start: pos, end: prelude.index + 1 });
        pos = skipTrivia(source, prelude.index + 1, end);
        continue;
      }

      const blockStart = prelude.index;
      const blockEnd = scanBlock(source, blockStart, end);

      if (LEAF_AT_RULES.has(name)) {
        nodes.push({ type: 'at-leaf', name, start: pos, end: blockEnd });
      } else if (GROUP_AT_RULES.has(name)) {
        const children = parseRuleList(source, blockStart + 1, blockEnd - 1);
        nodes.push({ type: 'at-group', name, start: pos, end: blockEnd, blockStart, children });
      } else {
        // Unknown at-rule with a block: if the block parses as a rule list it
        // gets group treatment; otherwise (declarations, or anything odd)
        // treat the whole thing as an always-kept opaque leaf.
        let node: CssNode;
        try {
          const children = parseRuleList(source, blockStart + 1, blockEnd - 1);
          node =
            children.length > 0
              ? { type: 'at-group', name, start: pos, end: blockEnd, blockStart, children }
              : { type: 'at-leaf', name, start: pos, end: blockEnd };
        } catch {
          node = { type: 'at-leaf', name, start: pos, end: blockEnd };
        }
        nodes.push(node);
      }
      pos = skipTrivia(source, blockEnd, end);
      continue;
    }

    // Style rule: selector prelude followed by a declaration block. The block
    // contents stay opaque (CSS nesting inside it is preserved as-is).
    const prelude = scanPrelude(source, pos, end);
    if (prelude.terminator === ';') {
      // A semicolon-terminated non-at chunk is a declaration; declarations
      // don't belong in a rule list, so this isn't a stylesheet we understand.
      throw new CssParseError(`declaration outside a block at ${pos}`);
    }
    const blockEnd = scanBlock(source, prelude.index, end);
    nodes.push({ type: 'style', start: pos, end: blockEnd, blockStart: prelude.index });
    pos = skipTrivia(source, blockEnd, end);
  }

  return nodes;
}

/** Skip whitespace and comments. An unterminated trailing comment swallows the rest. */
function skipTrivia(source: string, pos: number, end: number): number {
  while (pos < end) {
    const ch = source[pos]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
      pos++;
      continue;
    }
    if (ch === '/' && source[pos + 1] === '*') {
      const close = source.indexOf('*/', pos + 2);
      if (close === -1 || close + 2 > end) return end;
      pos = close + 2;
      continue;
    }
    break;
  }
  return pos;
}

/** pos is at a quote; returns the index just past the closing quote. */
function skipString(source: string, pos: number, end: number): number {
  const quote = source[pos]!;
  pos++;
  while (pos < end) {
    const ch = source[pos]!;
    if (ch === '\\') {
      pos += 2;
      continue;
    }
    if (ch === quote) return pos + 1;
    if (ch === '\n') break; // bad-string per css-syntax; treat as malformed
    pos++;
  }
  throw new CssParseError(`unterminated string at ${pos}`);
}

/**
 * If pos starts an unquoted `url(…)` token, return the index just past its
 * closing `)`; otherwise -1. Unquoted url tokens may contain `;`, `{`, `}`
 * (e.g. data: URIs), so the generic scanners must not look inside them.
 * `url("…")` returns -1: the quote is handled by normal string skipping.
 */
function trySkipUrl(source: string, pos: number, end: number): number {
  if (!/^url\(/i.test(source.slice(pos, pos + 4))) return -1;
  const prev = pos > 0 ? source[pos - 1]! : '';
  if (/[A-Za-z0-9_\\-]/.test(prev)) return -1; // part of a longer ident, e.g. curl(
  let i = pos + 4;
  while (i < end && /\s/.test(source[i]!)) i++;
  if (i < end && (source[i] === '"' || source[i] === "'")) return -1;
  while (i < end) {
    const ch = source[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === ')') return i + 1;
    i++;
  }
  throw new CssParseError(`unterminated url() at ${pos}`);
}

/**
 * Scan a rule prelude until `{` or `;` at paren/bracket depth zero,
 * respecting comments, strings and url() tokens.
 */
function scanPrelude(
  source: string,
  pos: number,
  end: number,
): { index: number; terminator: '{' | ';' } {
  let depth = 0;
  while (pos < end) {
    const ch = source[pos]!;
    if (ch === '\\') {
      // Selector escapes (`.a\{x`, `.b\}y`, `\"`) are single tokens: the
      // escaped character must never be read as structure.
      pos += 2;
      continue;
    }
    if (ch === '/' && source[pos + 1] === '*') {
      const close = source.indexOf('*/', pos + 2);
      if (close === -1 || close + 2 > end) {
        throw new CssParseError(`unterminated comment at ${pos}`);
      }
      pos = close + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      pos = skipString(source, pos, end);
      continue;
    }
    if (ch === 'u' || ch === 'U') {
      const next = trySkipUrl(source, pos, end);
      if (next !== -1) {
        pos = next;
        continue;
      }
    }
    if (ch === '(' || ch === '[') {
      depth++;
      pos++;
      continue;
    }
    if (ch === ')' || ch === ']') {
      if (depth > 0) depth--;
      pos++;
      continue;
    }
    if (depth === 0) {
      if (ch === '{') return { index: pos, terminator: '{' };
      if (ch === ';') return { index: pos, terminator: ';' };
      if (ch === '}') throw new CssParseError(`unexpected "}" in prelude at ${pos}`);
    }
    pos++;
  }
  throw new CssParseError(`unterminated rule prelude at ${pos}`);
}

/** pos is at `{`; returns the index just past the matching `}`. */
function scanBlock(source: string, pos: number, end: number): number {
  let depth = 0;
  while (pos < end) {
    const ch = source[pos]!;
    if (ch === '\\') {
      pos += 2;
      continue;
    }
    if (ch === '/' && source[pos + 1] === '*') {
      const close = source.indexOf('*/', pos + 2);
      if (close === -1 || close + 2 > end) {
        throw new CssParseError(`unterminated comment at ${pos}`);
      }
      pos = close + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      pos = skipString(source, pos, end);
      continue;
    }
    if (ch === 'u' || ch === 'U') {
      const next = trySkipUrl(source, pos, end);
      if (next !== -1) {
        pos = next;
        continue;
      }
    }
    if (ch === '{') {
      depth++;
      pos++;
      continue;
    }
    if (ch === '}') {
      depth--;
      pos++;
      if (depth === 0) return pos;
      continue;
    }
    pos++;
  }
  throw new CssParseError(`unclosed block at ${pos}`);
}
