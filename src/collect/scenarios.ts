import path from 'node:path';
import fg from 'fast-glob';
import { stat } from 'node:fs/promises';
import { createJiti } from 'jiti';
import type { Page } from 'playwright';
import type { ResolvedCollectConfig, ScenarioFn } from '../config/types.js';

const SCENARIO_EXTENSIONS = new Set(['.ts', '.js', '.mts', '.mjs']);

export async function expandScenarioPaths(patterns: string[]): Promise<string[]> {
  const files = new Set<string>();

  for (const pattern of patterns) {
    const resolved = path.resolve(pattern);
    const hasWildcard = /[*?[\]]/.test(pattern);

    if (hasWildcard) {
      const matches = await fg(resolved, { absolute: true, onlyFiles: true });
      for (const entry of matches) {
        if (isScenarioFile(entry)) files.add(entry);
      }
      continue;
    }

    try {
      const info = await stat(resolved);
      if (info.isDirectory()) {
        const matches = await fg('**/*', {
          cwd: resolved,
          absolute: true,
          onlyFiles: true,
        });
        for (const entry of matches) {
          if (isScenarioFile(entry)) files.add(entry);
        }
      } else if (isScenarioFile(resolved)) {
        files.add(resolved);
      }
    } catch {
      throw new Error(`Scenario path not found: ${pattern}`);
    }
  }

  return [...files].sort();
}

function isScenarioFile(filePath: string): boolean {
  const ext = path.extname(filePath);
  return SCENARIO_EXTENSIONS.has(ext) && !filePath.endsWith('.d.ts');
}

export async function loadScenarios(
  config: ResolvedCollectConfig,
): Promise<Array<{ file: string; fn: ScenarioFn }>> {
  const files = await expandScenarioPaths(config.scenarios);
  if (files.length === 0) {
    throw new Error(`No scenario files matched: ${config.scenarios.join(', ')}`);
  }

  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const scenarios: Array<{ file: string; fn: ScenarioFn }> = [];

  for (const file of files) {
    const mod = (await jiti.import(file)) as Record<string, unknown>;
    const fn = extractScenario(mod);
    if (!fn) {
      throw new Error(
        `Scenario ${file} must export a default function or named "scenario" function.`,
      );
    }
    scenarios.push({ file, fn });
  }

  return scenarios;
}

export async function runScenarios(
  page: Page,
  config: ResolvedCollectConfig,
): Promise<void> {
  for (const { fn } of await loadScenarios(config)) {
    await fn({ page, baseURL: config.baseURL });
  }
}

function extractScenario(mod: Record<string, unknown>): ScenarioFn | null {
  const candidate = mod.default ?? mod.scenario;
  if (typeof candidate === 'function') {
    return candidate as ScenarioFn;
  }
  return null;
}
