import * as acorn from 'acorn';
import type { Node, Program } from 'acorn';
import type { ByteRange } from '../report/types.js';
import { invertRanges, mergeRanges, subtractRanges } from '../report/merge.js';
import type { RemoveUncoveredOptions } from './ranges.js';

type PruneOp = { kind: 'delete' | 'stub'; start: number; end: number };

type PlannedEdit = { start: number; end: number; text: string };

const PARSE_OPTIONS: acorn.Options = {
  ecmaVersion: 'latest',
  sourceType: 'script',
  allowHashBang: true,
  ranges: true,
};

/** AST-aware pruning with syntax validation; falls back to byte slicing on parse failure. */
export function removeUncoveredRangesAst(
  source: string,
  covered: ByteRange[],
  options?: RemoveUncoveredOptions,
): string | null {
  let ast: Program;
  try {
    ast = acorn.parse(source, PARSE_OPTIONS) as Program;
  } catch (err) {
    debugAst('initial parse failed: %s', err instanceof Error ? err.message : String(err));
    return null;
  }

  const ops = buildPruneOpsFromCoverage(source, covered, options);
  if (ops.length === 0) {
    return source;
  }

  const parentMap = buildParentMap(ast);
  const edits = planEdits(ast, ops, parentMap, source);
  if (edits.length === 0) {
    debugAst('no edits planned for %d ops', ops.length);
    return null;
  }

  let result = applyEdits(source, edits);
  result = postProcess(result);

  try {
    acorn.parse(result, PARSE_OPTIONS);
  } catch (err) {
    debugAst('post-edit parse failed: %s', err instanceof Error ? err.message : String(err));
    return null;
  }

  if (result.length === 0) {
    debugAst('post-edit result empty');
    return null;
  }

  return result;
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

function buildPruneOpsFromCoverage(
  source: string,
  covered: ByteRange[],
  options?: RemoveUncoveredOptions,
): PruneOp[] {
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

  const stubs = mergeRanges(options?.stubRanges ?? []);
  const effectiveCovered = stubs.length > 0 ? subtractRanges(merged, stubs) : merged;
  const adjustedCovered =
    protectedEnd > 0
      ? mergeRanges([{ start: 0, end: protectedEnd }, ...effectiveCovered])
      : effectiveCovered;

  const uncovered = invertRanges(source.length, adjustedCovered);
  return buildPruneOps(uncovered, stubs);
}

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

  return ops;
}

function buildParentMap(ast: Program): Map<Node, Node> {
  const parents = new Map<Node, Node>();

  function visit(node: Node, parent: Node | null): void {
    if (parent) {
      parents.set(node, parent);
    }
    for (const key of Object.keys(node)) {
      const value = (node as unknown as Record<string, unknown>)[key];
      if (!value) continue;
      if (Array.isArray(value)) {
        for (const child of value) {
          if (isAstNode(child)) visit(child, node);
        }
      } else if (isAstNode(value)) {
        visit(value, node);
      }
    }
  }

  visit(ast, null);
  return parents;
}

function isAstNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'type' in value && 'start' in value;
}

function planEdits(
  ast: Program,
  ops: PruneOp[],
  parentMap: Map<Node, Node>,
  source: string,
): PlannedEdit[] {
  const bySpan = new Map<string, PlannedEdit>();

  for (const op of ops) {
    const bounds = trimOpBounds(source, op);
    let node =
      findInnermostContaining(ast, bounds.start, bounds.end) ??
      findLargestNodeInRange(ast, bounds.start, bounds.end);
    if (!node) continue;

    while (node && shouldClimb(node, op)) {
      const child = intersectedChild(node, op);
      if (child) {
        node = child;
        continue;
      }
      node = parentMap.get(node) ?? null;
    }
    if (!node || node.type === 'Program') continue;

    let editStart = node.start;
    let editEnd = node.end;
    let text = replacementForNode(node, op.kind, source, parentMap);
    if (text === null) continue;

    const elseEdit = elseBranchEdit(node, source, parentMap);
    if (elseEdit) {
      editStart = elseEdit.start;
      editEnd = elseEdit.end;
      text = elseEdit.text;
    }

    const key = `${editStart}:${editEnd}`;
    const existing = bySpan.get(key);
    if (!existing || existing.text.length > text.length) {
      bySpan.set(key, { start: editStart, end: editEnd, text });
    }
  }

  return dedupeNestedEdits([...bySpan.values()]);
}

