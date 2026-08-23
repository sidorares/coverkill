import { cosmiconfig } from 'cosmiconfig';
import { createJiti } from 'jiti';
import path from 'node:path';
import { parseConfig, parsePruneConfig } from './schema.js';
import type { CoverkillConfig, ResolvedCoverkillConfig, ResolvedPruneConfig } from './types.js';

const MODULE_NAME = 'coverkill';

export async function loadConfig(configPath?: string): Promise<ResolvedCoverkillConfig> {
  if (configPath) {
    return loadConfigFile(path.resolve(configPath));
  }

  const found = await searchConfig();
  if (!found) {
    throw new Error(
      `No coverkill config found. Create coverkill.config.ts or pass --config <path>.`,
    );
  }
  return normalizeLoaded(found.filepath, found.config);
}

/**
 * Config for the prune half alone. Collect-only keys are optional here, so
 * coverage collected by someone else's runner can be pruned without inventing
 * a `baseURL` and a scenario list that would never run.
 */
export async function loadPruneConfig(configPath?: string): Promise<ResolvedPruneConfig> {
  if (configPath) {
    const filepath = path.resolve(configPath);
    const loaded = await readConfigFile(filepath);
    return normalizePruneLoaded(filepath, loaded);
  }

  const found = await searchConfig();
  if (!found) {
    // Prune is explicit about what it touches (a report, an include list, and
    // --dry-run); refusing to run without a config file would block the whole
    // "prune coverage collected elsewhere" path for no safety gain.
    console.warn(
      '[coverkill] No coverkill config found; pruning with defaults ' +
        `(rootDir=${process.cwd()}, no include allowlist).`,
    );
    return parsePruneConfig({});
  }
  return normalizePruneLoaded(found.filepath, found.config);
}

async function searchConfig(): Promise<{ filepath: string; config: unknown } | null> {
  const jitiLoader = async (filepath: string) => {
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    return jiti.import(filepath);
  };

  const explorer = cosmiconfig(MODULE_NAME, {
    searchPlaces: [
      'coverkill.config.ts',
      'coverkill.config.mts',
      'coverkill.config.js',
      'coverkill.config.mjs',
      'coverkill.config.cjs',
      'coverkill.config.json',
    ],
    loaders: {
      '.ts': jitiLoader,
      '.mts': jitiLoader,
      '.js': jitiLoader,
      '.mjs': jitiLoader,
      '.cjs': jitiLoader,
    },
  });

  const result = await explorer.search();
  if (!result) return null;
  if (result.isEmpty) {
    throw new Error(`Config file ${result.filepath} is empty.`);
  }
  return { filepath: result.filepath, config: result.config };
}

async function readConfigFile(filepath: string): Promise<unknown> {
  if (path.extname(filepath) === '.json') {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(filepath, 'utf8'));
  }
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  return jiti.import(filepath);
}

async function loadConfigFile(filepath: string): Promise<ResolvedCoverkillConfig> {
  const loaded = await readConfigFile(filepath);
  if (path.extname(filepath) === '.json') {
    return parseConfig(loaded);
  }
  return normalizeLoaded(filepath, loaded);
}

function normalizeLoaded(filepath: string, loaded: unknown): ResolvedCoverkillConfig {
  const config = unwrapConfig(loaded);
  const sourcePathFn = typeof config.sourcePath === 'function' ? config.sourcePath : undefined;
  const { sourcePath: _removed, ...serializable } = config;
  const resolved = parseConfig(serializable, sourcePathFn);
  const configDir = path.dirname(filepath);
  if (!path.isAbsolute(resolved.rootDir)) {
    resolved.rootDir = path.resolve(configDir, resolved.rootDir);
  }
  resolved.scenarios = resolved.scenarios.map((s) =>
    path.isAbsolute(s) ? s : path.resolve(configDir, s),
  );
  if (resolved.webServer?.cwd && !path.isAbsolute(resolved.webServer.cwd)) {
    resolved.webServer.cwd = path.resolve(configDir, resolved.webServer.cwd);
  }
  return resolved;
}

function normalizePruneLoaded(filepath: string, loaded: unknown): ResolvedPruneConfig {
  const config = unwrapConfig(loaded);
  const sourcePathFn = typeof config.sourcePath === 'function' ? config.sourcePath : undefined;
  const { sourcePath: _removed, ...serializable } = config;
  const resolved = parsePruneConfig(serializable, sourcePathFn);
  if (!path.isAbsolute(resolved.rootDir)) {
    resolved.rootDir = path.resolve(path.dirname(filepath), resolved.rootDir);
  }
  return resolved;
}

function unwrapConfig(loaded: unknown): CoverkillConfig {
  if (!loaded || typeof loaded !== 'object') {
    throw new Error('Config must export a configuration object.');
  }
  const mod = loaded as Record<string, unknown>;
  const config = mod.default ?? mod;
  if (!config || typeof config !== 'object') {
    throw new Error('Config must export a configuration object (default export).');
  }
  return config as CoverkillConfig;
}

export { MODULE_NAME };
