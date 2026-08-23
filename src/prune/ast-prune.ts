import * as acorn from 'acorn';
import type { Node, Program } from 'acorn';
import type { ByteRange } from '../report/types.js';
import { invertRanges, mergeRanges } from '../report/merge.js';
import type { RemoveUncoveredOptions } from './ranges.js';

type UncoveredOp = { start: number; end: number };

type PlannedEdit = {
  start: number;
  end: number;
  text: string;
  /**
   * Sub-spans of the original source whose content does not survive this
   * edit. Identifier references inside them are discounted when deciding
   * hollow-vs-delete, so one pass reaches the fixed point.
   */
  removedSpans?: ByteRange[];
};

type ParseAttempt = {
  sourceType: 'script' | 'module';
  allowReturnOutsideFunction?: boolean;
};

// Script first (tolerates sloppy-mode code), then module (ESM), then the
// Node-CJS shape where a top-level `return` is legal inside the module wrapper.
const PARSE_ATTEMPTS: ParseAttempt[] = [
  { sourceType: 'script' },
  { sourceType: 'module' },
  { sourceType: 'script', allowReturnOutsideFunction: true },
];

type ParseError = { message: string; pos: number | null };

type ParseResult = { ast: Program; errors: null } | { ast: null; errors: ParseError[] };

function parseAuto(source: string): ParseResult {
  const errors: ParseError[] = [];
  for (const attempt of PARSE_ATTEMPTS) {
    try {
      const ast = acorn.parse(source, {
        ecmaVersion: 'latest',
        allowHashBang: true,
        ranges: true,
        ...attempt,
      }) as Program;
      return { ast, errors: null };
    } catch (err) {
      errors.push({
        message: err instanceof Error ? err.message : String(err),
        pos: typeof (err as { pos?: unknown }).pos === 'number' ? (err as { pos: number }).pos : null,
      });
    }
  }
  return { ast: null, errors };
}

export function isParseableJs(source: string): boolean {
  return parseAuto(source).ast !== null;
}

/** Planning context shared by the recursive edit planner. */
type PlanContext = {
  source: string;
  refs: Map<string, ByteRange[]>;
  ops: UncoveredOp[];
  /** Direct eval defeats static reference analysis: never delete declarations. */
  hasDirectEval: boolean;
  /** Regions removed by the previous planning iteration (fixed-point pass). */
  excludedRefSpans: ByteRange[];
  /** Hoist names proven to collide with lexical declarations (retry pass). */
  skipHoistNames: Set<string>;
};

/**
 * AST-aware pruning with syntax validation; returns null when the source
 * cannot be parsed or the planned edits do not survive re-parsing.
 *
 * Only bytes inside uncovered ranges are ever rewritten (plus whitespace and
 * provably-safe glue such as an `else` keyword whose branch is removed), so
 * covered code can never be deleted by construction. Replacements preserve
 * the bindings JavaScript hoists out of removed code (`var`, block-level
 * function declarations) and terminate statements explicitly where automatic
 * semicolon insertion could otherwise join neighbours.
 */
export function removeUncoveredRangesAst(
  source: string,
  covered: ByteRange[],
  options?: RemoveUncoveredOptions,
): string | null {
  const parsed = parseAuto(source);
  if (parsed.ast === null) {
    debugAst('initial parse failed in script, module, and CJS modes');
    return null;
  }
  const ast = parsed.ast;

  const ops = buildUncoveredOps(source, covered, options);
  if (ops.length === 0) {
    return source;
  }

  // A hoist-preserving `var x;` can collide with a lexical `x` that legally
  // shadowed the removed declaration; the re-parse detects it, and the retry
  // drops that name AT THE COLLIDING SITE ONLY (matching Annex-B semantics,
  // which skip conflicting hoists) and plans again. Keys are
  // "<editStart>:<name>" so unrelated scopes keep their hoists.
  const skipHoistNames = new Set<string>();
  for (let attempt = 0; attempt < 6; attempt++) {
    const edits = planToFixedPoint(ast, ops, source, skipHoistNames);
    if (edits.length === 0) {
      debugAst('no edits planned for %d ops', ops.length);
      return source;
    }

    const { result: edited, chunks } = applyEdits(source, edits);
    if (edited.length === 0) {
      debugAst('post-edit result empty');
      return null;
    }

    // Re-parse both to validate and to find string/template spans that the
    // cosmetic whitespace cleanup must not touch.
    const reparsed = parseAuto(edited);
    if (reparsed.ast !== null) {
      return cleanupWhitespace(edited, collectProtectedSpans(reparsed.ast));
    }

    const added = resolveHoistCollision(reparsed.errors, chunks, edits, ast, skipHoistNames);
    if (!added) {
      debugAst('edited output failed to parse: %s', reparsed.errors[0]?.message ?? 'unknown');
      return null;
    }
  }
  return null;
}

/**
 * Map a redeclaration error in the edited output back to the hoist-emission
 * site(s) responsible and record skip keys for them. Returns false when no
 * new key could be derived (caller then falls back to leaving the file
 * unchanged).
 */
