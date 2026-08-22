import { z } from 'zod';
import type { CoverkillConfig, ResolvedCoverkillConfig } from './types.js';

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

const rawConfigSchema = z.object({
  baseURL: z.string().url(),
  rootDir: z.string().optional(),
  scenarios: z.array(z.string().min(1)).min(1),
  webServer: webServerSchema.optional(),
  coverage: coverageSchema.optional(),
  browser: browserSchema.optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  preserveLicenseHeader: z.boolean().optional(),
  cssSafelist: z.array(z.string()).optional(),
});

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
    preserveLicenseHeader: parsed.preserveLicenseHeader ?? true,
  };
}
