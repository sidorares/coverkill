import * as acorn from 'acorn';
import type { Node, Program } from 'acorn';
import type { ByteRange } from '../report/types.js';
import { invertRanges, mergeRanges } from '../report/merge.js';
import type { RemoveUncoveredOptions } from './ranges.js';

type UncoveredOp = { start: number; end: number };

type PlannedEdit = { start: number; end: number; text: string };

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

function parseAuto(source: string): Program | null {
  for (const attempt of PARSE_ATTEMPTS) {
    try {
      return acorn.parse(source, {
        ecmaVersion: 'latest',
        allowHashBang: true,
        ranges: true,
        ...attempt,
      }) as Program;
    } catch {
      // try next mode
    }
  }
  return null;
}

export function isParseableJs(source: string): boolean {
  return parseAuto(source) !== null;
}

/** Planning context shared by the recursive edit planner. */
type PlanContext = {
  source: string;
  refs: Map<string, ByteRange[]>;
  ops: UncoveredOp[];
  /** Direct eval defeats static reference analysis: never delete declarations. */
  hasDirectEval: boolean;
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
  const ast = parseAuto(source);
  if (ast === null) {
    debugAst('initial parse failed in script, module, and CJS modes');
    return null;
  }

  const ops = buildUncoveredOps(source, covered, options);
  if (ops.length === 0) {
    return source;
  }

  const edits = planEdits(ast, ops, source);
  if (edits.length === 0) {
    debugAst('no edits planned for %d ops', ops.length);
    return source;
  }

  const edited = applyEdits(source, edits);
  if (edited.length === 0) {
    debugAst('post-edit result empty');
    return null;
  }

  // Re-parse both to validate and to find string/template spans that the
  // cosmetic whitespace cleanup must not touch.
  const reparsed = parseAuto(edited);
  if (reparsed === null) {
    debugAst('post-edit parse failed');
    return null;
  }

  return cleanupWhitespace(edited, collectProtectedSpans(reparsed));
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

function planEdits(ast: Program, ops: UncoveredOp[], source: string): PlannedEdit[] {
  const { refs, hasDirectEval } = buildReferenceIndex(ast);
  const ctx: PlanContext = { source, refs, ops, hasDirectEval };
  const edits: PlannedEdit[] = [];

  for (const op of ops) {
    visitStatementList(ast.body, op, ctx, edits);
  }

  return dedupeEdits(edits);
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
      return key !== 'property' || (parent as acorn.MemberExpression).computed;
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

function overlapsAnyOp(node: Node, ops: UncoveredOp[]): boolean {
  return ops.some((op) => overlaps(node, op));
}

// ---------------------------------------------------------------------------
// Hoisting: bindings that escape a removed subtree and must be re-declared.
// ---------------------------------------------------------------------------

/**
 * Names of `var` declarations and (Annex-B) block-level function declarations
 * inside `node` that hoist to the enclosing function scope. Traversal stops
 * at nested function/class boundaries, whose bindings do not escape.
 */
function collectHoistedNames(node: Node): string[] {
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
  return [...names];
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
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i]!;
    if (!overlaps(stmt, op)) continue;
    if (whollyInside(stmt, op)) {
      // V8 (observed on Node 26 / Chromium) misreports the continuation after
      // an await-bearing ternary as count-0 even though it executed. Leave
      // such statements alone rather than trusting the misreport.
      const prev = i > 0 ? statements[i - 1] : null;
      if (prev && !overlaps(prev, op) && containsSuspendingTernary(prev)) {
        continue;
      }
      const edit = replaceStatement(stmt, ctx, { list: statements, index: i });
      if (edit) edits.push(edit);
    } else {
      visitPartial(stmt, op, ctx, edits);
    }
  }
}

/** True when the statement contains a ternary with await/yield at its own function level. */
function containsSuspendingTernary(node: Node): boolean {
  let found = false;

  function visit(current: Node, insideConditional: boolean): void {
    if (found) return;
    switch (current.type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        return;
      case 'AwaitExpression':
      case 'YieldExpression':
        if (insideConditional) found = true;
        return;
      case 'ConditionalExpression':
        forEachChild(current, (child) => visit(child, true));
        return;
      default:
        forEachChild(current, (child) => visit(child, insideConditional));
    }
  }

  visit(node, false);
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
  if (ctx.source[prev.end - 1] === ';') return '';
  switch (prev.type) {
    case 'BlockStatement':
    case 'IfStatement':
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'WhileStatement':
    case 'SwitchStatement':
    case 'TryStatement':
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
      return '';
    default:
      return ';';
  }
}

