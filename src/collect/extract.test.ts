import { describe, expect, it } from 'vitest';
import { buildCoverageReport, extractJsCoverage } from './extract.js';
import { validateReport } from '../report/io.js';

/**
 * Fixtures mirror real Playwright/Chrome output: V8 always emits a
 * whole-script entry (functionName "") whose single range spans the entire
 * source with count 1, executed functions get their own entries with count-0
 * sub-ranges for unexecuted blocks, and never-called functions appear as
 * isBlockCoverage:false entries with a single count-0 root range.
 * Offsets below were captured from Chromium via page.coverage.stopJSCoverage().
 */
describe('extractJsCoverage', () => {
  it('excludes a never-called top-level function from covered and stub (deletable)', () => {
    // (a) count-0 root range in block-coverage form.
    const source = "function dead() { return 1; }\nconsole.log('hi');\n";
    const entry = {
      url: 'http://localhost/app.js',
      scriptId: '1',
      source,
      functions: [
        {
          functionName: '',
          isBlockCoverage: true,
          ranges: [{ startOffset: 0, endOffset: 49, count: 1 }],
        },
        {
          functionName: 'dead',
          isBlockCoverage: true,
          ranges: [{ startOffset: 0, endOffset: 29, count: 0 }],
        },
      ],
    };

    const { covered, stub } = extractJsCoverage(entry);
    // Only the top-level code after the dead function stays covered.
    expect(covered).toEqual([{ start: 29, end: 49 }]);
    expect(stub).toEqual([]);
    expect(source.slice(29, 49)).toBe("\nconsole.log('hi');\n");
  });

  it('stubs the count-0 else-branch of a called function', () => {
    // (b) Real Chrome shape: the count-0 range starts at the space before the
    // `else` keyword and includes the else-block's closing brace.
    const source =
      "function called(x) {\n  if (x > 0) {\n    return 'positive';\n  } else {\n    return 'negative';\n  }\n}\ncalled(5);\n";
    expect(source.slice(62, 96)).toBe(" else {\n    return 'negative';\n  }");
    const entry = {
      url: 'http://localhost/app.js',
      scriptId: '1',
      source,
      functions: [
        {
          functionName: '',
          isBlockCoverage: true,
          ranges: [{ startOffset: 0, endOffset: 110, count: 1 }],
        },
        {
          functionName: 'called',
          isBlockCoverage: true,
          ranges: [
            { startOffset: 0, endOffset: 98, count: 1 },
            { startOffset: 62, endOffset: 96, count: 0 },
          ],
        },
      ],
    };

    const { covered, stub } = extractJsCoverage(entry);
    expect(covered).toEqual([
      { start: 0, end: 62 },
      { start: 96, end: 110 },
    ]);
    expect(stub).toEqual([{ start: 62, end: 96 }]);
  });

  it('stubs the count-0 tail after a taken early return', () => {
    // (c) Real Chrome shape: the count-0 range starts right after the
    // if-block's closing brace and stops just before the function's own `}`.
    const source =
      "function early(x) {\n  if (x) {\n    return 'early';\n  }\n  console.log('tail');\n  return 'tail';\n}\nearly(true);\n";
    expect(source.slice(54, 95)).toBe("\n  console.log('tail');\n  return 'tail';\n");
    const entry = {
      url: 'http://localhost/app.js',
      scriptId: '1',
      source,
      functions: [
        {
          functionName: '',
          isBlockCoverage: true,
          ranges: [{ startOffset: 0, endOffset: 110, count: 1 }],
        },
        {
          functionName: 'early',
          isBlockCoverage: true,
          ranges: [
            { startOffset: 0, endOffset: 96, count: 1 },
            { startOffset: 54, endOffset: 95, count: 0 },
          ],
        },
      ],
    };

    const { covered, stub } = extractJsCoverage(entry);
    expect(covered).toEqual([
      { start: 0, end: 54 },
      { start: 95, end: 110 },
    ]);
    expect(stub).toEqual([{ start: 54, end: 95 }]);
  });

  it('treats a never-called inner function as deletable while the outer function stays covered', () => {
    // (d) Nested dead function inside an executed outer function.
    const source =
      'function outer() {\n  function innerDead() {\n    return 42;\n  }\n  return 1;\n}\nouter();\n';
    expect(source.slice(21, 62)).toBe('function innerDead() {\n    return 42;\n  }');
    const entry = {
      url: 'http://localhost/app.js',
      scriptId: '1',
      source,
      functions: [
        {
          functionName: '',
          isBlockCoverage: true,
          ranges: [{ startOffset: 0, endOffset: 86, count: 1 }],
        },
        {
          functionName: 'outer',
          isBlockCoverage: true,
          ranges: [{ startOffset: 0, endOffset: 76, count: 1 }],
        },
        {
          functionName: 'innerDead',
          isBlockCoverage: false,
          ranges: [{ startOffset: 21, endOffset: 62, count: 0 }],
        },
      ],
    };

    const { covered, stub } = extractJsCoverage(entry);
    // innerDead's span [21, 62) is neither covered nor stub -> deletable.
    expect(covered).toEqual([
      { start: 0, end: 21 },
      { start: 62, end: 86 },
    ]);
    expect(stub).toEqual([]);
  });

  it('covers the whole file when everything executed', () => {
    // (e) No function declarations, no dead code: only the whole-script entry.
    const source = 'const x = 1;\nconsole.log(x);\n';
    const entry = {
      url: 'http://localhost/app.js',
      scriptId: '1',
      source,
      functions: [
        {
          functionName: '',
          isBlockCoverage: true,
          ranges: [{ startOffset: 0, endOffset: 29, count: 1 }],
        },
      ],
    };

    const { covered, stub } = extractJsCoverage(entry);
    expect(covered).toEqual([{ start: 0, end: 29 }]);
    expect(stub).toEqual([]);
  });

  it('treats an isBlockCoverage:false count-0 function as deletable and a count-N one as covered', () => {
    // (f) Real Chrome reports never-called functions without block coverage;
    // functions can also come back isBlockCoverage:false with count > 0.
    const source = "function dead(a, b) {\n  return a + b;\n}\nfunction hot() {}\nhot();\n";
    expect(source.slice(0, 39)).toBe('function dead(a, b) {\n  return a + b;\n}');
    expect(source.slice(40, 57)).toBe('function hot() {}');
    const entry = {
      url: 'http://localhost/app.js',
      scriptId: '1',
      source,
      functions: [
        {
          functionName: '',
          isBlockCoverage: true,
          ranges: [{ startOffset: 0, endOffset: 65, count: 1 }],
        },
        {
          functionName: 'dead',
          isBlockCoverage: false,
          ranges: [{ startOffset: 0, endOffset: 39, count: 0 }],
        },
        {
          functionName: 'hot',
          isBlockCoverage: false,
          ranges: [{ startOffset: 40, endOffset: 57, count: 3 }],
        },
      ],
    };

    const { covered, stub } = extractJsCoverage(entry);
    expect(covered).toEqual([{ start: 39, end: 65 }]);
    expect(stub).toEqual([]);
  });

  it('lets a dead function whose span equals the whole-script range stay uncovered', () => {
    // A script with no trailing newline whose only content is a dead function:
    // the "" whole-script count-1 range and the function's count-0 root are
    // byte-identical. The script root must sort outermost so the dead
    // function still nests inside it and its bytes stay uncovered.
    const source = "function dead(){ console.log('never'); }";
    const entry = {
      url: 'http://localhost/app.js',
      scriptId: '1',
      source,
      functions: [
        {
          functionName: '',
          isBlockCoverage: true,
          ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }],
        },
        {
          functionName: 'dead',
          isBlockCoverage: false,
          ranges: [{ startOffset: 0, endOffset: source.length, count: 0 }],
        },
      ],
    };

    const { covered, stub } = extractJsCoverage(entry);
    expect(covered).toEqual([]);
    expect(stub).toEqual([]);
  });

  it('emits a zero-range marker for entries whose source is missing', () => {
    // A saved report must always pass its own validation, and the resolver
    // must see that this file's usage data is incomplete.
    const report = buildCoverageReport(
      '/root',
      [
        {
          url: 'http://localhost/evicted.js',
          functions: [
            {
              functionName: '',
              isBlockCoverage: true,
              ranges: [{ startOffset: 0, endOffset: 40, count: 1 }],
            },
          ],
        },
        { url: 'http://localhost/nothing.js', functions: [] },
      ],
      [],
    );
    expect((report as { entries: unknown[] }).entries).toEqual([
      { url: 'http://localhost/evicted.js', source: '', kind: 'js', ranges: [] },
    ]);
    expect(() => validateReport(report)).not.toThrow();
  });

  it('handles an empty functions array and ignores zero-length ranges', () => {
    expect(
      extractJsCoverage({ url: 'http://localhost/app.js', source: 'const a = 1;', functions: [] }),
    ).toEqual({ covered: [], stub: [] });

    expect(
      extractJsCoverage({
        url: 'http://localhost/app.js',
        source: 'const a = 1;',
        functions: [
          {
            functionName: '',
            isBlockCoverage: true,
            ranges: [{ startOffset: 5, endOffset: 5, count: 1 }],
          },
        ],
      }),
    ).toEqual({ covered: [], stub: [] });
  });

  it('matches expectations on a verbatim capture from Chromium', () => {
    // Raw page.coverage.stopJSCoverage() output for this exact source,
    // captured from Playwright-driven Chromium.
    const source =
      "function called(x) {\n  if (x > 0) {\n    return 'positive';\n  } else {\n    return 'negative';\n  }\n}\n\nfunction dead(a, b) {\n  return a + b;\n}\n\nfunction outer() {\n  function innerDead() {\n    return 42;\n  }\n  return 1;\n}\n\nfunction early(x) {\n  if (x) {\n    return 'early';\n  }\n  console.log('tail');\n  return 'tail';\n}\n\ncalled(5);\nouter();\nearly(true);\nwindow.__done = true;\n";
    expect(source.length).toBe(372);
    const entry = {
      url: 'http://localhost/app.js',
      scriptId: '5',
      source,
      functions: [
        {
          functionName: '',
          isBlockCoverage: true,
          ranges: [{ startOffset: 0, endOffset: 372, count: 1 }],
        },
        {
          functionName: 'called',
          isBlockCoverage: true,
          ranges: [
            { startOffset: 0, endOffset: 98, count: 1 },
            { startOffset: 62, endOffset: 96, count: 0 },
          ],
        },
        {
          functionName: 'dead',
          isBlockCoverage: false,
          ranges: [{ startOffset: 100, endOffset: 139, count: 0 }],
        },
        {
          functionName: 'outer',
          isBlockCoverage: true,
          ranges: [{ startOffset: 141, endOffset: 217, count: 1 }],
        },
        {
          functionName: 'innerDead',
          isBlockCoverage: false,
          ranges: [{ startOffset: 162, endOffset: 203, count: 0 }],
        },
        {
          functionName: 'early',
          isBlockCoverage: true,
          ranges: [
            { startOffset: 219, endOffset: 315, count: 1 },
            { startOffset: 273, endOffset: 314, count: 0 },
          ],
        },
      ],
    };

    const { covered, stub } = extractJsCoverage(entry);
    expect(covered).toEqual([
      { start: 0, end: 62 },
      { start: 96, end: 100 },
      { start: 139, end: 162 },
      { start: 203, end: 273 },
      { start: 314, end: 372 },
    ]);
    expect(stub).toEqual([
      { start: 62, end: 96 },
      { start: 273, end: 314 },
    ]);
    // Dead function bodies fall in the gaps: deletable.
    expect(source.slice(100, 139)).toBe('function dead(a, b) {\n  return a + b;\n}');
    expect(source.slice(162, 203)).toBe('function innerDead() {\n    return 42;\n  }');
  });
});