function dedupeNestedEdits(edits: PlannedEdit[]): PlannedEdit[] {
  const sorted = [...edits].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: PlannedEdit[] = [];

  for (const edit of sorted) {
    const outer = kept.find((k) => k.start <= edit.start && k.end >= edit.end);
    if (outer) continue;
    const innerIdx = kept.findIndex((k) => edit.start <= k.start && edit.end >= k.end);
    if (innerIdx >= 0) {
      kept.splice(innerIdx, 1);
    }
    kept.push(edit);
  }

  return kept.sort((a, b) => b.start - a.start);
}

function trimOpBounds(source: string, op: PruneOp): { start: number; end: number } {
  let start = op.start;
  let end = op.end;
  while (start < end && /\s/.test(source[start]!)) start++;
  while (end > start && /\s/.test(source[end - 1]!)) end--;
  return { start, end };
}

function findInnermostContaining(root: Node, start: number, end: number): Node | null {
  let best: Node | null = null;

  function visit(node: Node): void {
    if (node.type === 'Program') {
      for (const key of Object.keys(node)) {
        const value = (node as unknown as Record<string, unknown>)[key];
        if (!value) continue;
        if (Array.isArray(value)) {
          for (const child of value) {
            if (isAstNode(child)) visit(child);
          }
        } else if (isAstNode(value)) {
          visit(value);
        }
      }
      return;
    }
    if (node.start === undefined || node.end === undefined) return;
    if (node.start <= start && node.end >= end) {
      if (!best || node.end - node.start < best.end - best.start) {
        best = node;
      }
    }
    for (const key of Object.keys(node)) {
      const value = (node as unknown as Record<string, unknown>)[key];
      if (!value) continue;
      if (Array.isArray(value)) {
        for (const child of value) {
          if (isAstNode(child)) visit(child);
        }
      } else if (isAstNode(value)) {
        visit(value);
      }
    }
  }

  visit(root);
  return best;
}

/** Largest AST node fully inside [start, end) — for delete ops that include surrounding whitespace. */
function findLargestNodeInRange(root: Node, start: number, end: number): Node | null {
  let best: Node | null = null;

  function visit(node: Node): void {
    if (node.type === 'Program') {
      for (const stmt of (node as Program).body) {
        visit(stmt);
      }
      return;
    }
    if (node.start === undefined || node.end === undefined) return;
    if (node.start >= start && node.end <= end) {
      if (!best || node.end - node.start > best.end - best.start) {
        best = node;
      }
    }
    for (const key of Object.keys(node)) {
      const value = (node as unknown as Record<string, unknown>)[key];
      if (!value) continue;
      if (Array.isArray(value)) {
        for (const child of value) {
          if (isAstNode(child)) visit(child);
        }
      } else if (isAstNode(value)) {
        visit(value);
      }
    }
  }

  visit(root);
  return best;
}

function intersectedChild(node: Node, op: PruneOp): Node | null {
  if (node.type === 'IfStatement') {
    const n = node as acorn.IfStatement;
    if (n.alternate && rangesOverlap(n.alternate, op)) return n.alternate;
    if (rangesOverlap(n.consequent, op)) return n.consequent;
    return null;
  }

  if (node.type === 'ConditionalExpression') {
    const n = node as acorn.ConditionalExpression;
    if (rangesOverlap(n.consequent, op)) return n.consequent;
    if (rangesOverlap(n.alternate, op)) return n.alternate;
    if (rangesOverlap(n.test, op)) return n.test;
    return null;
  }

  return null;
}

