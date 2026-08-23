import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolvePruneTargets } from './resolve.js';
import type { CoverageReport } from '../report/types.js';
import type { ResolvedPruneConfig } from '../config/types.js';
import { defaultSourcePath } from '../utils/paths.js';

let rootDir: string;

beforeAll(async () => {
  rootDir = await realpath(await mkdtemp(path.join(tmpdir(), 'coverkill-resolve-')));
});

function makeConfig(overrides: Partial<ResolvedPruneConfig> = {}): ResolvedPruneConfig {
  return { rootDir, preserveLicenseHeader: true, ...overrides };
}

function makeReport(entries: CoverageReport['entries']): CoverageReport {
  return { version: 1, collectedAt: 'now', rootDir, entries };
}

describe('resolvePruneTargets', () => {
  it('merges same-file entries with identical source (covered-wins union)', async () => {
    const source = 'console.log("one");\nconsole.log("two");\n';
    await writeFile(path.join(rootDir, 'merge.js'), source, 'utf8');
    const { targets, skipped } = await resolvePruneTargets(
      makeReport([
        { url: 'http://x/merge.js', source, kind: 'js', ranges: [{ start: 0, end: 19 }] },
        { url: 'http://x/merge.js', source, kind: 'js', ranges: [{ start: 20, end: 39 }] },
      ]),
      makeConfig(),
    );
    expect(skipped).toEqual([]);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.ranges).toEqual([
      { start: 0, end: 19 },
      { start: 20, end: 39 },
    ]);
  });

  // Regression: pruning from a subset of same-file entries deletes code that
  // executed during the dropped entry's run. Unmergeable entries poison the
  // whole file.
  it('skips a file entirely when same-file entries disagree on source text', async () => {
    const lf = 'console.log("one");\nconsole.log("two");\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    await writeFile(path.join(rootDir, 'poison.js'), lf, 'utf8');
    const { targets, skipped } = await resolvePruneTargets(
      makeReport([
        { url: 'http://x/poison.js', source: lf, kind: 'js', ranges: [{ start: 0, end: 19 }] },
        { url: 'http://x/poison.js', source: crlf, kind: 'js', ranges: [{ start: 21, end: 41 }] },
      ]),
      makeConfig(),
    );
    expect(targets).toEqual([]);
    expect(skipped.some((s) => s.reason.includes('disagree'))).toBe(true);
  });

  it('poisons order-independently (mismatching entry first)', async () => {
    const lf = 'console.log("one");\nconsole.log("two");\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    await writeFile(path.join(rootDir, 'poison2.js'), lf, 'utf8');
    const { targets } = await resolvePruneTargets(
      makeReport([
        { url: 'http://x/poison2.js', source: crlf, kind: 'js', ranges: [{ start: 21, end: 41 }] },
        { url: 'http://x/poison2.js', source: lf, kind: 'js', ranges: [{ start: 0, end: 19 }] },
      ]),
      makeConfig(),
    );
    expect(targets).toEqual([]);
  });

  it('skips a file when same-path entries disagree on kind', async () => {
    const source = '.a { color: red; }\n';
    await writeFile(path.join(rootDir, 'kind.css'), source, 'utf8');
    const { targets } = await resolvePruneTargets(
      makeReport([
        { url: 'http://x/kind.css', source, kind: 'css', ranges: [{ start: 0, end: 18 }] },
        { url: 'http://y/kind.css', source, kind: 'js', ranges: [{ start: 0, end: 5 }] },
      ]),
      makeConfig(),
    );
    expect(targets).toEqual([]);
  });

  it('treats an explicit null from sourcePath as skip, not fallback', async () => {
    const source = 'console.log("hi");\n';
    await writeFile(path.join(rootDir, 'mapped.js'), source, 'utf8');
    const { targets, skipped } = await resolvePruneTargets(
      makeReport([
        { url: 'http://x/mapped.js', source, kind: 'js', ranges: [{ start: 0, end: 18 }] },
      ]),
      makeConfig({ sourcePath: () => null }),
    );
    expect(targets).toEqual([]);
    expect(skipped[0]!.reason).toBe('no sourcePath mapping');
  });

  it('skips entries without embedded source text', async () => {
    await writeFile(path.join(rootDir, 'nosrc.js'), 'console.log(1);\n', 'utf8');
    const { targets, skipped } = await resolvePruneTargets(
      makeReport([
        { url: 'http://x/nosrc.js', source: '', kind: 'js', ranges: [{ start: 0, end: 5 }] },
      ]),
      makeConfig(),
    );
    expect(targets).toEqual([]);
    expect(skipped[0]!.reason).toContain('no embedded source');
  });
});

describe('defaultSourcePath containment', () => {
  it('never maps outside rootDir', () => {
    const root = path.resolve('/tmp/project');
    expect(defaultSourcePath('http://x/app.js', root)).toBe(path.join(root, 'app.js'));
    // Plain dot segments are normalized away by URL parsing and stay inside.
    expect(defaultSourcePath('http://x/../../etc/hosts', root)).toBe(
      path.join(root, 'etc/hosts'),
    );
    // Encoded slashes survive URL normalization and must be rejected.
    expect(defaultSourcePath('http://x/a%2f..%2f..%2f..%2fetc%2fhosts', root)).toBeNull();
    // Bare-path form with literal traversal.
    expect(defaultSourcePath('/../../etc/hosts', root)).toBeNull();
  });
});
