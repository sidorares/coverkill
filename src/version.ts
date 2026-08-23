import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let cached: string | null = null;

/** coverkill's own version, recorded in report metadata. Best-effort. */
export function coverkillVersion(): string {
  if (cached !== null) return cached;
  for (const candidate of ['../package.json', '../../package.json', '../../../package.json']) {
    try {
      const pkg = require(candidate) as { name?: string; version?: string };
      if (pkg?.name === 'coverkill' && typeof pkg.version === 'string') {
        cached = pkg.version;
        return cached;
      }
    } catch {
      // keep looking
    }
  }
  cached = 'unknown';
  return cached;
}
