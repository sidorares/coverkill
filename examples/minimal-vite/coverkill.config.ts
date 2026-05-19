import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '../../src/index.js';

const exampleDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  baseURL: 'http://localhost:5173',
  scenarios: ['./scenarios/click-button.ts'],
  webServer: {
    command: 'npm run start',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    cwd: exampleDir,
  },
  coverage: {
    js: { resetOnNavigation: false },
    css: true,
  },
  include: ['**/*.{js,css}'],
  exclude: ['**/scenarios/**', '**/node_modules/**', 'coverkill.config.ts'],
  sourcePath(url) {
    try {
      const { pathname } = new URL(url);
      if (pathname === '/main.js') return path.join(exampleDir, 'main.js');
      if (pathname === '/styles.css') return path.join(exampleDir, 'styles.css');
    } catch {
      // ignore
    }
    return null;
  },
});