function resolveHoistCollision(
  errors: ParseError[],
  chunks: AppliedChunk[],
  edits: PlannedEdit[],
  ast: Program,
  skipHoistNames: Set<string>,
): boolean {
  let name: string | null = null;
  let pos: number | null = null;
  for (const error of errors) {
    const match = error.message.match(/Identifier '(.+?)' has already been declared/);
    if (match) {
      name = match[1]!;
      pos = error.pos;
      break;
    }
  }
  if (!name) return false;

  const before = skipHoistNames.size;

  // The error position is in edited coordinates; find whether it lands inside
  // one of our inserted texts (the usual case: the synthesized `var x;` is
  // the later declaration) or in original text (the lexical declaration came
  // after the insertion in source order).
  const chunk = pos === null ? undefined : chunks.find((c) => pos! >= c.outStart && pos! < c.outEnd);
  if (chunk && chunk.editStart !== null) {
    skipHoistNames.add(`${chunk.editStart}:${name}`);
  } else {
    // Scope the fallback to the innermost function around the original
    // position (or the whole file when unknown): drop the name only at
    // emission sites inside that span.
    const srcPos = chunk && chunk.srcStart !== null && pos !== null
      ? chunk.srcStart + (pos - chunk.outStart)
      : null;
    const span = srcPos !== null ? innermostFunctionSpan(ast, srcPos) : { start: 0, end: Infinity };
    const emitsName = new RegExp(`\\bvar\\b[^;]*\\b${escapeRegExp(name)}\\b`);
    for (const edit of edits) {
      if (edit.start >= span.start && edit.start < span.end && emitsName.test(edit.text)) {
        skipHoistNames.add(`${edit.start}:${name}`);
      }
    }
  }

  return skipHoistNames.size > before;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function innermostFunctionSpan(ast: Program, pos: number): ByteRange {
  let best: ByteRange = { start: 0, end: Infinity };

  function visit(node: Node): void {
    if (node.start > pos || node.end <= pos) return;
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      if (node.end - node.start < best.end - best.start) {
        best = { start: node.start, end: node.end };
      }
    }
    forEachChild(node, visit);
  }

  visit(ast);
  return best;
}

/**
 * Plan edits, then re-plan with references inside removed regions discounted,
 * until stable: a function kept alive only by references in code deleted in
 * the same pass would otherwise survive one run and vanish on the next.
 */
function planToFixedPoint(
  ast: Program,
  ops: UncoveredOp[],
  source: string,
  skipHoistNames: Set<string>,
): PlannedEdit[] {
  const shared = buildSharedAnalysis(ast);
  let excluded: ByteRange[] = [];
  let edits = planEdits(ast, ops, source, excluded, skipHoistNames, shared);

  for (let i = 0; i < 3; i++) {
    const removed = mergeRanges(edits.flatMap((e) => e.removedSpans ?? []));
    if (sameRanges(removed, excluded)) break;
    excluded = removed;
    edits = planEdits(ast, ops, source, excluded, skipHoistNames, shared);
  }

  return edits;
}

function sameRanges(a: ByteRange[], b: ByteRange[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((r, i) => r.start === b[i]!.start && r.end === b[i]!.end);
}

function debugAst(message: string, ...args: Array<string | number>): void {
  if (process.env.COVERKILL_DEBUG_AST !== '1' && process.env.COVERKILL_DEBUG_AST !== 'true') {
    return;
  }
  const formatted = args.reduce<string>(
    (msg, arg) => msg.replace(/%[sd]/, String(arg)),
    message,
  );
  console.warn(`[coverkill:ast] ${formatted}`);
}

function buildUncoveredOps(
  source: string,
  covered: ByteRange[],
  options?: RemoveUncoveredOptions,
): UncoveredOp[] {
  if (covered.length === 0) return [];

  const merged = mergeRanges(covered);
  let protectedEnd = 0;

  if (source.startsWith('#!')) {
    const shebangEnd = source.indexOf('\n');
    protectedEnd = shebangEnd === -1 ? source.length : shebangEnd + 1;
  }

  if (options?.preserveLicenseHeader) {
    protectedEnd = Math.max(protectedEnd, detectLicenseHeaderEnd(source, protectedEnd));
  }

  const adjustedCovered =
    protectedEnd > 0
      ? mergeRanges([{ start: 0, end: protectedEnd }, ...merged])
      : merged;

  return invertRanges(source.length, adjustedCovered)
    .map((op) => trimOpBounds(source, op))
    .filter((op) => op.start < op.end);
}

function trimOpBounds(source: string, op: UncoveredOp): UncoveredOp {
  let start = op.start;
  let end = op.end;
  while (start < end && /\s/.test(source[start]!)) start++;
  while (end > start && /\s/.test(source[end - 1]!)) end--;
  return { start, end };
}

// ---------------------------------------------------------------------------
// Edit planning: top-down recursion. For each uncovered op we walk from the
// Program root and emit replacements only for nodes wholly inside the op.
// Nodes that merely overlap an op are recursed into; if no rule applies, the
// code is left in place (under-pruning is always acceptable).
// ---------------------------------------------------------------------------

type SharedAnalysis = {
  refs: Map<string, ByteRange[]>;
  hasDirectEval: boolean;
  /** Spans of validated asm.js modules: V8 does not instrument them, so their
   * count-0 coverage is meaningless and they must never be pruned. */
  asmSpans: ByteRange[];
};

function buildSharedAnalysis(ast: Program): SharedAnalysis {
  const { refs, hasDirectEval } = buildReferenceIndex(ast);
  return { refs, hasDirectEval, asmSpans: collectAsmSpans(ast) };
}

function collectAsmSpans(ast: Program): ByteRange[] {
  const spans: ByteRange[] = [];

  function visit(node: Node): void {
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      const body = (node as acorn.FunctionDeclaration).body;
      if (body.type === 'BlockStatement') {
        const first = body.body[0];
        if (
          first?.type === 'ExpressionStatement' &&
          (first as acorn.ExpressionStatement & { directive?: string }).directive === 'use asm'
        ) {
          spans.push({ start: node.start, end: node.end });
          return;
        }
      }
    }
    forEachChild(node, visit);
  }

  visit(ast);
  return spans;
}