function rangesOverlap(node: Node, op: PruneOp): boolean {
  return node.start < op.end && node.end > op.start;
}

function shouldClimb(node: Node, op: PruneOp): boolean {
  if (node.type === 'ConditionalExpression') {
    const n = node as acorn.ConditionalExpression;
    return !(
      whollyWithin(n.test, op) ||
      whollyWithin(n.consequent, op) ||
      whollyWithin(n.alternate, op)
    );
  }

  if (node.type === 'IfStatement') {
    const n = node as acorn.IfStatement;
    if (whollyWithin(n.test, op)) return false;
    if (whollyWithin(n.consequent, op)) return false;
    if (n.alternate && whollyWithin(n.alternate, op)) return false;
    return true;
  }

  if (node.type === 'LogicalExpression') {
    const n = node as acorn.LogicalExpression;
    return !(whollyWithin(n.left, op) || whollyWithin(n.right, op));
  }

  if (node.type === 'SequenceExpression') {
    const n = node as acorn.SequenceExpression;
    return !n.expressions.some((expr) => whollyWithin(expr, op));
  }

  if (node.type === 'MemberExpression' || node.type === 'CallExpression') {
    return false;
  }

  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
    const n = node as acorn.ArrowFunctionExpression;
    if (n.body.type === 'BlockStatement') {
      return !whollyWithin(n.body, op);
    }
    return !whollyWithin(n.body, op);
  }

  return false;
}

function whollyWithin(node: Node, op: PruneOp): boolean {
  return node.start <= op.start && node.end >= op.end;
}

function elseBranchEdit(
  node: Node,
  source: string,
  parentMap: Map<Node, Node>,
): PlannedEdit | null {
  const parent = parentMap.get(node);
  if (parent?.type !== 'IfStatement') return null;
  const ifNode = parent as acorn.IfStatement;
  if (ifNode.alternate !== node) return null;

  const elseIdx = source.lastIndexOf('else', node.start);
  if (elseIdx < 0 || elseIdx >= node.start) return null;

  const lead = source.slice(elseIdx, node.start);
  return { start: elseIdx, end: node.end, text: `${lead}{}` };
}

function replacementForNode(
  node: Node,
  kind: PruneOp['kind'],
  source: string,
  parentMap: Map<Node, Node>,
): string | null {
  if (kind === 'stub') {
    const text = source.slice(node.start, node.end);
    const elseMatch = text.match(/^(\s*)else\b/);
    if (elseMatch) {
      return `${elseMatch[1]}else {}`;
    }
    const trimmed = text.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      return '{}';
    }
  }

  switch (node.type) {
    case 'BlockStatement':
      return '{}';

    case 'ConditionalExpression':
      return '0';

    case 'FunctionDeclaration':
    case 'ClassDeclaration':
      return kind === 'delete' ? '' : null;

    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return kind === 'delete' ? '' : 'function(){}';

    case 'ExpressionStatement':
      return kind === 'delete' ? '' : ';';

    case 'EmptyStatement':
      return '';

    case 'SwitchCase':
      return 'default:break;';

    case 'VariableDeclaration':
    case 'LexicalDeclaration':
      return kind === 'delete' ? '' : ';';

    case 'ImportDeclaration':
    case 'ExportNamedDeclaration':
    case 'ExportDefaultDeclaration':
    case 'ExportAllDeclaration':
      return kind === 'delete' ? '' : null;

    default:
      if (isExpressionNode(node)) {
        return '0';
      }
      if (kind === 'delete') {
        return '';
      }
      return ';';
  }
}

function isExpressionNode(node: Node): boolean {
  const t = node.type;
  return (
    t.endsWith('Expression') ||
    t === 'Identifier' ||
    t === 'Literal' ||
    t === 'TemplateElement' ||
    t === 'Super' ||
    t === 'MetaProperty'
  );
}

function applyEdits(source: string, edits: PlannedEdit[]): string {
  let result = source;
  for (const edit of edits) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
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
    .replace(/^\s+$/gm, '')
    .replace(/\s+$/, '');
}