/** Replacement for a statement wholly inside an uncovered range. */
function replaceStatement(
  stmt: Node,
  ctx: PlanContext,
  position: ListPosition | null,
): PlannedEdit | null {
  const { source, refs } = ctx;
  switch (stmt.type) {
    case 'FunctionDeclaration': {
      const fn = stmt as acorn.FunctionDeclaration;
      // Deleting a hoisted declaration whose name covered code still
      // references would turn that reference into a ReferenceError, so
      // referenced functions are hollowed instead of deleted. Direct eval
      // can reference anything, so it disables deletion entirely.
      if (fn.id && (ctx.hasDirectEval || isReferencedOutside(refs, fn.id.name, stmt))) {
        return hollowFunctionBody(fn, source);
      }
      return { start: stmt.start, end: stmt.end, text: deletionText(ctx, position) };
    }
    case 'ClassDeclaration': {
      const cls = stmt as acorn.ClassDeclaration;
      if (cls.id && (ctx.hasDirectEval || isReferencedOutside(refs, cls.id.name, stmt))) {
        return {
          start: stmt.start,
          end: stmt.end,
          text: `${source.slice(stmt.start, cls.body.start)}{}`,
        };
      }
      return { start: stmt.start, end: stmt.end, text: deletionText(ctx, position) };
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
      const hoisted = hoistedVarText(collectHoistedNames(stmt));
      if (hoisted) {
        return { start: stmt.start, end: stmt.end, text: hoisted };
      }
      return { start: stmt.start, end: stmt.end, text: deletionText(ctx, position) };
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
  const text =
    body.type === 'BlockStatement'
      ? `${source.slice(fn.start, body.start)}{}`
      : `${source.slice(fn.start, body.start)}void 0`;
  return { start: fn.start, end: fn.end, text };
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
  return { start: decl.start, end: decl.end, text };
}

function replaceSwitchCase(node: acorn.SwitchCase, ctx: PlanContext): PlannedEdit | null {
  if (node.consequent.length === 0) return null;
  // Keep `case <test>:` so side-effectful test evaluation and clause order
  // survive, and never synthesize `default:` (it can collide with a real one).
  const labelEnd = node.consequent[0]!.start;
  const label = ctx.source.slice(node.start, labelEnd).trimEnd();
  const hoisted = new Set<string>();
  for (const stmt of node.consequent) {
    for (const name of collectHoistedNames(stmt)) hoisted.add(name);
    if (stmt.type === 'FunctionDeclaration') {
      const id = (stmt as acorn.FunctionDeclaration).id;
      if (id) hoisted.add(id.name);
    }
  }
  const vars = hoisted.size > 0 ? ` var ${[...hoisted].join(', ')};` : '';
  return { start: node.start, end: node.end, text: `${label}${vars} break;` };
}

function isReferencedOutside(
  refs: Map<string, ByteRange[]>,
  name: string,
  node: Node,
): boolean {
  const spans = refs.get(name);
  if (!spans) return false;
  return spans.some((span) => span.start < node.start || span.end > node.end);
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
  const hoisted = collectHoistedNames(stmt);
  const inner = hoistedVarText(hoisted);
  const text = stmt.type === 'BlockStatement' || inner ? `{${inner ? ` ${inner} ` : ''}}` : ';';
  return { start: stmt.start, end: stmt.end, text };
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
            });
          } else if (isStatementNode(child)) {
            const edit = replaceStatement(child, ctx, null);
            if (edit) edits.push(edit);
          } else {
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
    };
  }
  return { start: node.start, end: node.end, text: '0' };
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

  const hoisted = new Set<string>(collectHoistedNames(alternate));
  if (alternate.type === 'FunctionDeclaration') {
    // Sloppy-mode `else function g() {}` hoists a var-like binding too.
    const id = (alternate as acorn.FunctionDeclaration).id;
    if (id) hoisted.add(id.name);
  }

  if (hoisted.size === 0 && !elseHazard) {
    return { start, end: alternate.end, text: '' };
  }
  const inner = hoisted.size > 0 ? ` var ${[...hoisted].join(', ')}; ` : '';
  return { start, end: alternate.end, text: `else {${inner}}` };
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

function applyEdits(source: string, edits: PlannedEdit[]): string {
  let result = source;
  for (const edit of edits) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
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