function planEdits(
  ast: Program,
  ops: UncoveredOp[],
  source: string,
  excludedRefSpans: ByteRange[],
  skipHoistNames: Set<string>,
  shared: SharedAnalysis,
): PlannedEdit[] {
  const ctx: PlanContext = {
    source,
    refs: shared.refs,
    ops,
    hasDirectEval: shared.hasDirectEval,
    excludedRefSpans,
    skipHoistNames,
  };
  const edits: PlannedEdit[] = [];

  for (const op of ops) {
    visitStatementList(ast.body, op, ctx, edits);
  }

  const deduped = dedupeEdits(edits);
  if (shared.asmSpans.length === 0) return deduped;
  return deduped.filter(
    (edit) => !shared.asmSpans.some((span) => edit.start < span.end && edit.end > span.start),
  );
}

/** All identifier spans that read or write a name (excludes declarations, keys, labels). */
function buildReferenceIndex(ast: Program): {
  refs: Map<string, ByteRange[]>;
  hasDirectEval: boolean;
} {
  const refs = new Map<string, ByteRange[]>();
  let hasDirectEval = false;

  function add(name: string, start: number, end: number): void {
    let list = refs.get(name);
    if (!list) {
      list = [];
      refs.set(name, list);
    }
    list.push({ start, end });
  }

  function visit(node: Node, parent: Node | null, key: string | null): void {
    if (node.type === 'Identifier') {
      if (isReferencePosition(parent, key)) {
        add((node as acorn.Identifier).name, node.start, node.end);
      }
      return;
    }
    if (
      node.type === 'CallExpression' &&
      (node as acorn.CallExpression).callee.type === 'Identifier' &&
      ((node as acorn.CallExpression).callee as acorn.Identifier).name === 'eval'
    ) {
      hasDirectEval = true;
    }
    forEachChild(node, (child, childKey) => visit(child, node, childKey));
  }

  visit(ast, null, null);
  return { refs, hasDirectEval };
}

function isReferencePosition(parent: Node | null, key: string | null): boolean {
  if (!parent) return false;
  switch (parent.type) {
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ClassDeclaration':
    case 'ClassExpression':
      return key !== 'id' && key !== 'params';
    case 'ArrowFunctionExpression':
      return key !== 'params';
    case 'VariableDeclarator':
      return key !== 'id';
    case 'Property':
      return key !== 'key' || (parent as acorn.Property).computed;
    case 'PropertyDefinition':
    case 'MethodDefinition':
      return key !== 'key' || (parent as unknown as { computed: boolean }).computed;
    case 'MemberExpression':
      // Non-computed property names count too: in classic scripts, top-level
      // declarations are globalThis properties, so covered `window.fn`
      // reflection must keep `fn` from being deleted (hollowed instead).
      return true;
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return key !== 'label';
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
      return false;
    case 'ExportSpecifier':
      return key === 'local';
    case 'CatchClause':
      return key !== 'param';
    // Identifiers inside patterns are counted as references even though
    // declaration patterns create bindings: assignment destructuring
    // (`[target] = value`) uses the same node shapes to WRITE existing
    // names, and hollowing instead of deleting on a false positive is safe.
    default:
      return true;
  }
}

function forEachChild(node: Node, fn: (child: Node, key: string) => void): void {
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'range' || key === 'loc') {
      continue;
    }
    const value = (node as unknown as Record<string, unknown>)[key];
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isAstNode(child)) fn(child, key);
      }
    } else if (isAstNode(value)) {
      fn(value, key);
    }
  }
}

function isAstNode(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    typeof (value as { start?: unknown }).start === 'number'
  );
}

function whollyInside(node: Node, op: UncoveredOp): boolean {
  return node.start >= op.start && node.end <= op.end;
}

function overlaps(node: Node, op: UncoveredOp): boolean {
  return node.start < op.end && node.end > op.start;
}

