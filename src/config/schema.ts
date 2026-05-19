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

const coverageSchema = z.object({
  js: jsCoverageSchema.optional(),
  css: z.boolean().optional(),
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
});

export function parseConfig(raw: unknown, sourcePathFn?: CoverkillConfig['sourcePath']): ResolvedCoverkillConfig {
  const parsed = rawConfigSchema.parse(raw);
  const rootDir = parsed.rootDir ?? process.cwd();

  return {
    ...parsed,
    rootDir,
    sourcePath: sourcePathFn,
    coverage: {
      js: {
        resetOnNavigation: parsed.coverage?.js?.resetOnNavigation ?? false,
        reportAnonymousScripts: parsed.coverage?.js?.reportAnonymousScripts ?? false,
      },
      css: parsed.coverage?.css ?? true,
    },
    browser: parsed.browser ?? { headless: true },
    preserveLicenseHeader: parsed.preserveLicenseHeader ?? true,
  };
}
