import { cosmiconfig } from 'cosmiconfig';
import { createJiti } from 'jiti';
import path from 'node:path';
import { parseConfig } from './schema.js';
import type { CoverkillConfig, ResolvedCoverkillConfig } from './types.js';

const MODULE_NAME = 'coverkill';

export async function loadConfig(configPath?: string): Promise<ResolvedCoverkillConfig> {
  if (configPath) {
    return loadConfigFile(path.resolve(configPath));
  }

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
  if (!result) {
    throw new Error(
      `No coverkill config found. Create coverkill.config.ts or pass --config <path>.`,
    );
  }

  if (result.isEmpty) {
    throw new Error(`Config file ${result.filepath} is empty.`);
  }

  return normalizeLoaded(result.filepath, result.config);
}

async function loadConfigFile(filepath: string): Promise<ResolvedCoverkillConfig> {
  const ext = path.extname(filepath);
  if (ext === '.json') {
    const { readFile } = await import('node:fs/promises');
    const raw = JSON.parse(await readFile(filepath, 'utf8'));
    return parseConfig(raw);
  }

  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
  });
  const mod = await jiti.import(filepath);
  return normalizeLoaded(filepath, mod);
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