/** ops are sorted and disjoint (built via invertRanges): binary search. */
function overlapsAnyOp(node: Node, ops: UncoveredOp[]): boolean {
  let lo = 0;
  let hi = ops.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const op = ops[mid]!;
    if (op.end <= node.start) lo = mid + 1;
    else if (op.start >= node.end) hi = mid - 1;
    else return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Hoisting: bindings that escape a removed subtree and must be re-declared.
// ---------------------------------------------------------------------------

/**
 * Names of `var` declarations and (Annex-B) block-level function declarations
 * inside `node` that hoist to the enclosing function scope. Traversal stops
 * at nested function/class boundaries, whose bindings do not escape.
 */
function collectHoistedNames(node: Node, skipNames?: Set<string>, siteStart?: number): string[] {
  const names = new Set<string>();

  function visit(current: Node, isRoot: boolean): void {
    switch (current.type) {
      case 'FunctionDeclaration': {
        // The root declaration is handled by hollow/delete logic elsewhere;
        // nested ones hoist a var-like binding in sloppy mode (Annex B).
        if (!isRoot) {
          const id = (current as acorn.FunctionDeclaration).id;
          if (id) names.add(id.name);
        }
        return; // do not descend into the function body
      }
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'ClassDeclaration':
      case 'ClassExpression':
        return;
      case 'VariableDeclaration': {
        const decl = current as acorn.VariableDeclaration;
        if (decl.kind === 'var') {
          for (const declarator of decl.declarations) {
            collectPatternNames(declarator.id, names);
          }
        }
        // fall through to visit initializers? Initializers cannot contain
        // var declarations, but can contain nothing hoistable — skip.
        return;
      }
      default:
        forEachChild(current, (child) => visit(child, false));
    }
  }

  visit(node, true);
  return [...names].filter((n) => !skipNames?.has(`${siteStart ?? node.start}:${n}`));
}

function collectPatternNames(pattern: Node, into: Set<string>): void {
  switch (pattern.type) {
    case 'Identifier':
      into.add((pattern as acorn.Identifier).name);
      return;
    case 'ObjectPattern':
      for (const prop of (pattern as acorn.ObjectPattern).properties) {
        if (prop.type === 'Property') collectPatternNames(prop.value, into);
        else collectPatternNames(prop, into);
      }
      return;
    case 'ArrayPattern':
      for (const el of (pattern as acorn.ArrayPattern).elements) {
        if (el) collectPatternNames(el, into);
      }
      return;
    case 'AssignmentPattern':
      collectPatternNames((pattern as acorn.AssignmentPattern).left, into);
      return;
    case 'RestElement':
      collectPatternNames((pattern as acorn.RestElement).argument, into);
      return;
    default:
      return;
  }
}

function hoistedVarText(names: string[]): string {
  return names.length > 0 ? `var ${names.join(', ')};` : '';
}

// ---------------------------------------------------------------------------
// Statement-list handling.
// ---------------------------------------------------------------------------

function visitStatementList(
  statements: Node[],
  op: UncoveredOp,
  ctx: PlanContext,
  edits: PlannedEdit[],
): void {
  // V8 block coverage misattributes executed continuations as count-0 in a
  // family of shapes (resumption after conditionally-skipped await/yield,
  // zero-iteration for(let..) loops containing closures, and more). Function
  // declarations are exempt — their deadness is backed by their own V8
  // function entries — but any other statement is only deleted when control
  // flow provably could not reach it: the previous kept sibling must end in
  // return/throw/break/continue and contain no suspension point.
  // Statements are in source order; skip straight to the op's neighbourhood
  // instead of scanning the whole list for every op (large minified files
  // have thousands of ops and thousands of top-level statements).
  const first = binarySearchFirstOverlap(statements, op);
  if (first === -1) return;

  let terminatorJustified = false;
  if (first > 0) {
    const prev = statements[first - 1]!;
    terminatorJustified =
      !overlapsAnyOp(prev, ctx.ops) && endsWithTerminator(prev) && !containsSuspension(prev);
  }

  for (let i = first; i < statements.length; i++) {
    const stmt = statements[i]!;
    if (stmt.start >= op.end) break;
    if (!overlaps(stmt, op) && !overlapsAnyOp(stmt, ctx.ops)) {
      terminatorJustified = endsWithTerminator(stmt) && !containsSuspension(stmt);
      continue;
    }
    if (!overlaps(stmt, op)) {
      // Touched by a different op; that op's own pass handles it. Its
      // execution state is mixed, so it cannot justify deletions after it.
      terminatorJustified = false;
      continue;
    }
    if (whollyInside(stmt, op)) {
      const trusted = isEntryBackedStatement(stmt) || stmt.type === 'EmptyStatement';
      if (!trusted && !terminatorJustified) {
        continue;
      }
      const edit = replaceStatement(stmt, ctx, { list: statements, index: i });
      if (edit) edits.push(edit);
    } else {
      visitPartial(stmt, op, ctx, edits);
      terminatorJustified = false;
    }
  }
}

/** Index of the first statement overlapping the op, or -1. */
function binarySearchFirstOverlap(statements: Node[], op: UncoveredOp): number {
  let lo = 0;
  let hi = statements.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const stmt = statements[mid]!;
    if (stmt.end <= op.start) {
      lo = mid + 1;
    } else {
      if (overlaps(stmt, op)) found = mid;
      hi = mid - 1;
    }
  }
  return found;
}

/** Statements whose removal is justified by a dedicated V8 function entry. */
function isEntryBackedStatement(stmt: Node): boolean {
  if (stmt.type === 'FunctionDeclaration') return true;
  if (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') {
    const decl = (stmt as acorn.ExportNamedDeclaration | acorn.ExportDefaultDeclaration)
      .declaration as Node | null | undefined;
    return (
      decl?.type === 'FunctionDeclaration' ||
      decl?.type === 'FunctionExpression' ||
      decl?.type === 'ArrowFunctionExpression'
    );
  }
  return false;
}

/** True when the statement's final control flow leaves the enclosing list. */
function endsWithTerminator(stmt: Node): boolean {
  switch (stmt.type) {
    case 'ReturnStatement':
    case 'ThrowStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return true;
    case 'IfStatement': {
      const n = stmt as acorn.IfStatement;
      return (
        endsWithTerminator(n.consequent) ||
        (n.alternate !== null && n.alternate !== undefined && endsWithTerminator(n.alternate))
      );
    }
    case 'BlockStatement': {
      const body = (stmt as acorn.BlockStatement).body;
      return body.length > 0 && endsWithTerminator(body[body.length - 1]!);
    }
    case 'LabeledStatement':
      return endsWithTerminator((stmt as acorn.LabeledStatement).body);
    default:
      return false;
  }
}

/** Any await/yield at the statement's own function level (misreport risk). */
function containsSuspension(node: Node): boolean {
  let found = false;

  function visit(current: Node): void {
    if (found) return;
    switch (current.type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        return;
      case 'AwaitExpression':
      case 'YieldExpression':
        found = true;
        return;
      case 'ForOfStatement':
        if ((current as acorn.ForOfStatement).await) {
          found = true;
          return;
        }
        forEachChild(current, visit);
        return;
      default:
        forEachChild(current, visit);
    }
  }

  visit(node);
  return found;
}

type ListPosition = { list: Node[]; index: number };

/**
 * Deleting a statement can merge its neighbours through automatic semicolon
 * insertion (`let a = 1` + `(fn)()` becomes a call). Deletion is only safe
 * when the previous kept sibling is explicitly terminated; otherwise a `;`
 * placeholder keeps the boundary.
 */
