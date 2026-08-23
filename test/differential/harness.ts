/**
 * Differential testing harness for coverkill's JS pruner.
 *
 * Runs a fixture script under real Node/V8 coverage (NODE_V8_COVERAGE), feeds
 * the resulting `functions` array through coverkill's extract + prune pipeline,
 * then runs the pruned source again. Because a fixture is deterministic and
 * only observable via console.log, the two stdout captures must be identical
 * for every EXECUTED path — any difference is a pruner bug.
 *
 * Offset alignment (verified empirically on Node 18+ / Node 26): for both
 * `.cjs` and `.mjs` files, the V8 coverage JSON reports byte offsets relative
 * to the on-disk file text (the CJS module wrapper does NOT shift offsets —
 * Node compiles CJS via vm.compileFunction, so the wrapper text is not part of
 * the script source), and the entry `url` is a file:// URL in both cases.
 * Fixtures are written as `.cjs`. A defensive check below throws with a clear
 * message if a Node version ever reports offsets past the end of the file.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { JsCoverageEntry } from '../../src/collect/extract.js';
import { hashSource } from '../../src/report/hash.js';
import { validateReport } from '../../src/report/io.js';
import { normalizeReport } from '../../src/report/normalize.js';
import type { CoverageReportV2 } from '../../src/report/types.js';
import { removeUncoveredRanges } from '../../src/prune/ranges.js';

export type DifferentialResult = {
  /** stdout lines from running the fixture as written */
  original: string[];
  /** stdout lines from running the pruned fixture */
  pruned: string[];
  /** the source after coverkill pruning */
  prunedSource: string;
  /** whether the pruner changed the source at all */
  changed: boolean;
};

type V8CoverageFunctions = JsCoverageEntry['functions'];

let tmpRoot: string | null = null;
let fixtureCounter = 0;

async function ensureTmpRoot(): Promise<string> {
  if (tmpRoot === null) {
    // realpath: on macOS os.tmpdir() is a symlink (/var -> /private/var) and
    // V8 coverage URLs report the resolved path, so resolve it up front.
    tmpRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'coverkill-differential-')));
  }
  return tmpRoot;
}

/** Remove the shared temp directory. Call once from afterAll. */
export async function cleanupDifferential(): Promise<void> {
  if (tmpRoot !== null) {
    const dir = tmpRoot;
    tmpRoot = null;
    await rm(dir, { recursive: true, force: true });
  }
}

type RunResult = { code: number | null; stdout: string; stderr: string };

function runNode(scriptPath: string, extraEnv: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
    if (!('NODE_V8_COVERAGE' in extraEnv)) {
      // Never inherit a coverage dir from the outer environment.
      delete env.NODE_V8_COVERAGE;
    }
    const child = spawn(process.execPath, [scriptPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function stdoutLines(stdout: string): string[] {
  if (stdout === '') return [];
  const trimmed = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  return trimmed.split('\n');
}

async function readCoverageFunctions(
  coverageDir: string,
  fixturePath: string,
): Promise<V8CoverageFunctions> {
  const wantedUrl = pathToFileURL(fixturePath).href;
  const files = await readdir(coverageDir);
  const seenUrls: string[] = [];

  for (const file of files) {
    if (!file.startsWith('coverage-') || !file.endsWith('.json')) continue;
    const raw = await readFile(path.join(coverageDir, file), 'utf8');
    const data = JSON.parse(raw) as {
      result: Array<{ url: string; functions: V8CoverageFunctions }>;
    };
    for (const entry of data.result) {
      seenUrls.push(entry.url);
      // Node reports file:// URLs for both CJS and ESM scripts; match either
      // the URL or the raw path defensively.
      if (entry.url === wantedUrl || entry.url === fixturePath) {
        return entry.functions;
      }
    }
  }

  throw new Error(
    `No V8 coverage entry found for ${wantedUrl} in ${coverageDir}. ` +
      `Entries seen: ${seenUrls.filter((u) => !u.startsWith('node:')).join(', ') || '(none)'}`,
  );
}

function assertOffsetsAligned(functions: V8CoverageFunctions, source: string): void {
  let maxEnd = 0;
  for (const fn of functions) {
    for (const range of fn.ranges) {
      if (range.endOffset > maxEnd) maxEnd = range.endOffset;
    }
  }
  if (maxEnd > source.length) {
    throw new Error(
      `V8 coverage offsets exceed the fixture length (max endOffset ${maxEnd} > ` +
        `${source.length}). This Node version appears to include a module wrapper ` +
        `in coverage offsets; switch the harness fixtures to .mjs.`,
    );
  }
}

/**
 * Run `fixtureSource` under real V8 coverage, prune it with coverkill's
 * pipeline, run the pruned source, and return both stdout captures.
 */
export async function runDifferential(fixtureSource: string): Promise<DifferentialResult> {
  const root = await ensureTmpRoot();
  const id = ++fixtureCounter;
  const dir = path.join(root, `fixture-${id}`);
  const coverageDir = path.join(dir, 'coverage');
  await mkdir(coverageDir, { recursive: true });

  const originalPath = path.join(dir, `fixture-${id}.cjs`);
  await writeFile(originalPath, fixtureSource, 'utf8');

  const originalRun = await runNode(originalPath, { NODE_V8_COVERAGE: coverageDir });
  if (originalRun.code !== 0) {
    throw new Error(
      `Fixture ${id} failed to run before pruning (exit ${originalRun.code}):\n${originalRun.stderr}`,
    );
  }
  const original = stdoutLines(originalRun.stdout);

  const functions = await readCoverageFunctions(coverageDir, originalPath);
  assertOffsetsAligned(functions, fixtureSource);

  // Route the raw V8 payload through the real report v2 path — serialized,
  // validated, then classified at prune time — so the oracle covers the whole
  // seam, not just the flattener.
  const report: CoverageReportV2 = {
    version: 2,
    meta: { collectedAt: '1970-01-01T00:00:00.000Z', offsets: 'utf16CodeUnits' },
    rootDir: dir,
    scripts: [
      {
        url: pathToFileURL(originalPath).href,
        sourceType: 'script',
        sourceHash: hashSource(fixtureSource),
        source: fixtureSource,
        functions,
      },
    ],
    stylesheets: [],
  };
  const validated = validateReport(JSON.parse(JSON.stringify(report)), 'differential report');
  const entry = normalizeReport(validated).entries[0]!;
  const prunedSource = removeUncoveredRanges(fixtureSource, entry.ranges, {
    stubRanges: entry.stubRanges,
    kind: 'js',
    sourceType: entry.sourceType,
  });
  const changed = prunedSource !== fixtureSource;

  const prunedPath = path.join(dir, `fixture-${id}.pruned.cjs`);
  await writeFile(prunedPath, prunedSource, 'utf8');

  const prunedRun = await runNode(prunedPath, {});
  const pruned = stdoutLines(prunedRun.stdout);
  if (prunedRun.code !== 0) {
    // Keep the behavioral diff visible in the assertion failure: a crashed
    // pruned script shows up as an extra synthetic line, never as a silent pass.
    const firstError =
      prunedRun.stderr.split('\n').find((line) => line.trim().length > 0) ?? 'no stderr';
    pruned.push(`[pruned script exited with code ${prunedRun.code}: ${firstError.trim()}]`);
  }

  return { original, pruned, prunedSource, changed };
}
