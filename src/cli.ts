import { Command } from 'commander';
import { run, collect, prune } from './index.js';

const program = new Command();

program
  .name('coverkill')
  .description('Remove unused JS and CSS based on Chrome coverage')
  .option('-c, --config <path>', 'Path to coverkill config file')
  .option('--dry-run', 'Report pruning without writing files', false)
  .option('--save-report <path>', 'Save coverage report JSON');

program
  .command('run', { isDefault: true })
  .description('Collect coverage and prune uncovered code (default)')
  .action(async (opts, command) => {
    const global = command.parent?.opts() ?? {};
    await run({
      configPath: global.config,
      dryRun: global.dryRun,
      saveReport: global.saveReport,
    });
  });

program
  .command('collect')
  .description('Collect coverage only (no pruning)')
  .action(async (_opts, command) => {
    const global = command.parent?.opts() ?? {};
    const report = await collect({
      configPath: global.config,
      saveReport: global.saveReport,
    });
    if (!global.saveReport) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Coverage report saved to ${global.saveReport}`);
    }
  });

program
  .command('prune')
  .description('Prune files from a saved coverage report')
  .requiredOption('-r, --report <path>', 'Path to coverage report JSON')
  .action(async (opts, command) => {
    const global = command.parent?.opts() ?? {};
    await prune({
      configPath: global.config,
      reportPath: opts.report,
      dryRun: global.dryRun,
    });
  });

program.parseAsync(process.argv);
