import * as acorn from 'acorn';
import type { Node, Program } from 'acorn';
import type { ByteRange } from '../report/types.js';
import { invertRanges, mergeRanges } from '../report/merge.js';
import type { RemoveUncoveredOptions } from './ranges.js';

type UncoveredOp = { start: number; end: number };

type PlannedEdit = { start: number; end: number; text: string };

type ParseMode = 'script' | 'module';

function parseOptions(mode: ParseMode): acorn.Options {
  return {
    ecmaVersion: 'latest',
    sourceType: mode,
    allowHashBang: true,
    ranges: true,
  };
}

/** Parse as script first (tolerates sloppy-mode code), fall back to module (ESM). */
function parseAuto(source: string): { ast: Program; mode: ParseMode } | null {
  for (const mode of ['script', 'module'] as const) {
    try {
      return { ast: acorn.parse(source, parseOptions(mode)) as Program, mode };
    } catch {
      // try next mode
    }
  }
  return null;
}

export function isParseableJs(source: string): boolean {
  return parseAuto(source) !== null;
}

/**
 * AST-aware pruning with syntax validation; returns null when the source
 * cannot be parsed or the planned edits do not survive re-parsing.
 *
 * Only bytes inside uncovered ranges are ever rewritten (plus whitespace and
 * provably-safe glue such as an `else` keyword whose branch is removed), so
 * covered code can never be deleted by construction.
 */
export function removeUncoveredRangesAst(
  source: string,
  covered: ByteRange[],
  options?: RemoveUncoveredOptions,
): string | null {
  const parsed = parseAuto(source);
  if (parsed === null) {
    debugAst('initial parse failed in both script and module mode');
    return null;
  }

  const ops = buildUncoveredOps(source, covered, options);
  if (ops.length === 0) {
    return source;
  }

  const edits = planEdits(parsed.ast, ops, source);
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

  return cleanupWhitespace(edited, collectProtectedSpans(reparsed.ast));
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
  const refs = buildReferenceIndex(ast);
  const edits: PlannedEdit[] = [];

  for (const op of ops) {
    visitStatementList(ast.body, op, source, refs, edits);
  }

  return dedupeEdits(edits);
}

/** All identifier spans that read a name (excludes declarations, keys, labels). */
function buildReferenceIndex(ast: Program): Map<string, ByteRange[]> {
  const refs = new Map<string, ByteRange[]>();

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
    forEachChild(node, (child, childKey) => visit(child, node, childKey));
  }

  visit(ast, null, null);
  return refs;
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
    case 'RestElement':
    case 'ArrayPattern':
    case 'ObjectPattern':
    case 'AssignmentPattern':
      // Identifiers directly inside binding patterns create bindings.
      return key !== 'elements' && key !== 'left' && key !== 'argument' && key !== 'properties';
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

function visitStatementList(
  statements: Node[],
  op: UncoveredOp,
  source: string,
  refs: Map<string, ByteRange[]>,
  edits: PlannedEdit[],
): void {
  for (const stmt of statements) {
    if (!overlaps(stmt, op)) continue;
    if (whollyInside(stmt, op)) {
      const edit = replaceStatement(stmt, source, refs);
      if (edit) edits.push(edit);
    } else {
      visitPartial(stmt, op, source, refs, edits);
    }
  }
}

