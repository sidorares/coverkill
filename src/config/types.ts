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

export type CssCoverageOptions = {
  resetOnNavigation?: boolean;
};

export type CoverageConfig = {
  js?: JsCoverageOptions;
  /** Enable CSS coverage (default true). Pass an object for finer control. */
  css?: boolean | CssCoverageOptions;
};

export type BrowserConfig = {
  headless?: boolean;
  channel?: string;
};

export type ReportConfig = {
  /**
   * Embed each script's/stylesheet's executed text in the report (default
   * true). With `false` only its `sha256-` hash is written, which shrinks
   * reports enormously; pruning then requires the on-disk file to hash
   * identically.
   */
  includeSource?: boolean;
};

/** Options used by `coverkill collect` — everything that drives the browser. */
export type CollectConfigInput = {
  baseURL: string;
  rootDir?: string;
  scenarios: string[];
  webServer?: WebServerConfig;
  coverage?: CoverageConfig;
  browser?: BrowserConfig;
  report?: ReportConfig;
};

/** Options used by `coverkill prune` — everything that rewrites files on disk. */
export type PruneConfigInput = {
  rootDir?: string;
  include?: string[];
  exclude?: string[];
  sourcePath?: (url: string) => string | null;
  preserveLicenseHeader?: boolean;
  /** Regex sources; CSS rules whose selector/prelude matches are always kept. */
  cssSafelist?: string[];
};

/** The coverkill config file: the collect and prune halves share one file. */
export type CoverkillConfig = CollectConfigInput & PruneConfigInput;

export type ResolvedCollectConfig = {
  baseURL: string;
  rootDir: string;
  scenarios: string[];
  webServer?: WebServerConfig;
  coverage: {
    js: Required<JsCoverageOptions>;
    css: { enabled: boolean; resetOnNavigation: boolean };
  };
  browser: BrowserConfig;
  report: Required<ReportConfig>;
};

export type ResolvedPruneConfig = {
  rootDir: string;
  include?: string[];
  exclude?: string[];
  sourcePath?: (url: string) => string | null;
  preserveLicenseHeader: boolean;
  cssSafelist?: string[];
};

export type ResolvedCoverkillConfig = ResolvedCollectConfig & ResolvedPruneConfig;
