import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCoverageReport, buildCoverageReportV2 } from '../collect/extract.js';
import type { JsCoverageEntry } from '../collect/extract.js';
import { hashSource } from './hash.js';
import { loadReport, saveReport, validateReport } from './io.js';
import { normalizeReport } from './normalize.js';
import type { CoverageReportV2 } from './types.js';

let rootDir: string;

beforeAll(async () => {
  rootDir = await realpath(await mkdtemp(path.join(tmpdir(), 'coverkill-report-v2-')));
});

const SOURCE = "function called(x) {\n  if (x > 0) {\n    return 'yes';\n  } else {\n    return 'no';\n  }\n}\nfunction dead() {\n  return 1;\n}\ncalled(5);\n";

const JS_PAYLOAD: JsCoverageEntry[] = [
  {
    url: 'http://localhost/app.js',
    scriptId: '7',
    source: SOURCE,
    functions: [
      {
        functionName: '',
        isBlockCoverage: true,
        ranges: [{ startOffset: 0, endOffset: SOURCE.length, count: 1 }],
      },
      {
        functionName: 'called',
        isBlockCoverage: true,
        ranges: [
          { startOffset: 0, endOffset: 68, count: 1 },
          { startOffset: 37, endOffset: 67, count: 0 },
        ],
      },
      {
        functionName: 'dead',
        isBlockCoverage: true,
        ranges: [{ startOffset: 69, endOffset: 99, count: 0 }],
      },
    ],
  },
];

function makeV2(overrides: Partial<CoverageReportV2> = {}): CoverageReportV2 {
  return {
    version: 2,
    meta: { collectedAt: 'now', offsets: 'utf16CodeUnits' },
    rootDir,
    scripts: [],
    stylesheets: [],
    ...overrides,
  };
}

describe('report v2', () => {
  // The whole point of v2: the raw counts survive into the report, and the
  // covered/stub/dead split is recomputed at prune time. Recomputing it must
  // land exactly where collect-time classification (v1) landed.
  it('classifies at prune time exactly as v1 classified at collect time', () => {
    const v1 = buildCoverageReport(rootDir, JS_PAYLOAD, []);
    const v2 = buildCoverageReportV2(rootDir, JS_PAYLOAD, []);

    expect(v2.scripts[0]!.functions).toEqual(JS_PAYLOAD[0]!.functions);
    const normalized = normalizeReport(v2).entries.map(({ sourceHash, ...rest }) => rest);
    expect(normalized).toEqual(v1.entries.map((e) => ({ ...e, sourceType: undefined })));
  });

  it('records the coordinate space and the settings that produced it', () => {
    const v2 = buildCoverageReportV2(rootDir, JS_PAYLOAD, [], {
      collectedAt: 'now',
      coverageSettings: { js: { resetOnNavigation: false } },
    });
    expect(v2.meta.offsets).toBe('utf16CodeUnits');
    expect(v2.meta.coverageSettings).toEqual({ js: { resetOnNavigation: false } });
    expect(v2.scripts[0]!.sourceHash).toBe(hashSource(SOURCE));
    expect(v2.scripts[0]!.source).toBe(SOURCE);
  });

  it('can omit source text and keep only its hash', () => {
    const v2 = buildCoverageReportV2(rootDir, JS_PAYLOAD, [], { includeSource: false });
    expect(v2.scripts[0]!.source).toBeUndefined();
    expect(v2.scripts[0]!.sourceHash).toBe(hashSource(SOURCE));
    expect(JSON.stringify(v2).length).toBeLessThan(
      JSON.stringify(buildCoverageReportV2(rootDir, JS_PAYLOAD, [])).length,
    );
  });

  it('keeps a stylesheet whose usage was lost, drops one with no information', () => {
    const v2 = buildCoverageReportV2(rootDir, [], [
      { url: 'http://localhost/lost.css', ranges: [{ start: 0, end: 10 }] },
      { url: 'http://localhost/nothing.css', ranges: [] },
    ]);
    expect(v2.stylesheets.map((s) => s.url)).toEqual(['http://localhost/lost.css']);
  });

  it('drops entries that carry neither coverage nor any source identity', () => {
    const normalized = normalizeReport(
      makeV2({
        scripts: [
          { url: 'http://localhost/empty.js', functions: [] },
          { url: 'http://localhost/known.js', sourceHash: hashSource(SOURCE), functions: [] },
        ],
        stylesheets: [{ url: 'http://localhost/ghost.css', ranges: [] }],
      }),
    );
    expect(normalized.entries.map((e) => e.url)).toEqual(['http://localhost/known.js']);
  });
});