function deletionText(ctx: PlanContext, position: ListPosition | null): string {
  if (!position) return ';';
  const { list, index } = position;
  if (index === 0) return '';
  const prev = list[index - 1]!;
  if (overlapsAnyOp(prev, ctx.ops)) return ';';
  return isTerminatedStatement(prev, ctx.source) ? '' : ';';
}

/**
 * A statement is safely terminated when its final token is an explicit `;`
 * or the closing `}` of a structural statement. A braceless `if (x) x = f`
 * ends mid-expression regardless of its type, and an ExpressionStatement can
 * end in `}` (object literal, function expression) while still being open to
 * ASI joins — both need a `;` placeholder after deletions.
 */
function isTerminatedStatement(stmt: Node, source: string): boolean {
  const last = source[stmt.end - 1];
  if (last === ';') return true;
  if (last !== '}') return false;
  switch (stmt.type) {
    case 'BlockStatement':
    case 'IfStatement':
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
    case 'SwitchStatement':
    case 'TryStatement':
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
    case 'LabeledStatement':
    case 'WithStatement':
      return true;
    case 'ExportNamedDeclaration':
    case 'ExportDefaultDeclaration': {
      const decl = (stmt as acorn.ExportNamedDeclaration | acorn.ExportDefaultDeclaration)
        .declaration as Node | null | undefined;
      return decl?.type === 'FunctionDeclaration' || decl?.type === 'ClassDeclaration';
    }
    default:
      return false;
  }
}

/** Replacement for a statement wholly inside an uncovered range. */
function replaceStatement(
  stmt: Node,
  ctx: PlanContext,
  position: ListPosition | null,
): PlannedEdit | null {
  const { source } = ctx;
  switch (stmt.type) {
    case 'FunctionDeclaration': {
      const fn = stmt as acorn.FunctionDeclaration;
      // Deleting a hoisted declaration whose name covered code still
      // references would turn that reference into a ReferenceError, so
      // referenced functions are hollowed instead of deleted. Direct eval
      // can reference anything, so it disables deletion entirely.
      if (fn.id && (ctx.hasDirectEval || isReferencedOutside(ctx, fn.id.name, stmt))) {
        return hollowFunctionBody(fn, source);
      }
      return {
        start: stmt.start,
        end: stmt.end,
        text: deletionText(ctx, position),
        removedSpans: [{ start: stmt.start, end: stmt.end }],
      };
    }
    case 'ClassDeclaration': {
      const cls = stmt as acorn.ClassDeclaration;
      if (cls.id && (ctx.hasDirectEval || isReferencedOutside(ctx, cls.id.name, stmt))) {
        return {
          start: stmt.start,
          end: stmt.end,
          text: `${source.slice(stmt.start, cls.body.start)}{}`,
          removedSpans: [{ start: cls.body.start, end: cls.body.end }],
        };
      }
      return {
        start: stmt.start,
        end: stmt.end,
        text: deletionText(ctx, position),
        removedSpans: [{ start: stmt.start, end: stmt.end }],
      };
    }
    case 'VariableDeclaration':
      return replaceVariableDeclaration(stmt as acorn.VariableDeclaration, source);
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
      // Imports create bindings and have side effects; export * shapes the
      // module interface. Never touch them.
      return null;
    case 'ExportNamedDeclaration':
    case 'ExportDefaultDeclaration':
      return hollowExportDeclaration(stmt, ctx);
    case 'EmptyStatement':
      return { start: stmt.start, end: stmt.end, text: '' };
    default: {
      const removedSpans = [{ start: stmt.start, end: stmt.end }];
      const hoisted = hoistedVarText(collectHoistedNames(stmt, ctx.skipHoistNames, stmt.start));
      if (hoisted) {
        return { start: stmt.start, end: stmt.end, text: hoisted, removedSpans };
      }
      return { start: stmt.start, end: stmt.end, text: deletionText(ctx, position), removedSpans };
    }
  }
}

/**
 * Exported declarations keep the module interface intact: the declaration is
 * hollowed in place and never deleted (an orphaned `export` keyword would
 * otherwise absorb the next statement).
 */
function hollowExportDeclaration(stmt: Node, ctx: PlanContext): PlannedEdit | null {
  const decl = (stmt as acorn.ExportNamedDeclaration | acorn.ExportDefaultDeclaration)
    .declaration as Node | null | undefined;
  if (!decl) return null;
  return hollowDeclaration(decl, ctx);
}

function hollowDeclaration(decl: Node, ctx: PlanContext): PlannedEdit | null {
  const { source } = ctx;
  if (decl.type === 'FunctionDeclaration') {
    return hollowFunctionBody(decl as acorn.FunctionDeclaration, source);
  }
  if (decl.type === 'ClassDeclaration') {
    const cls = decl as acorn.ClassDeclaration;
    return {
      start: decl.start,
      end: decl.end,
      text: `${source.slice(decl.start, cls.body.start)}{}`,
      removedSpans: [{ start: cls.body.start, end: cls.body.end }],
    };
  }
  if (decl.type === 'VariableDeclaration') {
    return replaceVariableDeclaration(decl as acorn.VariableDeclaration, source);
  }
  if (decl.type === 'ArrowFunctionExpression' || decl.type === 'FunctionExpression') {
    return hollowFunctionBody(decl as acorn.ArrowFunctionExpression, source);
  }
  return null;
}

function hollowFunctionBody(
  fn: acorn.FunctionDeclaration | acorn.FunctionExpression | acorn.ArrowFunctionExpression,
  source: string,
): PlannedEdit {
  const body = fn.body;
  // Preserve the bytes after the body too: a parenthesized arrow expression
  // body ((x) => ({...})) keeps its closing paren outside body.end.
  const replacement = body.type === 'BlockStatement' ? '{}' : 'void 0';
  const text = `${source.slice(fn.start, body.start)}${replacement}${source.slice(body.end, fn.end)}`;
  return {
    start: fn.start,
    end: fn.end,
    text,
    removedSpans: [{ start: body.start, end: body.end }],
  };
}

