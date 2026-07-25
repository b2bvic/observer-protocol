import * as fs from 'fs';
import * as path from 'path';
import * as cron from 'node-cron';
import matter from 'gray-matter';
import { Config } from './config';
import { LoopConfig, LoopState, LoopRun } from './types';

export class LoopRunner {
  private config: Config;
  private vaultPath: string;
  private activeJobs: Map<string, cron.ScheduledTask> = new Map();

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
    this.config = new Config(vaultPath);
  }

  // Start all active loops
  async startAll(): Promise<void> {
    const loops = this.config.listLoops();

    for (const loop of loops) {
      if (loop.status === 'active') {
        await this.start(loop.id);
      }
    }
  }

  // Start a specific loop
  async start(loopId: string): Promise<void> {
    const loop = this.config.loadLoop(loopId);
    if (!loop) {
      throw new Error(`Loop not found: ${loopId}`);
    }

    if (loop.status !== 'active') {
      console.log(`Loop ${loopId} is not active (status: ${loop.status})`);
      return;
    }

    // Initialize state if not exists
    let state = this.config.loadLoopState(loopId);
    if (!state) {
      state = {
        id: loopId,
        status: 'active',
        runs_today: 0,
        history: [],
      };
      this.config.saveLoopState(state);
    }

    // Set up scheduling
    if (loop.schedule) {
      if (loop.schedule.type === 'interval') {
        const intervalMs = this.parseInterval(loop.schedule.value);
        const jitterMs = loop.schedule.jitter ? this.parseInterval(loop.schedule.jitter) : 0;

        const runWithJitter = async () => {
          const jitter = Math.random() * jitterMs;
          setTimeout(() => this.execute(loop, state!), jitter);
        };

        // Use setInterval for simple interval scheduling
        const intervalId = setInterval(runWithJitter, intervalMs);
        this.activeJobs.set(loopId, { stop: () => clearInterval(intervalId) } as any);

        console.log(`Started loop ${loopId} with interval ${loop.schedule.value}`);
      } else if (loop.schedule.type === 'cron') {
        const task = cron.schedule(loop.schedule.value, () => this.execute(loop, state!));
        this.activeJobs.set(loopId, task);
        console.log(`Started loop ${loopId} with cron ${loop.schedule.value}`);
      }
    }
  }

  // Stop a loop
  stop(loopId: string): void {
    const job = this.activeJobs.get(loopId);
    if (job) {
      job.stop();
      this.activeJobs.delete(loopId);
      console.log(`Stopped loop ${loopId}`);
    }
  }

  // Execute a loop once
  async execute(loop: LoopConfig, state: LoopState): Promise<LoopRun> {
    const run: LoopRun = {
      timestamp: new Date().toISOString(),
      status: 'success',
    };

    try {
      // Check active hours
      if (loop.schedule?.active_hours) {
        const hour = new Date().getHours();
        const [start, end] = loop.schedule.active_hours;
        if (hour < start || hour > end) {
          run.status = 'skipped';
          run.output = `Outside active hours (${start}-${end})`;
          this.updateState(state, run);
          return run;
        }
      }

      // Check max per day
      if (loop.constraints.max_per_day && state.runs_today >= loop.constraints.max_per_day) {
        run.status = 'skipped';
        run.output = `Max runs per day reached (${loop.constraints.max_per_day})`;
        this.updateState(state, run);
        return run;
      }

      // Load source files
      const sourceFiles = this.loadSourceFiles(loop);
      if (sourceFiles.length === 0) {
        run.status = 'skipped';
        run.output = 'No source files match filter';
        this.updateState(state, run);
        return run;
      }

      // Pick a source file (round-robin or random)
      const sourceFile = sourceFiles[Math.floor(Math.random() * sourceFiles.length)];

      // Apply privacy filter
      let content = this.extractContent(sourceFile);
      content = this.applyPrivacyWeight(content, loop.constraints.privacy_weight);
      content = this.filterRestrictedTopics(content, loop.constraints.restricted_topics);

      // If approval required, write to draft and pause
      if (loop.output.require_approval) {
        const draftPath = this.writeDraft(loop, content, sourceFile);
        run.status = 'pending_approval';
        run.output = draftPath;


        this.updateState(state, run);
        return run;
      }

      // Execute output
      run.output = content;

      // Log to log_path
      this.appendToLog(loop.output.log_path, {
        timestamp: run.timestamp,
        loop: loop.id,
        source: sourceFile.path,
        output: content.substring(0, 200) + '...',
      });

      // Mark source as posted if configured
      if (loop.on_complete === 'mark_source_posted') {
        this.markSourcePosted(sourceFile.path);
      }

      state.runs_today++;
      this.updateState(state, run);

      return run;

    } catch (error: any) {
      run.status = 'failed';
      run.error = error.message;
      this.updateState(state, run);
      return run;
    }
  }

  // Manual run (ignores schedule)
  async runOnce(loopId: string): Promise<LoopRun> {
    const loop = this.config.loadLoop(loopId);
    if (!loop) {
      throw new Error(`Loop not found: ${loopId}`);
    }

    let state = this.config.loadLoopState(loopId);
    if (!state) {
      state = {
        id: loopId,
        status: loop.status,
        runs_today: 0,
        history: [],
      };
    }

    return this.execute(loop, state);
  }

  // Load source files matching config
  private loadSourceFiles(loop: LoopConfig): { path: string; content: string; data: any }[] {
    const files: { path: string; content: string; data: any }[] = [];

    for (const pattern of loop.source.paths) {
      const globPath = path.join(this.vaultPath, pattern);
      const matches = this.globSync(globPath);

      for (const filePath of matches) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const { data, content: body } = matter(content);

        // Apply filter if specified
        if (loop.source.filter) {
          const [field, value] = loop.source.filter.split('::').map(s => s.trim());
          if (data[field] !== value) {
            continue;
          }
        }

        files.push({ path: filePath, content: body, data });
      }
    }

    return files;
  }

  // Glob implementation with recursive support
  private globSync(pattern: string): string[] {
    const results: string[] = [];

    // Handle ** recursive patterns
    if (pattern.includes('**')) {
      const parts = pattern.split('**');
      const baseDir = parts[0].replace(/\/+$/, '');
      const filePattern = parts[1]?.replace(/^\/+/, '') || '*';

      if (!fs.existsSync(baseDir)) return [];

      const walkDir = (dir: string): void => {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walkDir(fullPath);
            } else {
              const regex = new RegExp('^' + filePattern.replace(/\*/g, '.*') + '$');
              if (regex.test(entry.name)) {
                results.push(fullPath);
              }
            }
          }
        } catch (e) {}
      };

      walkDir(baseDir);
      return results;
    }

    // Simple glob
    const dir = path.dirname(pattern);
    const filePattern = path.basename(pattern);

    if (!fs.existsSync(dir)) {
      return [];
    }

    const files = fs.readdirSync(dir);
    const regex = new RegExp('^' + filePattern.replace(/\*/g, '.*') + '$');

    return files
      .filter(f => regex.test(f))
      .map(f => path.join(dir, f));
  }

  // Extract content from source file
  private extractContent(file: { path: string; content: string; data: any }): string {
    // For now, return full content. Transform steps would go here.
    return file.content;
  }

  // Apply privacy weight (0-1)
  private applyPrivacyWeight(content: string, weight: number): string {
    if (weight < 0.3) return content;

    // Basic filtering - production would use NER/entity recognition
    let filtered = content;

    if (weight >= 0.5) {
      // Remove emails
      filtered = filtered.replace(/[\w.-]+@[\w.-]+\.\w+/g, '[email]');
      // Remove phone numbers
      filtered = filtered.replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[phone]');
    }

    if (weight >= 0.7) {
      // Remove dollar amounts
      filtered = filtered.replace(/\$[\d,]+(\.\d{2})?/g, '[amount]');
      // Remove names (basic - matches Title Case words)
      filtered = filtered.replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g, '[name]');
    }

    if (weight >= 0.9) {
      // Remove company names (basic)
      filtered = filtered.replace(/\b[A-Z][a-z]+ (Inc|LLC|Corp|Ltd)\b/g, '[company]');
    }

    return filtered;
  }

  // Filter restricted topics
  private filterRestrictedTopics(content: string, topics: string[]): string {
    let filtered = content;
    for (const topic of topics) {
      const regex = new RegExp(topic, 'gi');
      filtered = filtered.replace(regex, '[restricted]');
    }
    return filtered;
  }

  // Write draft for approval
  private writeDraft(loop: LoopConfig, content: string, source: { path: string }): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const draftDir = path.join(this.vaultPath, loop.output.draft_path || '.observer/drafts');

    if (!fs.existsSync(draftDir)) {
      fs.mkdirSync(draftDir, { recursive: true });
    }

    const draftPath = path.join(draftDir, `${loop.id}-${timestamp}.md`);

    const frontmatter = {
      type: 'draft',
      loop: loop.id,
      source: source.path,
      created: new Date().toISOString(),
      status: 'pending',
    };

    const draftContent = matter.stringify(content, frontmatter);
    fs.writeFileSync(draftPath, draftContent);

    return draftPath;
  }

  // Append to log file
  private appendToLog(logPath: string, entry: any): void {
    const fullPath = path.join(this.vaultPath, logPath);
    const logEntry = `\n- ${entry.timestamp}: [${entry.loop}] ${entry.output}\n`;
    fs.appendFileSync(fullPath, logEntry);
  }

  // Mark source file as posted
  private markSourcePosted(filePath: string): void {
    const content = fs.readFileSync(filePath, 'utf-8');
    const { data, content: body } = matter(content);

    data.status = 'posted';
    data.posted_at = new Date().toISOString();

    const updated = matter.stringify(body, data);
    fs.writeFileSync(filePath, updated);
  }

  // Update loop state
  private updateState(state: LoopState, run: LoopRun): void {
    state.history.push(run);
    state.last_run = run.timestamp;

    // Keep only last 100 runs
    if (state.history.length > 100) {
      state.history = state.history.slice(-100);
    }

    // Reset runs_today at midnight
    const lastRun = new Date(state.last_run);
    const now = new Date();
    if (lastRun.getDate() !== now.getDate()) {
      state.runs_today = 0;
    }

    this.config.saveLoopState(state);
  }

  // Parse interval string (e.g., "8h", "30m", "1d")
  private parseInterval(interval: string): number {
    const match = interval.match(/^(\d+)(s|m|h|d)$/);
    if (!match) {
      throw new Error(`Invalid interval: ${interval}`);
    }

    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
      case 's': return value * 1000;
      case 'm': return value * 60 * 1000;
      case 'h': return value * 60 * 60 * 1000;
      case 'd': return value * 24 * 60 * 60 * 1000;
      default: throw new Error(`Unknown unit: ${unit}`);
    }
  }
}