describe('validateReport (v2)', () => {
  it('accepts a minimal report and defaults stylesheets', () => {
    const raw = { version: 2, meta: { collectedAt: 'now', offsets: 'utf16CodeUnits' }, rootDir, scripts: [] };
    const report = validateReport(raw) as CoverageReportV2;
    expect(report.stylesheets).toEqual([]);
  });

  it('rejects a report whose offsets are in an unknown coordinate space', () => {
    expect(() =>
      validateReport({ version: 2, meta: { collectedAt: 'now', offsets: 'bytes' }, rootDir, scripts: [] }),
    ).toThrow(/utf16CodeUnits/);
  });

  it('rejects ranges that run past the embedded source', () => {
    expect(() =>
      validateReport(
        makeV2({
          scripts: [
            {
              url: 'u',
              source: 'abc',
              functions: [
                {
                  functionName: '',
                  isBlockCoverage: true,
                  ranges: [{ startOffset: 0, endOffset: 99, count: 1 }],
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/exceeds source length 3/);
  });

  it('rejects non-integer counts and unknown versions', () => {
    expect(() =>
      validateReport(
        makeV2({
          scripts: [
            {
              url: 'u',
              functions: [
                {
                  functionName: '',
                  isBlockCoverage: true,
                  ranges: [{ startOffset: 0, endOffset: 1, count: 1.5 }],
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/must be integers/);
    expect(() => validateReport({ version: 3 })).toThrow(/unsupported report version: 3/);
  });
});

describe('loadReport', () => {
  it('round-trips a v2 report', async () => {
    const file = path.join(rootDir, 'report-v2.json');
    const report = buildCoverageReportV2(rootDir, JS_PAYLOAD, []);
    await saveReport(report, file);
    expect(await loadReport(file)).toEqual(JSON.parse(await readFile(file, 'utf8')));
  });

  it('still reads a v1 report', async () => {
    const file = path.join(rootDir, 'report-v1.json');
    await saveReport(buildCoverageReport(rootDir, JS_PAYLOAD, []), file);
    const loaded = await loadReport(file);
    expect(loaded.version).toBe(1);
  });

  // A NODE_V8_COVERAGE dump has no version field at all; feeding it straight
  // to `coverkill prune` is the point of this change.
  it('imports a raw NODE_V8_COVERAGE dump, hashing the source from disk', async () => {
    const scriptPath = path.join(rootDir, 'raw-dump.js');
    await writeFile(scriptPath, SOURCE, 'utf8');
    const dumpPath = path.join(rootDir, 'coverage-1.json');
    await writeFile(
      dumpPath,
      JSON.stringify({
        result: [
          { scriptId: '1', url: 'node:internal/bootstrap', functions: [] },
          { scriptId: '2', url: pathToFileURL(scriptPath).href, functions: JS_PAYLOAD[0]!.functions },
        ],
      }),
      'utf8',
    );

    const report = (await loadReport(dumpPath)) as CoverageReportV2;
    expect(report.version).toBe(2);
    expect(report.scripts).toHaveLength(1);
    expect(report.scripts[0]!.sourceHash).toBe(hashSource(SOURCE));
    expect(report.scripts[0]!.source).toBeUndefined();
  });

  it('refuses to vouch for a file that no longer fits the coverage offsets', async () => {
    const scriptPath = path.join(rootDir, 'edited.js');
    await writeFile(scriptPath, `${SOURCE}// appended after the run\n`, 'utf8');
    const dumpPath = path.join(rootDir, 'coverage-edited.json');
    await writeFile(
      dumpPath,
      JSON.stringify({
        result: [{ url: pathToFileURL(scriptPath).href, functions: JS_PAYLOAD[0]!.functions }],
      }),
      'utf8',
    );

    const report = (await loadReport(dumpPath)) as CoverageReportV2;
    // No hash and no source: the resolver will skip the file rather than
    // slice it at offsets that belong to the pre-edit text.
    expect(report.scripts[0]!.sourceHash).toBeUndefined();
    expect(report.scripts[0]!.source).toBeUndefined();
  });

  it('imports a whole NODE_V8_COVERAGE directory', async () => {
    const dir = path.join(rootDir, 'v8-cov');
    const scriptPath = path.join(rootDir, 'raw-dir.js');
    await writeFile(scriptPath, SOURCE, 'utf8');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    for (const n of [1, 2]) {
      await writeFile(
        path.join(dir, `coverage-${n}.json`),
        JSON.stringify({
          result: [{ url: pathToFileURL(scriptPath).href, functions: JS_PAYLOAD[0]!.functions }],
        }),
        'utf8',
      );
    }
    const report = (await loadReport(dir)) as CoverageReportV2;
    expect(report.scripts).toHaveLength(2);
  });
});
