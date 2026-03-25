import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import matter from 'gray-matter';
import { ObserverConfig, LoopConfig, LoopState, Correction, Pattern, IntakeEntry } from './types';

const OBSERVER_DIR = '.observer';
const CLAUDE_MD = 'CLAUDE.md';

export class Config {
  private vaultPath: string;
  private observerPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
    this.observerPath = path.join(vaultPath, OBSERVER_DIR);
  }

  // Initialize .observer directory structure
  async init(): Promise<void> {
    const dirs = [
      this.observerPath,
      path.join(this.observerPath, 'loops'),
      path.join(this.observerPath, 'intake'),
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    // Create empty corrections.jsonl if not exists
    const correctionsPath = path.join(this.observerPath, 'corrections.jsonl');
    if (!fs.existsSync(correctionsPath)) {
      fs.writeFileSync(correctionsPath, '');
    }

    // Create empty patterns.json if not exists
    const patternsPath = path.join(this.observerPath, 'patterns.json');
    if (!fs.existsSync(patternsPath)) {
      fs.writeFileSync(patternsPath, JSON.stringify({ patterns: [] }, null, 2));
    }

    console.log(`Initialized .observer in ${this.vaultPath}`);
  }

  // Load CLAUDE.md configuration
  loadClaudeConfig(): Partial<ObserverConfig> | null {
    const claudePath = path.join(this.vaultPath, CLAUDE_MD);
    if (!fs.existsSync(claudePath)) {
      return null;
    }

    const content = fs.readFileSync(claudePath, 'utf-8');
    // Parse markdown sections into config
    // This is a simplified parser - production would be more robust

    const config: Partial<ObserverConfig> = {
      vault_path: this.vaultPath,
    };

    // Extract domains from WHAT section
    const domainsMatch = content.match(/## WHAT \(Domains\)([\s\S]*?)(?=##|$)/);
    if (domainsMatch) {
      const domainsSection = domainsMatch[1];
      const domainRows = domainsSection.match(/\| \*\*(\w+)\*\* \| `([^`]+)` \| ([^|]+) \|/g);
      if (domainRows) {
        config.domains = domainRows.map(row => {
          const match = row.match(/\| \*\*(\w+)\*\* \| `([^`]+)` \| ([^|]+) \|/);
          if (match) {
            return {
              keywords: match[3].split(',').map(k => k.trim().toLowerCase()),
              context: match[2],
            };
          }
          return null;
        }).filter(Boolean) as any[];
      }
    }

    return config;
  }

  // Load a specific loop configuration
  loadLoop(loopId: string): LoopConfig | null {
    const loopPath = path.join(this.observerPath, 'loops', `${loopId}.yaml`);
    if (!fs.existsSync(loopPath)) {
      return null;
    }

    const content = fs.readFileSync(loopPath, 'utf-8');
    return yaml.parse(content) as LoopConfig;
  }

  // Save a loop configuration
  saveLoop(config: LoopConfig): void {
    const loopPath = path.join(this.observerPath, 'loops', `${config.id}.yaml`);
    fs.writeFileSync(loopPath, yaml.stringify(config));
  }

  // List all loops
  listLoops(): LoopConfig[] {
    const loopsDir = path.join(this.observerPath, 'loops');
    if (!fs.existsSync(loopsDir)) {
      return [];
    }

    const files = fs.readdirSync(loopsDir).filter(f => f.endsWith('.yaml'));
    return files.map(f => {
      const content = fs.readFileSync(path.join(loopsDir, f), 'utf-8');
      return yaml.parse(content) as LoopConfig;
    });
  }

  // Load loop state
  loadLoopState(loopId: string): LoopState | null {
    const statePath = path.join(this.observerPath, 'loops', `${loopId}.state.json`);
    if (!fs.existsSync(statePath)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  }

  // Save loop state
  saveLoopState(state: LoopState): void {
    const statePath = path.join(this.observerPath, 'loops', `${state.id}.state.json`);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }

  // Add a correction
  addCorrection(correction: Correction): void {
    const correctionsPath = path.join(this.observerPath, 'corrections.jsonl');
    fs.appendFileSync(correctionsPath, JSON.stringify(correction) + '\n');

    // Update patterns if threshold reached
    this.updatePatterns(correction);
  }

  // Load all corrections
  loadCorrections(): Correction[] {
    const correctionsPath = path.join(this.observerPath, 'corrections.jsonl');
    if (!fs.existsSync(correctionsPath)) {
      return [];
    }

    const content = fs.readFileSync(correctionsPath, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  }

  // Load patterns
  loadPatterns(): Pattern[] {
    const patternsPath = path.join(this.observerPath, 'patterns.json');
    if (!fs.existsSync(patternsPath)) {
      return [];
    }

    const data = JSON.parse(fs.readFileSync(patternsPath, 'utf-8'));
    return data.patterns || [];
  }

  // Update patterns based on corrections
  private updatePatterns(correction: Correction): void {
    const patterns = this.loadPatterns();
    const existing = patterns.find(p => p.type === correction.type);

    if (existing) {
      existing.count++;
      existing.last_seen = correction.ts;
      if (!existing.triggers.includes(correction.trigger)) {
        existing.triggers.push(correction.trigger);
      }
      // Auto-correct after 3 occurrences
      if (existing.count >= 3) {
        existing.auto_correct = true;
      }
    } else {
      patterns.push({
        type: correction.type,
        triggers: [correction.trigger],
        count: 1,
        last_seen: correction.ts,
        auto_correct: false,
      });
    }

    const patternsPath = path.join(this.observerPath, 'patterns.json');
    fs.writeFileSync(patternsPath, JSON.stringify({ patterns }, null, 2));
  }

  // Write intake entry
  writeIntake(entry: Omit<IntakeEntry, 'captured'>): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${timestamp}.md`;
    const filepath = path.join(this.observerPath, 'intake', filename);

    const frontmatter: Record<string, any> = {
      type: 'intake',
      source: entry.type,
      captured: new Date().toISOString(),
    };

    // Only include optional fields if defined
    if (entry.duration !== undefined) frontmatter.duration = entry.duration;
    if (entry.avg_pace !== undefined) frontmatter.avg_pace = entry.avg_pace;
    if (entry.pauses !== undefined) frontmatter.pauses = entry.pauses;

    const content = matter.stringify(entry.content, frontmatter);
    fs.writeFileSync(filepath, content);

    return filepath;
  }
}

// Helper to find vault root (looks for CLAUDE.md)
export function findVaultRoot(startPath: string = process.cwd()): string | null {
  let current = startPath;

  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, CLAUDE_MD))) {
      return current;
    }
    current = path.dirname(current);
  }

  return null;
}