function replaceVariableDeclaration(
  decl: acorn.VariableDeclaration,
  source: string,
): PlannedEdit | null {
  // `var x = heavyInit()` never executed still hoists a binding that covered
  // code may assign or read; keep the binding, drop the initializer. Skip
  // destructuring patterns — synthesizing a safe initializer for them could
  // run default-value expressions the original never evaluated.
  const names: string[] = [];
  for (const declarator of decl.declarations) {
    if (declarator.id.type !== 'Identifier') return null;
    names.push(declarator.id.name);
  }
  if (names.length === 0) return null;
  const text =
    decl.kind === 'const'
      ? `const ${names.map((n) => `${n} = void 0`).join(', ')};`
      : `${decl.kind} ${names.join(', ')};`;
  if (text.length >= decl.end - decl.start) {
    // No byte savings — leave the original in place.
    return null;
  }
  return {
    start: decl.start,
    end: decl.end,
    text,
    removedSpans: decl.declarations
      .filter((d) => d.init)
      .map((d) => ({ start: d.init!.start, end: d.init!.end })),
  };
}

function replaceSwitchCase(node: acorn.SwitchCase, ctx: PlanContext): PlannedEdit | null {
  if (node.consequent.length === 0) return null;
  // Keep `case <test>:` so side-effectful test evaluation and clause order
  // survive, and never synthesize `default:` (it can collide with a real one).
  const labelEnd = node.consequent[0]!.start;
  const label = ctx.source.slice(node.start, labelEnd).trimEnd();
  const hoisted = new Set<string>();
  for (const stmt of node.consequent) {
    for (const name of collectHoistedNames(stmt, ctx.skipHoistNames, node.start)) hoisted.add(name);
    if (stmt.type === 'FunctionDeclaration') {
      const id = (stmt as acorn.FunctionDeclaration).id;
      if (id && !ctx.skipHoistNames.has(`${node.start}:${id.name}`)) hoisted.add(id.name);
    }
  }
  const vars = hoisted.size > 0 ? ` var ${[...hoisted].join(', ')};` : '';
  return {
    start: node.start,
    end: node.end,
    text: `${label}${vars} break;`,
    removedSpans: [{ start: labelEnd, end: node.end }],
  };
}

function isReferencedOutside(ctx: PlanContext, name: string, node: Node): boolean {
  const spans = ctx.refs.get(name);
  if (!spans) return false;
  return spans.some(
    (span) =>
      (span.start < node.start || span.end > node.end) &&
      // References inside regions removed by this same pass do not keep a
      // declaration alive (otherwise a second run would prune further).
      !ctx.excludedRefSpans.some((ex) => span.start >= ex.start && span.end <= ex.end),
  );
}

/**
 * Replacement for a statement in a single-statement position (loop body,
 * if branch): the position must keep a statement, and hoisted bindings from
 * the removed subtree must survive.
 */
function replaceEmbeddedStatement(stmt: Node, ctx: PlanContext): PlannedEdit | null {
  if (stmt.type === 'VariableDeclaration') {
    // `if (e) var t = 1` — var must keep its binding (let/const are illegal here).
    return replaceVariableDeclaration(stmt as acorn.VariableDeclaration, ctx.source);
  }
  if (stmt.type === 'FunctionDeclaration') {
    // Sloppy-mode `if (x) function g() {}` — keep the Annex-B binding.
    return hollowFunctionBody(stmt as acorn.FunctionDeclaration, ctx.source);
  }
  if (stmt.type === 'EmptyStatement') return null;
  const hoisted = collectHoistedNames(stmt, ctx.skipHoistNames, stmt.start);
  const inner = hoistedVarText(hoisted);
  const text = stmt.type === 'BlockStatement' || inner ? `{${inner ? ` ${inner} ` : ''}}` : ';';
  return {
    start: stmt.start,
    end: stmt.end,
    text,
    removedSpans: [{ start: stmt.start, end: stmt.end }],
  };
}

/**
 * Recurse into a node that overlaps but is not wholly inside the op.
 *
 * `elseHazard` is true while inside a braceless statement chain that a later
 * `else` (of an enclosing if) follows: removing an inner `else` there would
 * re-associate the outer one with the wrong if, so such branches are emptied
 * to `else {}` instead of deleted.
 */
