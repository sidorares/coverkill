import { createRequire } from 'node:module';
import { Command } from 'commander';
import { run, collect, prune, importCoverage } from './index.js';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

const program = new Command();

program
  .name('coverkill')
  .description('Remove unused JS and CSS based on Chrome coverage')
  .version(pkg.version)
  .option('-c, --config <path>', 'Path to coverkill config file');

program
  .command('run', { isDefault: true })
  .description('Collect coverage and prune uncovered code (default)')
  .option('--dry-run', 'Report pruning without writing files', false)
  .option('--save-report <path>', 'Also save the coverage report JSON')
  .action(async (opts, command) => {
    const global = command.parent?.opts() ?? {};
    await run({
      configPath: global.config,
      dryRun: opts.dryRun,
      saveReport: opts.saveReport,
    });
  });

program
  .command('collect')
  .description('Collect coverage only and write a report for `coverkill prune`')
  .option('-o, --out <path>', 'Where to write the coverage report JSON', 'coverkill-coverage.json')
  .action(async (opts, command) => {
    const global = command.parent?.opts() ?? {};
    await collect({
      configPath: global.config,
      saveReport: opts.out,
    });
    console.log(`Coverage report saved to ${opts.out}`);
  });

program
  .command('import')
  .description(
    'Convert raw V8 coverage into a coverkill report: a NODE_V8_COVERAGE directory, ' +
      'a CDP/Playwright/Puppeteer dump, or a Chrome DevTools coverage export',
  )
  .argument('<inputs...>', 'Coverage JSON files and/or NODE_V8_COVERAGE directories')
  .option('-o, --out <path>', 'Where to write the coverage report JSON', 'coverkill-coverage.json')
  .option('--root-dir <path>', 'rootDir recorded in the report (default: cwd)')
  .option('--strip-source', 'Store only source hashes, not the source text', false)
  .action(async (inputs: string[], opts) => {
    const report = await importCoverage({
      inputs,
      saveReport: opts.out,
      rootDir: opts.rootDir,
      stripSource: opts.stripSource,
    });
    const { scripts, stylesheets } = report;
    console.log(
      `Imported ${scripts.length} script(s) and ${stylesheets.length} stylesheet(s) to ${opts.out}`,
    );
  });

program
  .command('prune')
  .description('Prune files from a saved coverage report')
  .requiredOption(
    '-r, --report <path>',
    'Path to a coverkill report, a raw V8 coverage JSON file, or a NODE_V8_COVERAGE directory',
  )
  .option('--dry-run', 'Report pruning without writing files', false)
  .action(async (opts, command) => {
    const global = command.parent?.opts() ?? {};
    await prune({
      configPath: global.config,
      reportPath: opts.report,
      dryRun: opts.dryRun,
    });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
