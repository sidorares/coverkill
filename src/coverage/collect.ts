import type { Page } from 'playwright';

type JSCoverage = Awaited<ReturnType<Page['coverage']['stopJSCoverage']>>[number];
type CSSCoverage = Awaited<ReturnType<Page['coverage']['stopCSSCoverage']>>[number];
import { mergeRanges } from './merge.js';
import type { ByteRange, CoverageReport, FileCoverageEntry } from './types.js';
import type { ResolvedCoverkillConfig } from '../config/types.js';

export async function startCoverage(page: Page, config: ResolvedCoverkillConfig): Promise<void> {
  await page.coverage.startJSCoverage({
    resetOnNavigation: config.coverage.js.resetOnNavigation,
    reportAnonymousScripts: config.coverage.js.reportAnonymousScripts,
  });
  if (config.coverage.css) {
    await page.coverage.startCSSCoverage();
  }
}

export async function stopCoverage(
  page: Page,
  config: ResolvedCoverkillConfig,
): Promise<{ js: JSCoverage[]; css: CSSCoverage[] }> {
  const js = await page.coverage.stopJSCoverage();
  const css = config.coverage.css ? await page.coverage.stopCSSCoverage() : [];
  return { js, css };
}

export function buildCoverageReport(
  rootDir: string,
  js: JSCoverage[],
  css: CSSCoverage[],
): CoverageReport {
  const entries: FileCoverageEntry[] = [];

  for (const entry of js) {
    const source = entry.source ?? '';
    const { covered, stub } = extractJsCoverage(entry);
    if (source.length === 0 && covered.length === 0 && stub.length === 0) continue;
    entries.push({
      url: entry.url,
      source,
      kind: 'js',
      ranges: mergeRanges(covered),
      stubRanges: stub.length > 0 ? mergeRanges(stub) : undefined,
    });
  }

  for (const entry of css) {
    const source = entry.text ?? '';
    const ranges = entry.ranges.map((r) => ({ start: r.start, end: r.end }));
    if (source.length === 0 && ranges.length === 0) continue;
    entries.push({
      url: entry.url,
      source,
      kind: 'css',
      ranges: mergeRanges(ranges),
    });
  }

  return {
    version: 1,
    collectedAt: new Date().toISOString(),
    rootDir,
    entries,
  };
}

export function extractJsCoverage(entry: JSCoverage): { covered: ByteRange[]; stub: ByteRange[] } {
  const covered: ByteRange[] = [];
  const stub: ByteRange[] = [];

  for (const fn of entry.functions) {
    const fnRanges = fn.ranges.filter((r) => r.endOffset > r.startOffset);
    const executed = fnRanges.some((r) => r.count > 0);

    for (const range of fnRanges) {
      const byteRange = { start: range.startOffset, end: range.endOffset };
      if (range.count > 0) {
        covered.push(byteRange);
      } else if (executed) {
        stub.push(byteRange);
      }
    }
  }

  return { covered, stub };
}

export async function saveReport(report: CoverageReport, filePath: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(filePath, JSON.stringify(report, null, 2), 'utf8');
}

export async function loadReport(filePath: string): Promise<CoverageReport> {
  const { readFile } = await import('node:fs/promises');
  const raw = JSON.parse(await readFile(filePath, 'utf8')) as CoverageReport;
  if (raw.version !== 1) {
    throw new Error(`Unsupported report version: ${String((raw as { version?: unknown }).version)}`);
  }
  return raw;
}