/** Replacement for a statement wholly inside an uncovered range. */
function replaceStatement(
  stmt: Node,
  source: string,
  refs: Map<string, ByteRange[]>,
): PlannedEdit | null {
  switch (stmt.type) {
    case 'FunctionDeclaration': {
      const fn = stmt as acorn.FunctionDeclaration;
      // Deleting a hoisted declaration whose name covered code still
      // references would turn that reference into a ReferenceError, so
      // referenced functions are hollowed instead of deleted.
      if (fn.id && isReferencedOutside(refs, fn.id.name, stmt)) {
        return hollowFunctionBody(fn, source);
      }
      return { start: stmt.start, end: stmt.end, text: '' };
    }
    case 'ClassDeclaration': {
      const cls = stmt as acorn.ClassDeclaration;
      if (cls.id && isReferencedOutside(refs, cls.id.name, stmt)) {
        return {
          start: stmt.start,
          end: stmt.end,
          text: `${source.slice(stmt.start, cls.body.start)}{}`,
        };
      }
      return { start: stmt.start, end: stmt.end, text: '' };
    }
    case 'VariableDeclaration':
      return replaceVariableDeclaration(stmt as acorn.VariableDeclaration, source);
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
      // Imports create bindings and have side effects; export * shapes the
      // module interface. Never touch them.
      return null;
    case 'ExportNamedDeclaration':
    case 'ExportDefaultDeclaration': {
      const decl = (stmt as acorn.ExportNamedDeclaration | acorn.ExportDefaultDeclaration)
        .declaration as Node | null | undefined;
      if (!decl) return null;
      // Keep the module interface: hollow the exported declaration in place.
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
    case 'EmptyStatement':
    default:
      return { start: stmt.start, end: stmt.end, text: '' };
  }
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

function replaceSwitchCase(node: acorn.SwitchCase, source: string): PlannedEdit | null {
  if (node.consequent.length === 0) return null;
  // Keep `case <test>:` so side-effectful test evaluation and clause order
  // survive, and never synthesize `default:` (it can collide with a real one).
  const labelEnd = node.consequent[0]!.start;
  const label = source.slice(node.start, labelEnd).trimEnd();
  return { start: node.start, end: node.end, text: `${label} break;` };
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

/** Recurse into a node that overlaps but is not wholly inside the op. */
function visitPartial(
  node: Node,
  op: UncoveredOp,
  source: string,
  refs: Map<string, ByteRange[]>,
  edits: PlannedEdit[],
): void {
  switch (node.type) {
    case 'BlockStatement':
      visitStatementList((node as acorn.BlockStatement).body, op, source, refs, edits);
      return;

    case 'IfStatement': {
      const n = node as acorn.IfStatement;
      if (n.alternate && whollyInside(n.alternate, op)) {
        const elseEdit = removeElseBranch(n, source);
        if (elseEdit) edits.push(elseEdit);
      } else if (n.alternate && overlaps(n.alternate, op)) {
        visitPartial(n.alternate, op, source, refs, edits);
      }
      if (whollyInside(n.consequent, op)) {
        edits.push({
          start: n.consequent.start,
          end: n.consequent.end,
          text: n.consequent.type === 'BlockStatement' ? '{}' : ';',
        });
      } else if (overlaps(n.consequent, op)) {
        visitPartial(n.consequent, op, source, refs, edits);
      }
      return;
    }

    case 'SwitchStatement': {
      for (const switchCase of (node as acorn.SwitchStatement).cases) {
        if (!overlaps(switchCase, op)) continue;
        if (whollyInside(switchCase, op)) {
          const edit = replaceSwitchCase(switchCase, source);
          if (edit) edits.push(edit);
        } else {
          visitStatementList(switchCase.consequent, op, source, refs, edits);
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
          visitPartial(branch, op, source, refs, edits);
        }
      }
      if (overlaps(n.test, op) && !whollyInside(n.test, op)) {
        visitPartial(n.test, op, source, refs, edits);
      }
      return;
    }

    case 'LogicalExpression': {
      const n = node as acorn.LogicalExpression;
      if (whollyInside(n.right, op)) {
        edits.push(expressionEdit(n.right, source));
      } else if (overlaps(n.right, op)) {
        visitPartial(n.right, op, source, refs, edits);
      }
      if (overlaps(n.left, op) && !whollyInside(n.left, op)) {
        visitPartial(n.left, op, source, refs, edits);
      }
      return;
    }

    case 'TryStatement': {
      // Never prune inside catch: stubbing an error path swallows errors the
      // application would otherwise report.
      const n = node as acorn.TryStatement;
      if (overlaps(n.block, op)) visitPartial(n.block, op, source, refs, edits);
      if (n.finalizer && overlaps(n.finalizer, op)) {
        visitPartial(n.finalizer, op, source, refs, edits);
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
          visitPartial(value, op, source, refs, edits);
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
            const edit = replaceStatement(child, source, refs);
            if (edit) edits.push(edit);
          } else {
            visitPartial(child, op, source, refs, edits);
          }
          // Other expression kinds wholly inside an uncovered range are left
          // alone unless a structural rule above (ternary/logical branches)
          // applies: under-pruning is safe, guessing replacements is not.
        } else {
          visitPartial(child, op, source, refs, edits);
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

/** Delete `else <branch>` entirely; the covered part of the if survives. */
function removeElseBranch(ifNode: acorn.IfStatement, source: string): PlannedEdit | null {
  const alternate = ifNode.alternate;
  if (!alternate) return null;
  const gap = source.slice(ifNode.consequent.end, alternate.start);
  const match = findElseKeyword(gap);
  if (match === null) return null;
  return { start: ifNode.consequent.end + match, end: alternate.end, text: '' };
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
