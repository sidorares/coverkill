// Local vitest config for the differential suite. The root vitest.config.ts
// only includes src/**/*.test.ts, so run this suite with:
//   npx vitest run --config test/differential/vitest.config.ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default defineConfig({
  root: projectRoot,
  test: {
    include: ['test/differential/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