function visitPartial(
  node: Node,
  op: UncoveredOp,
  ctx: PlanContext,
  edits: PlannedEdit[],
  elseHazard = false,
): void {
  const { source } = ctx;
  switch (node.type) {
    case 'BlockStatement':
      // Braces terminate any dangling-else ambiguity.
      visitStatementList((node as acorn.BlockStatement).body, op, ctx, edits);
      return;

    case 'IfStatement': {
      const n = node as acorn.IfStatement;
      if (n.alternate && whollyInside(n.alternate, op)) {
        const elseEdit = removeElseBranch(n, ctx, elseHazard);
        if (elseEdit) edits.push(elseEdit);
      } else if (n.alternate && overlaps(n.alternate, op)) {
        visitPartial(n.alternate, op, ctx, edits, elseHazard);
      }
      const consequentHazard = elseHazard || n.alternate !== null;
      if (whollyInside(n.consequent, op)) {
        const edit = replaceEmbeddedStatement(n.consequent, ctx);
        if (edit) edits.push(edit);
      } else if (overlaps(n.consequent, op)) {
        visitPartial(n.consequent, op, ctx, edits, consequentHazard);
      }
      return;
    }

    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement': {
      // A loop body must stay a statement: deleting it outright would make
      // the next covered statement the loop body.
      const body = (node as unknown as { body: Node }).body;
      if (whollyInside(body, op)) {
        const edit = replaceEmbeddedStatement(body, ctx);
        if (edit) edits.push(edit);
      } else if (overlaps(body, op)) {
        visitPartial(body, op, ctx, edits, elseHazard);
      }
      return;
    }

    case 'LabeledStatement':
    case 'WithStatement': {
      const body = (node as unknown as { body: Node }).body;
      if (overlaps(body, op)) {
        if (whollyInside(body, op)) {
          const edit = replaceEmbeddedStatement(body, ctx);
          if (edit) edits.push(edit);
        } else {
          visitPartial(body, op, ctx, edits, elseHazard);
        }
      }
      return;
    }

    case 'SwitchStatement': {
      for (const switchCase of (node as acorn.SwitchStatement).cases) {
        if (!overlaps(switchCase, op)) continue;
        if (whollyInside(switchCase, op)) {
          const edit = replaceSwitchCase(switchCase, ctx);
          if (edit) edits.push(edit);
        } else {
          visitStatementList(switchCase.consequent, op, ctx, edits);
        }
      }
      return;
    }

    case 'ExportNamedDeclaration':
    case 'ExportDefaultDeclaration': {
      // V8 function ranges start at the `function` keyword, so an op for a
      // dead exported function never contains the export statement itself.
      // Route through hollow-only logic: the export keyword must never be
      // orphaned and the module interface must survive.
      const decl = (node as acorn.ExportNamedDeclaration | acorn.ExportDefaultDeclaration)
        .declaration as Node | null | undefined;
      if (decl && overlaps(decl, op)) {
        if (whollyInside(decl, op)) {
          const edit = hollowDeclaration(decl, ctx);
          if (edit) edits.push(edit);
        } else {
          visitPartial(decl, op, ctx, edits);
        }
      }
      return;
    }

    case 'ConditionalExpression': {
      const n = node as acorn.ConditionalExpression;
      for (const branch of [n.consequent, n.alternate]) {
        if (whollyInside(branch, op)) {
          edits.push(expressionEdit(branch, source));
        } else if (overlaps(branch, op)) {
          visitPartial(branch, op, ctx, edits);
        }
      }
      if (overlaps(n.test, op) && !whollyInside(n.test, op)) {
        visitPartial(n.test, op, ctx, edits);
      }
      return;
    }

    case 'LogicalExpression': {
      const n = node as acorn.LogicalExpression;
      if (whollyInside(n.right, op)) {
        edits.push(expressionEdit(n.right, source));
      } else if (overlaps(n.right, op)) {
        visitPartial(n.right, op, ctx, edits);
      }
      if (overlaps(n.left, op) && !whollyInside(n.left, op)) {
        visitPartial(n.left, op, ctx, edits);
      }
      return;
    }

    case 'TryStatement': {
      // Never prune inside catch: stubbing an error path swallows errors the
      // application would otherwise report.
      const n = node as acorn.TryStatement;
      if (overlaps(n.block, op)) visitPartial(n.block, op, ctx, edits);
      if (n.finalizer && overlaps(n.finalizer, op)) {
        visitPartial(n.finalizer, op, ctx, edits);
      }
      return;
    }

    case 'MethodDefinition':
    case 'PropertyDefinition':
    case 'Property': {
      const value = (node as unknown as { value?: Node }).value;
      if (value && overlaps(value, op)) {
        if (
          whollyInside(value, op) &&
          (value.type === 'FunctionExpression' || value.type === 'ArrowFunctionExpression')
        ) {
          // Hollow the body only: shorthand methods cannot be replaced by a
          // bare function expression without breaking the surrounding syntax.
          const body = (value as acorn.FunctionExpression).body;
          edits.push({
            start: body.start,
            end: body.end,
            text: body.type === 'BlockStatement' ? '{}' : 'void 0',
            removedSpans: [{ start: body.start, end: body.end }],
          });
        } else {
          visitPartial(value, op, ctx, edits);
        }
      }
      return;
    }

    default: {
      forEachChild(node, (child) => {
        if (!overlaps(child, op)) return;
        if (whollyInside(child, op)) {
          if (child.type === 'FunctionExpression' || child.type === 'ArrowFunctionExpression') {
            // A function-valued expression that never ran keeps its shape
            // (params, async modifiers) with an emptied body: it may be
            // stored, passed, or compared by covered code.
            edits.push(hollowFunctionBody(child as acorn.FunctionExpression, source));
          } else if (child.type === 'ClassExpression') {
            const cls = child as acorn.ClassExpression;
            edits.push({
              start: child.start,
              end: child.end,
              text: `${source.slice(child.start, cls.body.start)}{}`,
              removedSpans: [{ start: cls.body.start, end: cls.body.end }],
            });
          } else if (isEntryBackedStatement(child)) {
            // Only function-backed statements carry their own V8 evidence;
            // other statements here lack sibling context for the terminator
            // justification and are left in place.
            const edit = replaceStatement(child, ctx, null);
            if (edit) edits.push(edit);
          } else if (!isStatementNode(child)) {
            visitPartial(child, op, ctx, edits);
          }
          // Other expression kinds wholly inside an uncovered range are left
          // alone unless a structural rule above (ternary/logical branches)
          // applies: under-pruning is safe, guessing replacements is not.
        } else {
          visitPartial(child, op, ctx, edits);
        }
      });
    }
  }
}

function isStatementNode(node: Node): boolean {
  return node.type.endsWith('Statement') || node.type.endsWith('Declaration');
}

