import { z } from 'zod';
import type { CoverkillConfig, ResolvedCoverkillConfig, ResolvedPruneConfig } from './types.js';
import { PRUNE_MODES } from '../prune/stubs.js';

const pruneModeSchema = z.enum(PRUNE_MODES);

const webServerSchema = z.object({
  command: z.string().min(1),
  url: z.string().url(),
  reuseExistingServer: z.boolean().optional(),
  timeout: z.number().positive().optional(),
  cwd: z.string().optional(),
});

const jsCoverageSchema = z.object({
  resetOnNavigation: z.boolean().optional(),
  reportAnonymousScripts: z.boolean().optional(),
});

const cssCoverageSchema = z.object({
  resetOnNavigation: z.boolean().optional(),
});

const coverageSchema = z.object({
  js: jsCoverageSchema.optional(),
  css: z.union([z.boolean(), cssCoverageSchema]).optional(),
});

const browserSchema = z.object({
  headless: z.boolean().optional(),
  channel: z.string().optional(),
});

const reportSchema = z.object({
  includeSource: z.boolean().optional(),
});

const rawConfigSchema = z.object({
  baseURL: z.string().url(),
  rootDir: z.string().optional(),
  scenarios: z.array(z.string().min(1)).min(1),
  webServer: webServerSchema.optional(),
  coverage: coverageSchema.optional(),
  browser: browserSchema.optional(),
  report: reportSchema.optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  preserveLicenseHeader: z.boolean().optional(),
  cssSafelist: z.array(z.string()).optional(),
  pruneMode: pruneModeSchema.optional(),
});

/**
 * The prune half only. `coverkill prune` rewrites files from a report and
 * never opens a browser, so demanding `baseURL`/`scenarios` from it would keep
 * anyone pruning externally-collected coverage from using the tool at all.
 * Collect-only keys in the same config file are ignored here.
 */
const prunePartialSchema = z.object({
  rootDir: z.string().optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  preserveLicenseHeader: z.boolean().optional(),
  cssSafelist: z.array(z.string()).optional(),
  pruneMode: pruneModeSchema.optional(),
});

export function parsePruneConfig(
  raw: unknown,
  sourcePathFn?: CoverkillConfig['sourcePath'],
): ResolvedPruneConfig {
  const parsed = prunePartialSchema.parse(raw);
  return {
    ...parsed,
    rootDir: parsed.rootDir ?? process.cwd(),
    sourcePath: sourcePathFn,
    preserveLicenseHeader: parsed.preserveLicenseHeader ?? true,
    pruneMode: parsed.pruneMode ?? 'silent',
  };
}

export function parseConfig(
  raw: unknown,
  sourcePathFn?: CoverkillConfig['sourcePath'],
): ResolvedCoverkillConfig {
  const parsed = rawConfigSchema.parse(raw);
  const rootDir = parsed.rootDir ?? process.cwd();
  const rawCss = parsed.coverage?.css;
  const cssEnabled = rawCss !== false;
  const cssOptions = typeof rawCss === 'object' ? rawCss : {};

  return {
    ...parsed,
    rootDir,
    sourcePath: sourcePathFn,
    coverage: {
      js: {
        resetOnNavigation: parsed.coverage?.js?.resetOnNavigation ?? false,
        reportAnonymousScripts: parsed.coverage?.js?.reportAnonymousScripts ?? false,
      },
      css: {
        enabled: cssEnabled,
        resetOnNavigation: cssOptions.resetOnNavigation ?? false,
      },
    },
    browser: parsed.browser ?? { headless: true },
    report: { includeSource: parsed.report?.includeSource ?? true },
    preserveLicenseHeader: parsed.preserveLicenseHeader ?? true,
    pruneMode: parsed.pruneMode ?? 'silent',
  };
}
