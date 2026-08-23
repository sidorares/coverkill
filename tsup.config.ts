import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'collect/index': 'src/collect/index.ts',
      'prune/index': 'src/prune/index.ts',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: true,
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