function expressionEdit(node: Node, source: string): PlannedEdit {
  if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
    return hollowFunctionBody(node as acorn.FunctionExpression, source);
  }
  if (node.type === 'ClassExpression') {
    const cls = node as acorn.ClassExpression;
    return {
      start: node.start,
      end: node.end,
      text: `${source.slice(node.start, cls.body.start)}{}`,
      removedSpans: [{ start: cls.body.start, end: cls.body.end }],
    };
  }
  return {
    start: node.start,
    end: node.end,
    text: '0',
    removedSpans: [{ start: node.start, end: node.end }],
  };
}

/**
 * Remove or empty `else <branch>`. The branch is deleted entirely when safe;
 * when a later `else` of an enclosing if would re-associate (dangling-else
 * hazard) or the branch hoists bindings, an empty `else { ... }` is kept.
 */
function removeElseBranch(
  ifNode: acorn.IfStatement,
  ctx: PlanContext,
  elseHazard: boolean,
): PlannedEdit | null {
  const { source } = ctx;
  const alternate = ifNode.alternate;
  if (!alternate) return null;
  const gap = source.slice(ifNode.consequent.end, alternate.start);
  const match = findElseKeyword(gap);
  if (match === null) return null;
  const start = ifNode.consequent.end + match;
  const removedSpans = [{ start: alternate.start, end: alternate.end }];

  const hoisted = collectHoistedNames(alternate, ctx.skipHoistNames, start);
  if (alternate.type === 'FunctionDeclaration') {
    // Sloppy-mode `else function g() {}` hoists a var-like binding too.
    const id = (alternate as acorn.FunctionDeclaration).id;
    if (id && !ctx.skipHoistNames.has(`${start}:${id.name}`) && !hoisted.includes(id.name)) {
      hoisted.push(id.name);
    }
  }

  if (hoisted.length === 0 && !elseHazard) {
    // The alternate's own terminator is consumed by the deletion; a braceless
    // unterminated consequent (`if (y) y = 3`) would otherwise ASI-join the
    // next statement.
    const text = isTerminatedStatement(ifNode.consequent, source) ? '' : ';';
    return { start, end: alternate.end, text, removedSpans };
  }
  const inner = hoisted.length > 0 ? ` var ${hoisted.join(', ')}; ` : '';
  return { start, end: alternate.end, text: `else {${inner}}`, removedSpans };
}

/**
 * Position of the `else` keyword inside the gap between consequent and
 * alternate, skipping comments so a comment containing "else" cannot
 * confuse it.
 */
function findElseKeyword(gap: string): number | null {
  let i = 0;
  while (i < gap.length) {
    const ch = gap[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && gap[i + 1] === '*') {
      const close = gap.indexOf('*/', i + 2);
      if (close === -1) return null;
      i = close + 2;
      continue;
    }
    if (ch === '/' && gap[i + 1] === '/') {
      const nl = gap.indexOf('\n', i + 2);
      if (nl === -1) return null;
      i = nl + 1;
      continue;
    }
    return gap.startsWith('else', i) ? i : null;
  }
  return null;
}

function dedupeEdits(edits: PlannedEdit[]): PlannedEdit[] {
  const sorted = [...edits].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: PlannedEdit[] = [];

  for (const edit of sorted) {
    const last = kept[kept.length - 1];
    if (last && edit.start < last.end) {
      // Nested or overlapping with an already-kept edit: the outer one wins.
      continue;
    }
    kept.push(edit);
  }

  return kept.sort((a, b) => b.start - a.start);
}

type AppliedChunk = {
  outStart: number;
  outEnd: number;
  /** Source offset for copied chunks; null for inserted edit text. */
  srcStart: number | null;
  /** Edit start for inserted chunks; null for copied source text. */
  editStart: number | null;
};

function applyEdits(
  source: string,
  edits: PlannedEdit[],
): { result: string; chunks: AppliedChunk[] } {
  const ascending = [...edits].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  const chunks: AppliedChunk[] = [];
  let srcPos = 0;
  let outPos = 0;

  const push = (text: string, srcStart: number | null, editStart: number | null): void => {
    if (text.length === 0) return;
    parts.push(text);
    chunks.push({ outStart: outPos, outEnd: outPos + text.length, srcStart, editStart });
    outPos += text.length;
  };

  for (const edit of ascending) {
    push(source.slice(srcPos, edit.start), srcPos, null);
    push(edit.text, null, edit.start);
    srcPos = edit.end;
  }
  push(source.slice(srcPos), srcPos, null);

  return { result: parts.join(''), chunks };
}

// ---------------------------------------------------------------------------
// Whitespace cleanup that never reaches inside string or template literals.
// ---------------------------------------------------------------------------

function collectProtectedSpans(ast: Program): ByteRange[] {
  const spans: ByteRange[] = [];

  function visit(node: Node): void {
    if (node.type === 'TemplateLiteral' || node.type === 'Literal') {
      spans.push({ start: node.start, end: node.end });
      return;
    }
    forEachChild(node, visit);
  }

  visit(ast);
  return mergeRanges(spans);
}

function cleanupWhitespace(source: string, protectedSpans: ByteRange[]): string {
  const pieces: string[] = [];
  let pos = 0;

  for (const span of protectedSpans) {
    if (span.start > pos) {
      pieces.push(cleanSegment(source.slice(pos, span.start)));
    }
    pieces.push(source.slice(span.start, span.end));
    pos = span.end;
  }
  if (pos < source.length) {
    pieces.push(cleanSegment(source.slice(pos)));
  }

  let result = pieces.join('');
  const trailing = result.match(/\s+$/);
  if (trailing && protectedSpans.every((s) => s.end <= result.length - trailing[0].length)) {
    result = `${result.slice(0, result.length - trailing[0].length)}\n`;
  }
  return result;
}

function cleanSegment(segment: string): string {
  return segment.replace(/[ \t]+(?=\n)/g, '').replace(/\n{3,}/g, '\n\n');
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
