import { describe, expect, it } from 'vitest';
import { hashSource } from './hash.js';
import { importV8Coverage, mergeV2Reports } from './import.js';
import { normalizeReport } from './normalize.js';

const SOURCE = "const a = 1;\nfunction dead() { return 2; }\nconsole.log(a);\n";

describe('importV8Coverage', () => {
  it('imports a NODE_V8_COVERAGE / CDP result object and skips node internals', () => {
    const report = importV8Coverage({
      result: [
        { scriptId: '1', url: 'node:internal/modules/cjs/loader', functions: [] },
        { scriptId: '2', url: '', functions: [] },
        {
          scriptId: '3',
          url: 'file:///app/main.js',
          functions: [
            {
              functionName: '',
              isBlockCoverage: true,
              ranges: [{ startOffset: 0, endOffset: 10, count: 1 }],
            },
          ],
        },
      ],
    });

    expect(report.version).toBe(2);
    expect(report.meta.offsets).toBe('utf16CodeUnits');
    expect(report.scripts.map((s) => s.url)).toEqual(['file:///app/main.js']);
    expect(report.scripts[0]!.scriptId).toBe('3');
  });

  it('imports Playwright stopJSCoverage output and hashes the embedded source', () => {
    const report = importV8Coverage([
      {
        url: 'http://localhost:3000/app.js',
        scriptId: '5',
        source: SOURCE,
        functions: [
          {
            functionName: '',
            isBlockCoverage: true,
            ranges: [{ startOffset: 0, endOffset: SOURCE.length, count: 1 }],
          },
          {
            functionName: 'dead',
            isBlockCoverage: true,
            ranges: [{ startOffset: 13, endOffset: 41, count: 0 }],
          },
        ],
      },
    ]);

    expect(report.scripts[0]!.sourceHash).toBe(hashSource(SOURCE));
    const entry = normalizeReport(report).entries[0]!;
    // The dead function is neither covered nor stubbed, so the pruner deletes it.
    expect(entry.ranges).toEqual([
      { start: 0, end: 13 },
      { start: 41, end: SOURCE.length },
    ]);
    expect(entry.stubRanges).toBeUndefined();
  });

  /**
   * The DevTools Coverage panel (and Playwright's CSS coverage) export used
   * ranges with no counts. There is no way to tell an unexecuted branch from a
   * dead function, so every used range is executed and everything else is
   * treated as never executed — the report-v1 model.
   */
  it('imports a DevTools coverage export, splitting JS from CSS by URL', () => {
    const report = importV8Coverage([
      {
        url: 'https://example.com/app.js',
        text: SOURCE,
        ranges: [
          { start: 41, end: SOURCE.length },
          { start: 0, end: 13 },
        ],
      },
      { url: 'https://example.com/site.css?v=2', text: 'a{color:red}b{color:blue}', ranges: [{ start: 0, end: 12 }] },
    ]);

    expect(report.scripts).toHaveLength(1);
    expect(report.stylesheets).toHaveLength(1);
    expect(report.stylesheets[0]!.ranges).toEqual([{ start: 0, end: 12 }]);

    const entries = normalizeReport(report).entries;
    const js = entries.find((e) => e.kind === 'js')!;
    expect(js.ranges).toEqual([
      { start: 0, end: 13 },
      { start: 41, end: SOURCE.length },
    ]);
    expect(js.stubRanges).toBeUndefined();
  });

  it('rejects input that is neither a V8 array nor a result object', () => {
    expect(() => importV8Coverage({ nope: true })).toThrow(/expected a V8 coverage array/);
    expect(() => importV8Coverage([{ url: 'a.js' }])).toThrow(/neither a "functions" nor a "ranges"/);
    expect(() => importV8Coverage([{ functions: [] }])).toThrow(/has no url/);
  });

  it('concatenates reports so the resolver can union their ranges', () => {
    const one = importV8Coverage([{ url: 'a.js', text: 'x', ranges: [{ start: 0, end: 1 }] }]);
    const two = importV8Coverage([{ url: 'b.css', text: 'y', ranges: [{ start: 0, end: 1 }] }]);
    const merged = mergeV2Reports([one, two], '/root');
    expect(merged.rootDir).toBe('/root');
    expect(merged.scripts).toHaveLength(1);
    expect(merged.stylesheets).toHaveLength(1);
  });
});
