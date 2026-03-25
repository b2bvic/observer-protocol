import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';

interface FileData {
  path: string;
  relativePath: string;
  domain: string;
  content: string;
  frontmatter: Record<string, any>;
  modified: Date;
  words: string[];
  entities: string[];
  topics: string[];
}

interface Recurrence {
  term: string;
  count: number;
  files: string[];
  type: 'entity' | 'topic' | 'phrase';
}

interface Contradiction {
  topic: string;
  statements: { file: string; statement: string }[];
}

interface MaintenanceFlag {
  file: string;
  issue: string;
  priority: 1 | 2 | 3;
  suggestion: string;
}

interface AnalysisResult {
  period_days: number;
  files_analyzed: number;
  domains_touched: string[];
  recurrences: Recurrence[];
  contradictions: Contradiction[];
  maintenance_flags: MaintenanceFlag[];
  unchecked_actions: { file: string; item: string }[];
  observations: string[];
}

export class Analyzer {
  private vaultPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
  }

  async analyze(days: number = 1): Promise<AnalysisResult> {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const files = this.getRecentFiles(cutoff);
    const fileData = files.map(f => this.parseFile(f));

    const result: AnalysisResult = {
      period_days: days,
      files_analyzed: fileData.length,
      domains_touched: [...new Set(fileData.map(f => f.domain))],
      recurrences: this.findRecurrences(fileData),
      contradictions: this.findContradictions(fileData),
      maintenance_flags: this.findMaintenanceFlags(fileData),
      unchecked_actions: this.findUncheckedActions(fileData),
      observations: [],
    };

    // Generate observations
    result.observations = this.generateObservations(result, fileData);

    return result;
  }

  private getRecentFiles(cutoff: number): string[] {
    const files: string[] = [];

    const walk = (dir: string): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.name.endsWith('.md')) {
            const stat = fs.statSync(fullPath);
            if (stat.mtimeMs > cutoff) {
              files.push(fullPath);
            }
          }
        }
      } catch (e) {}
    };

    walk(this.vaultPath);
    return files;
  }

  private parseFile(filePath: string): FileData {
    const content = fs.readFileSync(filePath, 'utf-8');
    const { data: frontmatter, content: body } = matter(content);
    const relativePath = path.relative(this.vaultPath, filePath);
    const domain = relativePath.split(path.sep)[0] || 'root';

    // Extract words (lowercase, no punctuation)
    const words = body.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3);

    // Extract entities (Title Case words, likely names/companies)
    const entityPattern = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g;
    const entities = [...new Set(body.match(entityPattern) || [])];

    // Extract topics from headers
    const headerPattern = /^#{1,3}\s+(.+)$/gm;
    const topics: string[] = [];
    let match;
    while ((match = headerPattern.exec(body)) !== null) {
      topics.push(match[1].toLowerCase().trim());
    }

    return {
      path: filePath,
      relativePath,
      domain,
      content: body,
      frontmatter,
      modified: fs.statSync(filePath).mtime,
      words,
      entities,
      topics,
    };
  }

  private findRecurrences(files: FileData[]): Recurrence[] {
    const recurrences: Recurrence[] = [];

    // Count entities across files
    const entityCounts: Map<string, Set<string>> = new Map();
    for (const file of files) {
      for (const entity of file.entities) {
        if (!entityCounts.has(entity)) {
          entityCounts.set(entity, new Set());
        }
        entityCounts.get(entity)!.add(file.relativePath);
      }
    }

    // Entities appearing in 2+ files
    for (const [entity, fileSet] of entityCounts) {
      if (fileSet.size >= 2) {
        recurrences.push({
          term: entity,
          count: fileSet.size,
          files: [...fileSet],
          type: 'entity',
        });
      }
    }

    // Count key phrases (bigrams/trigrams)
    const phraseCounts: Map<string, Set<string>> = new Map();
    const stopWords = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'been', 'will', 'would', 'could', 'should', 'about', 'into', 'more', 'some', 'than', 'them', 'then', 'there', 'these', 'they', 'what', 'when', 'where', 'which', 'while', 'your']);

    for (const file of files) {
      const significantWords = file.words.filter(w => !stopWords.has(w) && w.length > 4);
      for (let i = 0; i < significantWords.length - 1; i++) {
        const bigram = `${significantWords[i]} ${significantWords[i + 1]}`;
        if (!phraseCounts.has(bigram)) {
          phraseCounts.set(bigram, new Set());
        }
        phraseCounts.get(bigram)!.add(file.relativePath);
      }
    }

    // Phrases appearing in 3+ files
    for (const [phrase, fileSet] of phraseCounts) {
      if (fileSet.size >= 3) {
        recurrences.push({
          term: phrase,
          count: fileSet.size,
          files: [...fileSet],
          type: 'phrase',
        });
      }
    }

    // Sort by count descending
    return recurrences.sort((a, b) => b.count - a.count).slice(0, 20);
  }

  private findContradictions(files: FileData[]): Contradiction[] {
    const contradictions: Contradiction[] = [];

    // Look for status contradictions
    const statusByEntity: Map<string, { file: string; status: string }[]> = new Map();

    for (const file of files) {
      const statusMatch = file.content.match(/status[:\s]+([^\n]+)/i);
      if (statusMatch && file.frontmatter.client) {
        const client = String(file.frontmatter.client);
        if (!statusByEntity.has(client)) {
          statusByEntity.set(client, []);
        }
        statusByEntity.get(client)!.push({
          file: file.relativePath,
          status: statusMatch[1].trim(),
        });
      }
    }

    // Check for conflicting statuses
    for (const [entity, statuses] of statusByEntity) {
      const uniqueStatuses = [...new Set(statuses.map(s => s.status.toLowerCase()))];
      if (uniqueStatuses.length > 1) {
        contradictions.push({
          topic: `${entity} status`,
          statements: statuses.map(s => ({ file: s.file, statement: s.status })),
        });
      }
    }

    // Look for numeric contradictions (same metric, different values)
    const dollarAmounts: Map<string, { file: string; amount: string; context: string }[]> = new Map();

    for (const file of files) {
      const amountPattern = /\$[\d,]+(?:\/mo)?/g;
      let match;
      while ((match = amountPattern.exec(file.content)) !== null) {
        const context = file.content.slice(Math.max(0, match.index - 50), match.index + match[0].length + 50);
        // Group by nearby entity
        for (const entity of file.entities) {
          if (context.includes(entity) || file.relativePath.includes(entity.split(' ')[0])) {
            const key = entity;
            if (!dollarAmounts.has(key)) {
              dollarAmounts.set(key, []);
            }
            dollarAmounts.get(key)!.push({
              file: file.relativePath,
              amount: match[0],
              context: context.trim(),
            });
          }
        }
      }
    }

    return contradictions;
  }

  private findMaintenanceFlags(files: FileData[]): MaintenanceFlag[] {
    const flags: MaintenanceFlag[] = [];

    for (const file of files) {
      // Check for stale "in progress" status
      if (file.frontmatter.status === 'in_progress' || file.frontmatter.status === 'in-progress') {
        const daysSinceModified = (Date.now() - file.modified.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceModified > 7) {
          flags.push({
            file: file.relativePath,
            issue: 'stale_progress',
            priority: 2,
            suggestion: `Status "in_progress" but not modified in ${Math.floor(daysSinceModified)} days`,
          });
        }
      }

      // Check for broken wikilinks
      const wikilinkPattern = /\[\[([^\]]+)\]\]/g;
      let match;
      while ((match = wikilinkPattern.exec(file.content)) !== null) {
        const linkTarget = match[1].split('|')[0]; // Handle aliased links
        const possiblePaths = [
          path.join(this.vaultPath, linkTarget + '.md'),
          path.join(this.vaultPath, linkTarget),
          path.join(path.dirname(file.path), linkTarget + '.md'),
        ];

        const exists = possiblePaths.some(p => fs.existsSync(p));
        if (!exists && !linkTarget.startsWith('http')) {
          flags.push({
            file: file.relativePath,
            issue: 'broken_link',
            priority: 3,
            suggestion: `Broken wikilink: [[${linkTarget}]]`,
          });
        }
      }

      // Check for missing frontmatter
      if (!file.frontmatter.type && !file.relativePath.includes('_index')) {
        flags.push({
          file: file.relativePath,
          issue: 'missing_type',
          priority: 3,
          suggestion: 'Missing type:: in frontmatter',
        });
      }

      // Check for _Progress.md files that might be stale
      if (file.relativePath.includes('_Progress')) {
        const hasOldDates = /202[0-4]\.\d{2}\.\d{2}/.test(file.content);
        if (hasOldDates) {
          flags.push({
            file: file.relativePath,
            issue: 'stale_progress',
            priority: 2,
            suggestion: 'Progress file references old dates',
          });
        }
      }
    }

    // Sort by priority
    return flags.sort((a, b) => a.priority - b.priority).slice(0, 20);
  }

  private findUncheckedActions(files: FileData[]): { file: string; item: string }[] {
    const unchecked: { file: string; item: string }[] = [];

    for (const file of files) {
      // Match unchecked checkboxes
      const checkboxPattern = /^[\s-]*\[ \]\s+(.+)$/gm;
      let match;
      while ((match = checkboxPattern.exec(file.content)) !== null) {
        unchecked.push({
          file: file.relativePath,
          item: match[1].trim(),
        });
      }
    }

    return unchecked.slice(0, 30);
  }

  private generateObservations(result: AnalysisResult, files: FileData[]): string[] {
    const observations: string[] = [];

    // Domain activity
    if (result.domains_touched.length > 1) {
      observations.push(`Cross-domain activity: ${result.domains_touched.join(', ')}`);
    }

    // Recurrence patterns
    const topRecurrences = result.recurrences.slice(0, 3);
    for (const r of topRecurrences) {
      if (r.type === 'entity') {
        observations.push(`"${r.term}" appears in ${r.count} files`);
      }
    }

    // Unchecked items
    if (result.unchecked_actions.length > 5) {
      observations.push(`${result.unchecked_actions.length} unchecked action items across files`);
    }

    // Maintenance concerns
    const criticalFlags = result.maintenance_flags.filter(f => f.priority === 1);
    if (criticalFlags.length > 0) {
      observations.push(`${criticalFlags.length} critical maintenance issues`);
    }

    // Time-based patterns
    const filesByHour: Map<number, number> = new Map();
    for (const file of files) {
      const hour = file.modified.getHours();
      filesByHour.set(hour, (filesByHour.get(hour) || 0) + 1);
    }
    const peakHour = [...filesByHour.entries()].sort((a, b) => b[1] - a[1])[0];
    if (peakHour && peakHour[1] > 5) {
      observations.push(`Peak activity at ${peakHour[0]}:00 (${peakHour[1]} files)`);
    }

    // Client focus detection
    const clientFiles = files.filter(f => f.frontmatter.client);
    if (clientFiles.length > 0) {
      const clients = [...new Set(clientFiles.map(f => String(f.frontmatter.client)))];
      observations.push(`Client work: ${clients.join(', ')}`);
    }

    return observations;
  }

  formatOutput(result: AnalysisResult): string {
    const lines: string[] = [];

    lines.push(`\nOBSERVER ANALYSIS — Last ${result.period_days} day(s)\n`);
    lines.push('═'.repeat(50));

    // Summary
    lines.push(`\nFILES: ${result.files_analyzed}`);
    lines.push(`DOMAINS: ${result.domains_touched.join(', ')}`);

    // Recurrences
    if (result.recurrences.length > 0) {
      lines.push('\n─── RECURRENCE ───\n');
      for (const r of result.recurrences.slice(0, 10)) {
        const filesStr = r.files.slice(0, 2).join(', ') + (r.files.length > 2 ? ` +${r.files.length - 2}` : '');
        lines.push(`  "${r.term}" (${r.count}x) — ${filesStr}`);
      }
    }

    // Contradictions
    if (result.contradictions.length > 0) {
      lines.push('\n─── CONTRADICTIONS ───\n');
      for (const c of result.contradictions) {
        lines.push(`  ${c.topic}:`);
        for (const s of c.statements) {
          lines.push(`    • ${s.file}: "${s.statement}"`);
        }
      }
    }

    // Maintenance
    if (result.maintenance_flags.length > 0) {
      lines.push('\n─── MAINTENANCE ───\n');
      for (const f of result.maintenance_flags.slice(0, 10)) {
        lines.push(`  [P${f.priority}] ${f.file}`);
        lines.push(`      ${f.suggestion}`);
      }
    }

    // Unchecked actions
    if (result.unchecked_actions.length > 0) {
      lines.push('\n─── UNCHECKED ACTIONS ───\n');
      for (const a of result.unchecked_actions.slice(0, 10)) {
        lines.push(`  [ ] ${a.item}`);
        lines.push(`      └─ ${a.file}`);
      }
      if (result.unchecked_actions.length > 10) {
        lines.push(`  ... and ${result.unchecked_actions.length - 10} more`);
      }
    }

    // Observations
    if (result.observations.length > 0) {
      lines.push('\n─── OBSERVATIONS ───\n');
      for (const o of result.observations) {
        lines.push(`  • ${o}`);
      }
    }

    lines.push('\n');
    return lines.join('\n');
  }
}
