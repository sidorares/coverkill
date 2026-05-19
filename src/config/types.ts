import type { Page } from 'playwright';

export type ScenarioContext = {
  page: Page;
  baseURL: string;
};

export type ScenarioFn = (ctx: ScenarioContext) => Promise<void>;

export type WebServerConfig = {
  command: string;
  url: string;
  reuseExistingServer?: boolean;
  timeout?: number;
  cwd?: string;
};

export type JsCoverageOptions = {
  resetOnNavigation?: boolean;
  reportAnonymousScripts?: boolean;
};

export type CoverageConfig = {
  js?: JsCoverageOptions;
  css?: boolean;
};

export type BrowserConfig = {
  headless?: boolean;
  channel?: string;
};

export type CoverkillConfig = {
  baseURL: string;
  rootDir?: string;
  scenarios: string[];
  webServer?: WebServerConfig;
  coverage?: CoverageConfig;
  browser?: BrowserConfig;
  include?: string[];
  exclude?: string[];
  sourcePath?: (url: string) => string | null;
  preserveLicenseHeader?: boolean;
};

export type ResolvedCoverkillConfig = CoverkillConfig & {
  rootDir: string;
  coverage: Required<CoverageConfig> & { js: JsCoverageOptions };
  browser: BrowserConfig;
};
