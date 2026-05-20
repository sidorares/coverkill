import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    noExternal: ['acorn'],
  },
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    sourcemap: true,
    splitting: false,
    noExternal: ['acorn'],
    banner: { js: '#!/usr/bin/env node' },
  },
]);
