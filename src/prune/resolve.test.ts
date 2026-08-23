import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolvePruneTargets } from './resolve.js';
import type { CoverageReportV1 } from '../report/types.js';
import type { ResolvedPruneConfig } from '../config/types.js';
import { defaultSourcePath } from '../utils/paths.js';
import { hashSource } from '../report/hash.js';

let rootDir: string;

beforeAll(async () => {
  rootDir = await realpath(await mkdtemp(path.join(tmpdir(), 'coverkill-resolve-')));
});

function makeConfig(overrides: Partial<ResolvedPruneConfig> = {}): ResolvedPruneConfig {
  return { rootDir, preserveLicenseHeader: true, ...overrides };
}

function makeReport(entries: CoverageReportV1['entries']): CoverageReportV1 {
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

  // Regression: Chrome CSS coverage does not survive navigations, so a page
  // instance navigated away from yields a zero-range entry even though its
  // rules were used. That entry must poison the file, not be skipped past.
  it('skips a CSS file when one instance lost its usage to navigation', async () => {
    const source = '.page1 { color: red; }\n.page2 { color: blue; }\n';
    await writeFile(path.join(rootDir, 'shared.css'), source, 'utf8');
    const { targets, skipped } = await resolvePruneTargets(
      makeReport([
        { url: 'http://x/shared.css', source, kind: 'css', ranges: [] },
        { url: 'http://x/shared.css', source, kind: 'css', ranges: [{ start: 23, end: 46 }] },
      ]),
      makeConfig(),
    );
    expect(targets).toEqual([]);
    expect(skipped.some((s) => s.reason.includes('navigation'))).toBe(true);
  });

  it('still plain-skips a zero-range JS entry without poisoning', async () => {
    const source = 'console.log("one");\nconsole.log("two");\n';
    await writeFile(path.join(rootDir, 'zero.js'), source, 'utf8');
    const { targets } = await resolvePruneTargets(
      makeReport([
        { url: 'http://x/zero.js', source, kind: 'js', ranges: [] },
        { url: 'http://x/zero.js', source, kind: 'js', ranges: [{ start: 0, end: 19 }] },
      ]),
      makeConfig(),
    );
    expect(targets).toHaveLength(1);
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

// Report v2 may ship a hash instead of the executed text. The hash then has to
// carry the whole guard: the file on disk is usable only if it hashes to what
// the collector recorded, exactly (differing line endings shift every offset,
// so the CRLF tolerance that applies to embedded source cannot apply here).
describe('resolvePruneTargets with hash-only entries', () => {
  it('recovers the source from disk when the hash matches', async () => {
    const source = 'console.log("one");\nconsole.log("two");\n';
    await writeFile(path.join(rootDir, 'hashed.js'), source, 'utf8');
    const { targets, skipped } = await resolvePruneTargets(
      makeReport([
        {
          url: 'http://x/hashed.js',
          sourceHash: hashSource(source),
          kind: 'js',
          ranges: [{ start: 0, end: 19 }],
        },
      ]),
      makeConfig(),
    );
    expect(skipped).toEqual([]);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.source).toBe(source);
  });

  it('skips the file when the hash does not match disk', async () => {
    await writeFile(path.join(rootDir, 'stale.js'), 'console.log("new");\n', 'utf8');
    const { targets, skipped } = await resolvePruneTargets(
      makeReport([
        {
          url: 'http://x/stale.js',
          sourceHash: hashSource('console.log("old");\n'),
          kind: 'js',
          ranges: [{ start: 0, end: 19 }],
        },
      ]),
      makeConfig(),
    );
    expect(targets).toEqual([]);
    expect(skipped[0]!.reason).toContain('does not match sourceHash');
  });

  it('skips the file when embedded source and its own hash disagree', async () => {
    const source = 'console.log("one");\n';
    await writeFile(path.join(rootDir, 'inconsistent.js'), source, 'utf8');
    const { targets, skipped } = await resolvePruneTargets(
      makeReport([
        {
          url: 'http://x/inconsistent.js',
          source,
          sourceHash: hashSource('something else'),
          kind: 'js',
          ranges: [{ start: 0, end: 19 }],
        },
      ]),
      makeConfig(),
    );
    expect(targets).toEqual([]);
    expect(skipped[0]!.reason).toContain('its own sourceHash');
  });

  it('accepts a v2 report directly and carries sourceType through', async () => {
    const source = 'export const a = 1;\nconsole.log(a);\n';
    await writeFile(path.join(rootDir, 'mod.js'), source, 'utf8');
    const { targets } = await resolvePruneTargets(
      {
        version: 2,
        meta: { collectedAt: 'now', offsets: 'utf16CodeUnits' },
        rootDir,
        scripts: [
          {
            url: 'http://x/mod.js',
            sourceType: 'module',
            sourceHash: hashSource(source),
            functions: [
              {
                functionName: '',
                isBlockCoverage: true,
                ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }],
              },
            ],
          },
        ],
        stylesheets: [],
      },
      makeConfig(),
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]!.sourceType).toBe('module');
    expect(targets[0]!.source).toBe(source);
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
