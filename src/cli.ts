#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { Config, findVaultRoot } from './config';
import { LoopRunner } from './loop-runner';
import { startServer } from './server';
import { Analyzer } from './analyzer';

const program = new Command();

program
  .name('observer')
  .description('Observer Protocol CLI - AI agent protocol for local markdown vaults')
  .version('0.1.0');

// Find vault
function getVaultPath(): string {
  const vaultPath = findVaultRoot() || process.env.VAULT_PATH;
  if (!vaultPath) {
    console.error('Could not find vault. Run from within vault or set VAULT_PATH.');
    process.exit(1);
  }
  return vaultPath;
}

// Init command
program
  .command('init')
  .description('Initialize .observer directory in current vault')
  .action(async () => {
    const vaultPath = getVaultPath();
    const config = new Config(vaultPath);
    await config.init();
  });

// Loop commands
const loopCmd = program.command('loop').description('Manage loops');

loopCmd
  .command('create <config>')
  .description('Create a loop from YAML config file')
  .action((configPath) => {
    const vaultPath = getVaultPath();
    const config = new Config(vaultPath);

    const fullPath = path.resolve(configPath);
    if (!fs.existsSync(fullPath)) {
      console.error(`Config file not found: ${fullPath}`);
      process.exit(1);
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    const loopConfig = yaml.parse(content);

    if (!loopConfig.id) {
      console.error('Loop config must have an id');
      process.exit(1);
    }

    config.saveLoop(loopConfig);
    console.log(`Created loop: ${loopConfig.id}`);
  });

loopCmd
  .command('list')
  .description('List all loops')
  .action(() => {
    const vaultPath = getVaultPath();
    const config = new Config(vaultPath);
    const loops = config.listLoops();

    if (loops.length === 0) {
      console.log('No loops configured.');
      return;
    }

    console.log('\nLoops:\n');
    for (const loop of loops) {
      const state = config.loadLoopState(loop.id);
      const lastRun = state?.last_run ? new Date(state.last_run).toLocaleString() : 'never';
      console.log(`  ${loop.id}`);
      console.log(`    Status: ${loop.status}`);
      console.log(`    Objective: ${loop.objective}`);
      console.log(`    Last run: ${lastRun}`);
      console.log('');
    }
  });

loopCmd
  .command('run <id>')
  .description('Run a loop once (ignores schedule)')
  .action(async (id) => {
    const vaultPath = getVaultPath();
    const runner = new LoopRunner(vaultPath);

    console.log(`Running loop: ${id}`);
    const result = await runner.runOnce(id);

    console.log(`\nResult: ${result.status}`);
    if (result.output) {
      console.log(`Output: ${result.output.substring(0, 200)}...`);
    }
    if (result.error) {
      console.log(`Error: ${result.error}`);
    }
  });

loopCmd
  .command('pause <id>')
  .description('Pause a loop')
  .action((id) => {
    const vaultPath = getVaultPath();
    const config = new Config(vaultPath);
    const runner = new LoopRunner(vaultPath);

    const loop = config.loadLoop(id);
    if (!loop) {
      console.error(`Loop not found: ${id}`);
      process.exit(1);
    }

    loop.status = 'paused';
    config.saveLoop(loop);
    runner.stop(id);

    console.log(`Paused loop: ${id}`);
  });

loopCmd
  .command('resume <id>')
  .description('Resume a paused loop')
  .action(async (id) => {
    const vaultPath = getVaultPath();
    const config = new Config(vaultPath);
    const runner = new LoopRunner(vaultPath);

    const loop = config.loadLoop(id);
    if (!loop) {
      console.error(`Loop not found: ${id}`);
      process.exit(1);
    }

    loop.status = 'active';
    config.saveLoop(loop);
    await runner.start(id);

    console.log(`Resumed loop: ${id}`);
  });

loopCmd
  .command('history <id>')
  .description('Show loop run history')
  .action((id) => {
    const vaultPath = getVaultPath();
    const config = new Config(vaultPath);

    const state = config.loadLoopState(id);
    if (!state) {
      console.log('No history for this loop.');
      return;
    }

    console.log(`\nHistory for ${id}:\n`);
    for (const run of state.history.slice(-20).reverse()) {
      console.log(`  ${run.timestamp} - ${run.status}`);
      if (run.error) {
        console.log(`    Error: ${run.error}`);
      }
    }
  });

// Server command
program
  .command('server')
  .description('Start the Observer webhook server')
  .option('-p, --port <port>', 'Port to listen on', '3847')
  .action((options) => {
    process.env.PORT = options.port;
    startServer();
  });

// Status command
program
  .command('status')
  .description('Show vault and observer status')
  .action(() => {
    const vaultPath = getVaultPath();
    const config = new Config(vaultPath);

    console.log('\nObserver Status\n');
    console.log(`Vault: ${vaultPath}`);

    // Check .observer directory
    const observerPath = path.join(vaultPath, '.observer');
    if (fs.existsSync(observerPath)) {
      console.log('.observer: initialized');

      // Count intake files
      const intakePath = path.join(observerPath, 'intake');
      if (fs.existsSync(intakePath)) {
        const intakeCount = fs.readdirSync(intakePath).length;
        console.log(`Intake files: ${intakeCount}`);
      }

      // Count corrections
      const correctionsPath = path.join(observerPath, 'corrections.jsonl');
      if (fs.existsSync(correctionsPath)) {
        const corrections = fs.readFileSync(correctionsPath, 'utf-8')
          .split('\n')
          .filter(l => l.trim()).length;
        console.log(`Corrections logged: ${corrections}`);
      }

      // List loops
      const loops = config.listLoops();
      const active = loops.filter(l => l.status === 'active').length;
      console.log(`Loops: ${loops.length} (${active} active)`);
    } else {
      console.log('.observer: not initialized (run `observer init`)');
    }

    // Check CLAUDE.md
    const claudePath = path.join(vaultPath, 'CLAUDE.md');
    if (fs.existsSync(claudePath)) {
      console.log('CLAUDE.md: found');
    } else {
      console.log('CLAUDE.md: not found');
    }

    console.log('');
  });

// Intake command (manual)
program
  .command('intake <text>')
  .description('Add a text intake entry')
  .option('-s, --source <source>', 'Source identifier', 'cli')
  .action((text, options) => {
    const vaultPath = getVaultPath();
    const config = new Config(vaultPath);

    const filepath = config.writeIntake({
      type: 'text',
      source: options.source,
      content: text,
    });

    console.log(`Captured: ${filepath}`);
  });

// Corrections command
program
  .command('corrections')
  .description('Show logged corrections')
  .action(() => {
    const vaultPath = getVaultPath();
    const config = new Config(vaultPath);

    const corrections = config.loadCorrections();
    if (corrections.length === 0) {
      console.log('No corrections logged.');
      return;
    }

    console.log('\nCorrections:\n');
    for (const c of corrections.slice(-20)) {
      console.log(`  ${c.ts} [${c.type}] "${c.trigger}" -> ${c.action}`);
    }

    // Show patterns
    const patterns = config.loadPatterns();
    if (patterns.length > 0) {
      console.log('\nLearned Patterns:\n');
      for (const p of patterns) {
        const status = p.auto_correct ? '(auto-correct)' : '';
        console.log(`  ${p.type}: ${p.count} occurrences ${status}`);
      }
    }
  });

// Drafts command
program
  .command('drafts')
  .description('List pending drafts')
  .action(() => {
    const vaultPath = getVaultPath();
    const draftsPath = path.join(vaultPath, '.observer', 'drafts');

    if (!fs.existsSync(draftsPath)) {
      console.log('No drafts directory.');
      return;
    }

    const files = fs.readdirSync(draftsPath).filter(f => f.endsWith('.md'));
    if (files.length === 0) {
      console.log('No drafts pending.');
      return;
    }

    console.log('\nDrafts:\n');
    for (const file of files) {
      const content = fs.readFileSync(path.join(draftsPath, file), 'utf-8');
      const statusMatch = content.match(/status::\s*(\w+)/);
      const loopMatch = content.match(/loop::\s*(\S+)/);
      const status = statusMatch ? statusMatch[1] : 'unknown';
      const loop = loopMatch ? loopMatch[1] : 'unknown';

      const preview = content.replace(/^---[\s\S]*?---\n?/, '').trim().slice(0, 60);
      const id = file.replace('.md', '');

      console.log(`  [${status.toUpperCase()}] ${id}`);
      console.log(`    Loop: ${loop}`);
      console.log(`    Preview: ${preview}...`);
      console.log('');
    }
  });

// Approve command
program
  .command('approve <id>')
  .description('Approve a draft')
  .action((id) => {
    const vaultPath = getVaultPath();
    const draftPath = path.join(vaultPath, '.observer', 'drafts', `${id}.md`);

    if (!fs.existsSync(draftPath)) {
      console.error(`Draft not found: ${id}`);
      process.exit(1);
    }

    let content = fs.readFileSync(draftPath, 'utf-8');
    content = content.replace(/status::\s*pending/, 'status:: approved');
    fs.writeFileSync(draftPath, content);

    console.log(`Approved: ${id}`);
  });

// Reject command
program
  .command('reject <id>')
  .description('Reject a draft')
  .option('-r, --reason <reason>', 'Rejection reason')
  .action((id, options) => {
    const vaultPath = getVaultPath();
    const draftPath = path.join(vaultPath, '.observer', 'drafts', `${id}.md`);

    if (!fs.existsSync(draftPath)) {
      console.error(`Draft not found: ${id}`);
      process.exit(1);
    }

    let content = fs.readFileSync(draftPath, 'utf-8');
    content = content.replace(/status::\s*pending/, 'status:: rejected');
    if (options.reason) {
      content = content.replace(/---\n/, `---\nrejection_reason:: ${options.reason}\n`);
    }
    fs.writeFileSync(draftPath, content);

    console.log(`Rejected: ${id}`);
  });

// Reflect command
program
  .command('reflect')
  .description('Run reflection analysis on recent activity')
  .option('-d, --days <days>', 'Days to analyze', '7')
  .action((options) => {
    const vaultPath = getVaultPath();
    const days = parseInt(options.days);

    // Load recent corrections
    const config = new Config(vaultPath);
    const corrections = config.loadCorrections();
    const patterns = config.loadPatterns();

    // Load recent intake
    const intakePath = path.join(vaultPath, '.observer', 'intake');
    let intakeCount = 0;
    let totalWords = 0;

    if (fs.existsSync(intakePath)) {
      const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
      const files = fs.readdirSync(intakePath).filter(f => f.endsWith('.md'));

      for (const file of files) {
        const stat = fs.statSync(path.join(intakePath, file));
        if (stat.mtimeMs > cutoff) {
          intakeCount++;
          const content = fs.readFileSync(path.join(intakePath, file), 'utf-8');
          totalWords += content.split(/\s+/).length;
        }
      }
    }

    // Load loop runs
    const loops = config.listLoops();
    let totalRuns = 0;
    let successRuns = 0;

    for (const loop of loops) {
      const state = config.loadLoopState(loop.id);
      if (state) {
        const recentRuns = state.history.filter(r => {
          const runTime = new Date(r.timestamp).getTime();
          return runTime > Date.now() - (days * 24 * 60 * 60 * 1000);
        });
        totalRuns += recentRuns.length;
        successRuns += recentRuns.filter(r => r.status === 'success').length;
      }
    }

    console.log(`\nReflection Analysis (last ${days} days)\n`);
    console.log('═'.repeat(40));

    console.log('\nINTAKE');
    console.log(`  Captures: ${intakeCount}`);
    console.log(`  Total words: ${totalWords}`);
    console.log(`  Avg words/capture: ${intakeCount > 0 ? Math.round(totalWords / intakeCount) : 0}`);

    console.log('\nCORRECTIONS');
    console.log(`  Total logged: ${corrections.length}`);
    console.log(`  Patterns learned: ${patterns.length}`);
    console.log(`  Auto-correcting: ${patterns.filter(p => p.auto_correct).length}`);

    console.log('\nLOOPS');
    console.log(`  Total runs: ${totalRuns}`);
    console.log(`  Success rate: ${totalRuns > 0 ? Math.round(successRuns / totalRuns * 100) : 0}%`);
    console.log(`  Active loops: ${loops.filter(l => l.status === 'active').length}/${loops.length}`);

    // Observations
    console.log('\nOBSERVATIONS');

    if (patterns.filter(p => p.auto_correct).length > 0) {
      console.log('  ! Recurring patterns detected - auto-correction active');
    }

    if (intakeCount > 0 && totalWords / intakeCount < 20) {
      console.log('  ! Short intake captures - consider elaborating');
    }

    if (totalRuns > 0 && successRuns / totalRuns < 0.7) {
      console.log('  ! Loop failures above 30% - review constraints');
    }

    if (intakeCount === 0) {
      console.log('  ? No intake this period - voice capture configured?');
    }

    console.log('');
  });

// Recent command
program
  .command('recent')
  .description('Show recently modified files')
  .option('-d, --days <days>', 'Days to look back', '1')
  .action((options) => {
    const vaultPath = getVaultPath();
    const days = parseInt(options.days);
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

    const walkDir = (dir: string, files: string[] = []): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip hidden dirs and node_modules
        if (entry.name.startsWith('.') || entry.name === 'node_modules') {
          continue;
        }

        if (entry.isDirectory()) {
          walkDir(fullPath, files);
        } else if (entry.name.endsWith('.md')) {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > cutoff) {
            files.push(fullPath);
          }
        }
      }

      return files;
    };

    const files = walkDir(vaultPath);

    // Group by domain
    const groups: Record<string, string[]> = {};
    for (const file of files) {
      const relative = path.relative(vaultPath, file);
      const domain = relative.split(path.sep)[0] || 'root';

      if (!groups[domain]) {
        groups[domain] = [];
      }
      groups[domain].push(relative);
    }

    console.log(`\nFiles modified in last ${days} day(s):\n`);
    for (const [domain, domainFiles] of Object.entries(groups)) {
      console.log(`${domain}:`);
      for (const f of domainFiles.slice(0, 10)) {
        console.log(`  ${f}`);
      }
      if (domainFiles.length > 10) {
        console.log(`  ... and ${domainFiles.length - 10} more`);
      }
      console.log('');
    }
  });

// Analyze command - the brain
program
  .command('analyze')
  .description('Deep analysis of vault activity - finds patterns, contradictions, maintenance issues')
  .option('-d, --days <days>', 'Days to analyze', '1')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const vaultPath = getVaultPath();
    const days = parseInt(options.days);

    console.log(`\nAnalyzing vault activity (last ${days} day${days > 1 ? 's' : ''})...\n`);

    const analyzer = new Analyzer(vaultPath);
    const result = await analyzer.analyze(days);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(analyzer.formatOutput(result));
    }
  });

program.parse();
