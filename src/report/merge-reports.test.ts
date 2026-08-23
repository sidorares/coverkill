import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { mergeReports } from './merge-reports.js';
import { hashSource } from './hash.js';
import { validateReport } from './io.js';
import type {
  CoverageReportV2,
  ScriptCoverageEntry,
  StyleSheetCoverageEntry,
} from './types.js';
import { resolvePruneTargets } from '../prune/resolve.js';

let rootDir: string;

beforeAll(async () => {
  rootDir = await realpath(await mkdtemp(path.join(tmpdir(), 'coverkill-merge-')));
});

function v2(
  entries: { scripts?: ScriptCoverageEntry[]; stylesheets?: StyleSheetCoverageEntry[] },
  meta: { collectedAt?: string; rootDir?: string } = {},
): CoverageReportV2 {
  return {
    version: 2,
    meta: { collectedAt: meta.collectedAt ?? '2026-01-01T00:00:00.000Z', offsets: 'utf16CodeUnits' },
    rootDir: meta.rootDir ?? rootDir,
    scripts: entries.scripts ?? [],
    stylesheets: entries.stylesheets ?? [],
  };
}

function script(url: string, source: string, overrides: Partial<ScriptCoverageEntry> = {}): ScriptCoverageEntry {
  return {
    url,
    source,
    sourceHash: hashSource(source),
    functions: [
      {
        functionName: '',
        isBlockCoverage: true,
        ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }],
      },
    ],
    ...overrides,
  };
}

describe('mergeReports', () => {
  it('concatenates entries and validates as a report v2', () => {
    const a = v2({ scripts: [script('http://x/a.js', 'a();\n')] });
    const b = v2({
      scripts: [script('http://x/b.js', 'b();\n')],
      stylesheets: [{ url: 'http://x/s.css', source: '.a{}\n', ranges: [{ start: 0, end: 4 }] }],
    });
    const merged = mergeReports([a, b]);
    expect(merged.scripts.map((s) => s.url)).toEqual(['http://x/a.js', 'http://x/b.js']);
    expect(merged.stylesheets).toHaveLength(1);
    expect(validateReport(merged)).toBe(merged);
  });

  it('records the newest collectedAt — the union is only as fresh as its newest run', () => {
    const merged = mergeReports([
      v2({}, { collectedAt: '2026-02-01T00:00:00.000Z' }),
      v2({}, { collectedAt: '2026-01-15T00:00:00.000Z' }),
    ]);
    expect(merged.meta.collectedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(merged.meta.source).toContain('merge');
  });

  // The core semantics: covered-anywhere-wins, applied by the same resolver
  // path that unions multi-entry reports from a single run. A function dead in
  // one run and executed in another must end up covered.
  it('unions coverage at prune time: dead-in-one-run, covered-in-another', async () => {
    const source = 'function a() { return 1; }\nfunction b() { return 2; }\n';
    await writeFile(path.join(rootDir, 'both.js'), source, 'utf8');

    const runA = v2({
      scripts: [
        script('http://x/both.js', source, {
          functions: [
            {
              functionName: '',
              isBlockCoverage: true,
              ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }],
            },
            { functionName: 'a', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 26, count: 1 }] },
            { functionName: 'b', isBlockCoverage: false, ranges: [{ startOffset: 27, endOffset: 53, count: 0 }] },
          ],
        }),
      ],
    });
    const runB = v2({
      scripts: [
        script('http://x/both.js', source, {
          functions: [
            {
              functionName: '',
              isBlockCoverage: true,
              ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }],
            },
            { functionName: 'a', isBlockCoverage: false, ranges: [{ startOffset: 0, endOffset: 26, count: 0 }] },
            { functionName: 'b', isBlockCoverage: true, ranges: [{ startOffset: 27, endOffset: 53, count: 1 }] },
          ],
        }),
      ],
    });

    const { targets, skipped } = await resolvePruneTargets(mergeReports([runA, runB]), {
      rootDir,
      preserveLicenseHeader: true,
    });
    expect(skipped).toEqual([]);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.ranges).toEqual([{ start: 0, end: source.length }]);
  });

  // A zero-range CSS entry means Chrome lost the usage data on navigation,
  // not that nothing was used. The merge must carry it through verbatim so it
  // still poisons the file at prune time.
  it('preserves zero-range CSS entries so they still poison at prune time', async () => {
    const source = '.page1 { color: red; }\n.page2 { color: blue; }\n';
    await writeFile(path.join(rootDir, 'shared.css'), source, 'utf8');

    const withUsage = v2({
      stylesheets: [{ url: 'http://x/shared.css', source, ranges: [{ start: 0, end: 22 }] }],
    });
    const lostUsage = v2({
      stylesheets: [{ url: 'http://x/shared.css', source, ranges: [] }],
    });

    const merged = mergeReports([withUsage, lostUsage]);
    expect(merged.stylesheets.some((s) => s.ranges.length === 0)).toBe(true);

    const { targets, skipped } = await resolvePruneTargets(merged, {
      rootDir,
      preserveLicenseHeader: true,
    });
    expect(targets).toEqual([]);
    expect(skipped.some((s) => s.reason.includes('navigation'))).toBe(true);
  });

  it('rejects report v1 inputs loudly', () => {
    const v1 = { version: 1 as const, collectedAt: 'now', rootDir, entries: [] };
    expect(() => mergeReports([v2({}), v1], { sourceNames: ['a.json', 'b.json'] })).toThrow(
      /b\.json.*report v1/,
    );
  });

  it('fails loudly when the same URL has different source text across runs', () => {
    const a = v2({ scripts: [script('http://x/app.js', 'old();\n')] });
    const b = v2({ scripts: [script('http://x/app.js', 'new();\n')] });
    expect(() => mergeReports([a, b], { sourceNames: ['run-a.json', 'run-b.json'] })).toThrow(
      /http:\/\/x\/app\.js.*run-b\.json.*run-a\.json[\s\S]*same build/,
    );
  });

  it('compares by hash when source text is stripped', () => {
    const a = v2({
      scripts: [script('http://x/app.js', 'old();\n', { source: undefined })],
    });
    const b = v2({
      scripts: [script('http://x/app.js', 'new();\n', { source: undefined })],
    });
    expect(() => mergeReports([a, b])).toThrow(/different builds/);
  });

  it('accepts the same URL when the source text agrees', () => {
    const source = 'app();\n';
    const a = v2({ scripts: [script('http://x/app.js', source)] });
    const b = v2({ scripts: [script('http://x/app.js', source)] });
    expect(mergeReports([a, b]).scripts).toHaveLength(2);
  });

  // One report may hold several hashes for one URL (inline scripts,
  // re-evaluated modules); that alone is not a build mismatch. Two reports
  // only conflict when their hash sets share nothing at all.
  it('tolerates several hashes per URL within and across reports when they overlap', () => {
    const a = v2({
      scripts: [script('http://x/page', 'inline1();\n'), script('http://x/page', 'inline2();\n')],
    });
    const b = v2({ scripts: [script('http://x/page', 'inline1();\n')] });
    expect(mergeReports([a, b]).scripts).toHaveLength(3);
  });

  it('requires an explicit rootDir when the inputs disagree', () => {
    const a = v2({}, { rootDir: '/proj/a' });
    const b = v2({}, { rootDir: '/proj/b' });
    expect(() => mergeReports([a, b])).toThrow(/disagree on rootDir/);
    expect(mergeReports([a, b], { rootDir: '/proj' }).rootDir).toBe('/proj');
  });

  it('rejects an empty input list', () => {
    expect(() => mergeReports([])).toThrow(/no input reports/);
  });
});
