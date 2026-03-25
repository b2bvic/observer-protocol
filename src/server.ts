import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { Config, findVaultRoot } from './config';
import { LoopRunner } from './loop-runner';
import { Analyzer } from './analyzer';
import { IntakeEntry } from './types';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Auth middleware
const authMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const authHeader = req.headers.authorization;
  const token = process.env.OBSERVER_TOKEN;

  if (!token) {
    // No token configured, allow all
    return next();
  }

  if (!authHeader || authHeader !== `Bearer ${token}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
};

// Find vault on startup
const vaultPath = findVaultRoot() || process.env.VAULT_PATH;
if (!vaultPath) {
  console.error('Could not find vault. Set VAULT_PATH or run from within vault.');
  process.exit(1);
}

const config = new Config(vaultPath);
const loopRunner = new LoopRunner(vaultPath);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', vault: vaultPath });
});

// Voice intake endpoint
app.post('/intake/voice', authMiddleware, (req, res) => {
  try {
    const { content, duration, source } = req.body;

    if (!content) {
      return res.status(400).json({ error: 'Content required' });
    }

    const entry: Omit<IntakeEntry, 'captured'> = {
      type: 'voice',
      source: source || 'webhook',
      content,
      duration: duration ? parseInt(duration) : undefined,
    };

    const filepath = config.writeIntake(entry);

    console.log(`Intake received: ${filepath}`);

    res.json({
      status: 'captured',
      path: filepath,
      preview: content.substring(0, 100),
    });

  } catch (error: any) {
    console.error('Intake error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Text intake endpoint
app.post('/intake/text', authMiddleware, (req, res) => {
  try {
    const { content, source } = req.body;

    if (!content) {
      return res.status(400).json({ error: 'Content required' });
    }

    const entry: Omit<IntakeEntry, 'captured'> = {
      type: 'text',
      source: source || 'webhook',
      content,
    };

    const filepath = config.writeIntake(entry);

    res.json({
      status: 'captured',
      path: filepath,
    });

  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// SMS webhook (Twilio format)
app.post('/sms/inbound', (req, res) => {
  try {
    const { From, Body } = req.body;

    console.log(`SMS from ${From}: ${Body}`);

    // Parse command
    const body = Body.trim().toUpperCase();

    if (body === 'Y' || body === 'YES') {
      // Approve most recent pending draft
      const draftsPath = path.join(vaultPath!, '.observer', 'drafts');
      if (fs.existsSync(draftsPath)) {
        const files = fs.readdirSync(draftsPath).filter(f => f.endsWith('.md'));
        for (const file of files.sort().reverse()) {
          const draftPath = path.join(draftsPath, file);
          let content = fs.readFileSync(draftPath, 'utf-8');
          if (content.includes('status:: pending')) {
            content = content.replace(/status::\s*pending/, 'status:: approved');
            content = content.replace(/---\n/, `---\napproved_at:: ${new Date().toISOString()}\napproved_via:: sms\n`);
            fs.writeFileSync(draftPath, content);
            res.type('text/xml').send(`<Response><Message>Approved: ${file.replace('.md', '')}</Message></Response>`);
            return;
          }
        }
      }
      res.type('text/xml').send('<Response><Message>No pending drafts.</Message></Response>');
      return;
    }

    if (body === 'N' || body === 'NO') {
      // Reject most recent pending draft
      const draftsPath = path.join(vaultPath!, '.observer', 'drafts');
      if (fs.existsSync(draftsPath)) {
        const files = fs.readdirSync(draftsPath).filter(f => f.endsWith('.md'));
        for (const file of files.sort().reverse()) {
          const draftPath = path.join(draftsPath, file);
          let content = fs.readFileSync(draftPath, 'utf-8');
          if (content.includes('status:: pending')) {
            content = content.replace(/status::\s*pending/, 'status:: rejected');
            content = content.replace(/---\n/, `---\nrejected_at:: ${new Date().toISOString()}\nrejected_via:: sms\n`);
            fs.writeFileSync(draftPath, content);
            res.type('text/xml').send(`<Response><Message>Rejected: ${file.replace('.md', '')}</Message></Response>`);
            return;
          }
        }
      }
      res.type('text/xml').send('<Response><Message>No pending drafts.</Message></Response>');
      return;
    }

    if (body === 'STATUS') {
      const loops = config.listLoops();
      const active = loops.filter(l => l.status === 'active').length;
      res.type('text/xml').send(`<Response><Message>${active} active loops.</Message></Response>`);
      return;
    }

    if (body.startsWith('PAUSE ')) {
      const loopId = body.replace('PAUSE ', '').toLowerCase();
      const loop = config.loadLoop(loopId);
      if (loop) {
        loop.status = 'paused';
        config.saveLoop(loop);
        loopRunner.stop(loopId);
        res.type('text/xml').send(`<Response><Message>Paused ${loopId}.</Message></Response>`);
      } else {
        res.type('text/xml').send(`<Response><Message>Loop not found: ${loopId}</Message></Response>`);
      }
      return;
    }

    if (body.startsWith('NOTE:') || body.startsWith('NOTE ')) {
      const note = Body.substring(Body.indexOf(':') + 1).trim() || Body.substring(5).trim();
      const entry: Omit<IntakeEntry, 'captured'> = {
        type: 'text',
        source: 'sms',
        content: note,
      };
      config.writeIntake(entry);
      res.type('text/xml').send('<Response><Message>Noted.</Message></Response>');
      return;
    }

    // Unknown command - treat as intake
    const entry: Omit<IntakeEntry, 'captured'> = {
      type: 'text',
      source: 'sms',
      content: Body,
    };
    config.writeIntake(entry);
    res.type('text/xml').send('<Response><Message>Captured.</Message></Response>');

  } catch (error: any) {
    console.error('SMS error:', error);
    res.type('text/xml').send('<Response><Message>Error processing.</Message></Response>');
  }
});

// Loop management endpoints
app.get('/loops', authMiddleware, (req, res) => {
  const loops = config.listLoops();
  res.json(loops.map(l => ({
    id: l.id,
    status: l.status,
    objective: l.objective,
  })));
});

app.post('/loops/:id/run', authMiddleware, async (req, res) => {
  try {
    const result = await loopRunner.runOnce(req.params.id);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/loops/:id/pause', authMiddleware, (req, res) => {
  const loop = config.loadLoop(req.params.id);
  if (!loop) {
    return res.status(404).json({ error: 'Loop not found' });
  }

  loop.status = 'paused';
  config.saveLoop(loop);
  loopRunner.stop(req.params.id);

  res.json({ status: 'paused' });
});

app.post('/loops/:id/resume', authMiddleware, async (req, res) => {
  const loop = config.loadLoop(req.params.id);
  if (!loop) {
    return res.status(404).json({ error: 'Loop not found' });
  }

  loop.status = 'active';
  config.saveLoop(loop);
  await loopRunner.start(req.params.id);

  res.json({ status: 'active' });
});

// Draft endpoints
app.get('/drafts', authMiddleware, (req, res) => {
  const draftsPath = path.join(vaultPath!, '.observer', 'drafts');

  if (!fs.existsSync(draftsPath)) {
    return res.json([]);
  }

  const files = fs.readdirSync(draftsPath).filter(f => f.endsWith('.md'));
  const drafts = files.map(file => {
    const content = fs.readFileSync(path.join(draftsPath, file), 'utf-8');
    const statusMatch = content.match(/status::\s*(\w+)/);
    const loopMatch = content.match(/loop::\s*(\S+)/);
    const createdMatch = content.match(/created::\s*(\S+)/);

    return {
      id: file.replace('.md', ''),
      status: statusMatch ? statusMatch[1] : 'unknown',
      loop: loopMatch ? loopMatch[1] : 'unknown',
      created: createdMatch ? createdMatch[1] : '',
      preview: content.replace(/^---[\s\S]*?---\n?/, '').trim().slice(0, 100),
    };
  });

  res.json(drafts);
});

app.get('/drafts/pending', authMiddleware, (req, res) => {
  const draftsPath = path.join(vaultPath!, '.observer', 'drafts');

  if (!fs.existsSync(draftsPath)) {
    return res.json([]);
  }

  const files = fs.readdirSync(draftsPath).filter(f => f.endsWith('.md'));
  const pending = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(draftsPath, file), 'utf-8');
    if (content.includes('status:: pending')) {
      const loopMatch = content.match(/loop::\s*(\S+)/);
      pending.push({
        id: file.replace('.md', ''),
        loop: loopMatch ? loopMatch[1] : 'unknown',
        preview: content.replace(/^---[\s\S]*?---\n?/, '').trim().slice(0, 100),
      });
    }
  }

  res.json(pending);
});

app.post('/drafts/:id/approve', authMiddleware, (req, res) => {
  const draftPath = path.join(vaultPath!, '.observer', 'drafts', `${req.params.id}.md`);

  if (!fs.existsSync(draftPath)) {
    return res.status(404).json({ error: 'Draft not found' });
  }

  let content = fs.readFileSync(draftPath, 'utf-8');
  content = content.replace(/status::\s*pending/, 'status:: approved');
  content = content.replace(/---\n/, `---\napproved_at:: ${new Date().toISOString()}\n`);
  fs.writeFileSync(draftPath, content);

  res.json({ status: 'approved', id: req.params.id });
});

app.post('/drafts/:id/reject', authMiddleware, (req, res) => {
  const draftPath = path.join(vaultPath!, '.observer', 'drafts', `${req.params.id}.md`);

  if (!fs.existsSync(draftPath)) {
    return res.status(404).json({ error: 'Draft not found' });
  }

  let content = fs.readFileSync(draftPath, 'utf-8');
  content = content.replace(/status::\s*pending/, 'status:: rejected');

  const reason = req.body.reason || '';
  if (reason) {
    content = content.replace(/---\n/, `---\nrejection_reason:: ${reason}\n`);
  }

  fs.writeFileSync(draftPath, content);

  res.json({ status: 'rejected', id: req.params.id, reason });
});

// Corrections endpoint
app.get('/corrections', authMiddleware, (req, res) => {
  const corrections = config.loadCorrections();
  const patterns = config.loadPatterns();
  res.json({ corrections, patterns });
});

app.post('/corrections', authMiddleware, (req, res) => {
  const { type, trigger, action } = req.body;

  if (!type || !trigger) {
    return res.status(400).json({ error: 'type and trigger required' });
  }

  config.addCorrection({
    ts: new Date().toISOString(),
    type,
    trigger,
    action: action || 'stop',
  });

  res.json({ status: 'logged' });
});

// Reflection endpoint
app.get('/reflect', authMiddleware, (req, res) => {
  const days = parseInt(req.query.days as string) || 7;
  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

  const corrections = config.loadCorrections();
  const patterns = config.loadPatterns();
  const loops = config.listLoops();

  // Intake stats
  const intakePath = path.join(vaultPath!, '.observer', 'intake');
  let intakeCount = 0;
  let totalWords = 0;

  if (fs.existsSync(intakePath)) {
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

  // Loop stats
  let totalRuns = 0;
  let successRuns = 0;
  for (const loop of loops) {
    const state = config.loadLoopState(loop.id);
    if (state) {
      const recentRuns = state.history.filter(r =>
        new Date(r.timestamp).getTime() > cutoff
      );
      totalRuns += recentRuns.length;
      successRuns += recentRuns.filter(r => r.status === 'success').length;
    }
  }

  res.json({
    period_days: days,
    intake: {
      count: intakeCount,
      total_words: totalWords,
      avg_words: intakeCount > 0 ? Math.round(totalWords / intakeCount) : 0,
    },
    corrections: {
      total: corrections.length,
      patterns: patterns.length,
      auto_correcting: patterns.filter(p => p.auto_correct).length,
    },
    loops: {
      total_runs: totalRuns,
      success_rate: totalRuns > 0 ? Math.round(successRuns / totalRuns * 100) : 0,
      active: loops.filter(l => l.status === 'active').length,
      total: loops.length,
    },
  });
});

// Recent files endpoint
app.get('/recent', authMiddleware, (req, res) => {
  const days = parseInt(req.query.days as string) || 1;
  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

  const walkDir = (dir: string, files: string[] = []): string[] => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        if (entry.isDirectory()) {
          walkDir(fullPath, files);
        } else if (entry.name.endsWith('.md')) {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > cutoff) {
            files.push(path.relative(vaultPath!, fullPath));
          }
        }
      }
    } catch (e) {}
    return files;
  };

  const files = walkDir(vaultPath!);
  res.json({ files, count: files.length, days });
});

// Analyze endpoint - the brain
app.get('/analyze', authMiddleware, async (req, res) => {
  const days = parseInt(req.query.days as string) || 1;

  const analyzer = new Analyzer(vaultPath!);
  const result = await analyzer.analyze(days);

  res.json(result);
});

// Start server
const PORT = process.env.PORT || 3847;

export function startServer() {
  app.listen(PORT, () => {
    console.log(`Observer server running on port ${PORT}`);
    console.log(`Vault: ${vaultPath}`);

    // Start active loops
    loopRunner.startAll().then(() => {
      console.log('Loops initialized');
    });
  });
}

// Run if called directly
if (require.main === module) {
  startServer();
}

export { app };
