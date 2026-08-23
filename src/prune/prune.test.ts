import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { pruneFromReport } from './prune.js';
import { hashSource } from '../report/hash.js';
import type { CoverageReportV2 } from '../report/types.js';
import type { ResolvedPruneConfig } from '../config/types.js';

let rootDir: string;

beforeAll(async () => {
  rootDir = await realpath(await mkdtemp(path.join(tmpdir(), 'coverkill-prune-')));
});

const SOURCE = 'function dead() {\n  return 1;\n}\nconsole.log("live");\n';

describe('pruneFromReport with a report v2', () => {
  // The end-to-end shape an external runner produces: raw V8 counts, no
  // embedded source, only a hash vouching for the file on disk.
  it('prunes a file whose source lives only on disk, vouched for by its hash', async () => {
    const filePath = path.join(rootDir, 'app.js');
    await writeFile(filePath, SOURCE, 'utf8');

    const report: CoverageReportV2 = {
      version: 2,
      meta: { collectedAt: 'now', offsets: 'utf16CodeUnits' },
      rootDir,
      scripts: [
        {
          url: 'http://localhost/app.js',
          sourceType: 'script',
          sourceHash: hashSource(SOURCE),
          functions: [
            {
              functionName: '',
              isBlockCoverage: true,
              ranges: [{ startOffset: 0, endOffset: SOURCE.length, count: 1 }],
            },
            {
              functionName: 'dead',
              isBlockCoverage: true,
              ranges: [{ startOffset: 0, endOffset: 31, count: 0 }],
            },
          ],
        },
      ],
      stylesheets: [],
    };

    const config: ResolvedPruneConfig = { rootDir, preserveLicenseHeader: true };
    const result = await pruneFromReport(report, config);

    expect(result.skipped).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.written).toBe(true);
    const written = await readFile(filePath, 'utf8');
    expect(written).not.toContain('function dead');
    expect(written).toContain('console.log("live")');
  });

  it('leaves the file alone when disk drifted from the hash', async () => {
    const filePath = path.join(rootDir, 'drifted.js');
    await writeFile(filePath, SOURCE, 'utf8');

    const report: CoverageReportV2 = {
      version: 2,
      meta: { collectedAt: 'now', offsets: 'utf16CodeUnits' },
      rootDir,
      scripts: [
        {
          url: 'http://localhost/drifted.js',
          sourceHash: hashSource(`${SOURCE}// edited since collection\n`),
          functions: [
            {
              functionName: '',
              isBlockCoverage: true,
              ranges: [{ startOffset: 0, endOffset: 10, count: 1 }],
            },
          ],
        },
      ],
      stylesheets: [],
    };

    const result = await pruneFromReport(report, { rootDir, preserveLicenseHeader: true });
    expect(result.files).toEqual([]);
    expect(result.skipped[0]!.reason).toContain('does not match sourceHash');
    expect(await readFile(filePath, 'utf8')).toBe(SOURCE);
  });
});
