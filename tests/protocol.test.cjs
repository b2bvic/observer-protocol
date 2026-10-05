const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(process.cwd(), '.test-'));
process.env.VAULT_PATH = root;
fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Synthetic record\n');
const { Config } = require('../dist/config');
const { LoopRunner } = require('../dist/loop-runner');
const config = new Config(root);
after(() => fs.rmSync(root, { recursive: true, force: true }));

function loop(id, approval = true) {
  return {
    id, type: 'interval', status: 'paused', objective: 'Synthetic local draft',
    source: { paths: ['notes/*.md'], filter: 'status:: ready' },
    constraints: { privacy_weight: 0.5, restricted_topics: ['restricted-example'] },
    output: { require_approval: approval, log_path: 'activity.md' }, on_complete: 'pause',
  };
}

test('init is idempotent and intake preserves text', async () => {
  await config.init();
  const file = config.writeIntake({ type: 'text', source: 'test', content: 'Synthetic intake' });
  await config.init();
  assert.match(fs.readFileSync(file, 'utf8'), /Synthetic intake/);
  assert.deepEqual(config.loadCorrections(), []);
});

test('corrections persist and recurring pattern tracks three records', () => {
  for (let i = 0; i < 3; i++) {
    config.addCorrection({ ts: new Date().toISOString(), type: 'voice', trigger: 'synthetic', action: 'stop' });
  }
  assert.equal(config.loadCorrections().length, 3);
  assert.equal(config.loadPatterns()[0].count, 3);
  assert.equal(config.loadPatterns()[0].auto_correct, true);
});

test('manual loop writes a filtered draft and preserves the source', async () => {
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  const source = path.join(root, 'notes', 'example.md');
  const original = '---\nstatus: ready\n---\nEmail example@example.com. restricted-example.\n';
  fs.writeFileSync(source, original);
  config.saveLoop(loop('draft-example'));
  const run = await new LoopRunner(root).runOnce('draft-example');
  assert.equal(run.status, 'pending_approval');
  const draft = fs.readFileSync(run.output, 'utf8');
  assert.match(draft, /status: pending/);
  assert.match(draft, /\[email\]/);
  assert.match(draft, /\[restricted\]/);
  assert.equal(fs.readFileSync(source, 'utf8'), original);
  assert.equal(config.loadLoopState('draft-example').history[0].status, 'pending_approval');
});

test('no matching input records an explicit skipped result', async () => {
  const input = loop('missing-example');
  input.source.paths = ['missing/*.md'];
  config.saveLoop(input);
  const run = await new LoopRunner(root).runOnce(input.id);
  assert.equal(run.status, 'skipped');
});

test('cron v4 schedule can start and stop without running a loop', async () => {
  const input = loop('cron-example');
  input.status = 'active';
  input.schedule = { type: 'cron', value: '0 0 1 1 *' };
  config.saveLoop(input);
  const runner = new LoopRunner(root);
  await runner.start(input.id);
  runner.stop(input.id);
  assert.deepEqual(config.loadLoopState(input.id).history, []);
  input.status = 'paused';
  config.saveLoop(input);
});

test('compiled CLI initializes and reports a synthetic vault', () => {
  const cli = path.join(process.cwd(), 'dist/cli.js');
  const env = { ...process.env, VAULT_PATH: root };
  assert.match(execFileSync(process.execPath, [cli, 'init'], { env, encoding: 'utf8' }), /Initialized/);
  assert.match(execFileSync(process.execPath, [cli, 'status'], { env, encoding: 'utf8' }), /initialized/);
});

test('protected HTTP endpoints deny absent or invalid credentials', async () => {
  const { app } = require('../dist/server');
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    delete process.env.OBSERVER_TOKEN;
    const health = await (await fetch(`${url}/health`)).json();
    assert.deepEqual(health, { status: 'ok' });
    assert.equal((await fetch(`${url}/loops`)).status, 503);
    process.env.OBSERVER_TOKEN = 'synthetic-test-token';
    assert.equal((await fetch(`${url}/loops`)).status, 401);
    const result = await fetch(`${url}/loops`, { headers: { Authorization: 'Bearer synthetic-test-token' } });
    assert.equal(result.status, 200);
  } finally {
    delete process.env.OBSERVER_TOKEN;
    await new Promise(resolve => server.close(resolve));
  }
});

test('draft approval parses YAML and preserves the body', () => {
  const { readDraft, setDraftStatus } = require('../dist/drafts');
  const folder = path.join(root, '.observer', 'drafts');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'review-example.md');
  fs.writeFileSync(file, '---\nstatus: pending\nloop: review\n---\nSynthetic body.\n');
  setDraftStatus(root, 'review-example', 'approved');
  const draft = readDraft(file);
  assert.equal(draft.data.status, 'approved');
  assert.match(draft.content, /Synthetic body/);
  assert.ok(draft.data.approved_at);
  assert.throws(() => setDraftStatus(root, 'review-example', 'rejected'), /pending/);
});

test('legacy draft fields normalize and rejection reason stays YAML data', () => {
  const { readDraft, setDraftStatus } = require('../dist/drafts');
  const file = path.join(root, '.observer', 'drafts', 'legacy-example.md');
  fs.writeFileSync(file, '---\nstatus:: pending\nloop:: review\n---\nLegacy body.\n');
  setDraftStatus(root, 'legacy-example', 'rejected', 'first line\nstatus: approved');
  const draft = readDraft(file);
  assert.equal(draft.data.status, 'rejected');
  assert.equal(draft.data.rejection_reason, 'first line\nstatus: approved');
});

test('loop and draft identifiers reject traversal', () => {
  const { setDraftStatus } = require('../dist/drafts');
  for (const id of ['../outside', '/absolute', 'x/y', '..', 'x\\y']) {
    assert.throws(() => config.loadLoop(id), /Identifier/);
    assert.throws(() => config.saveLoop(loop(id)), /Identifier/);
    assert.throws(() => setDraftStatus(root, id, 'approved'), /Identifier/);
  }
});

test('CLI draft commands share the YAML status implementation', () => {
  const cli = path.join(process.cwd(), 'dist/cli.js');
  const file = path.join(root, '.observer', 'drafts', 'cli-example.md');
  const env = { ...process.env, VAULT_PATH: root };
  fs.writeFileSync(file, '---\nstatus: pending\nloop: cli-example\n---\nCLI body.\n');
  assert.match(execFileSync(process.execPath, [cli, 'drafts'], { env, encoding: 'utf8' }), /PENDING/);
  execFileSync(process.execPath, [cli, 'approve', 'cli-example'], { env });
  assert.equal(require('../dist/drafts').readDraft(file).data.status, 'approved');
  for (const id of ['cli-example', '../outside']) {
    const result = spawnSync(process.execPath, [cli, 'reject', id], { env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  }
  assert.equal(require('../dist/drafts').readDraft(file).data.status, 'approved');
});

test('server startup binds loopback and HTTP review persists draft status', async () => {
  const { startServer } = require('../dist/server');
  const { readDraft } = require('../dist/drafts');
  process.env.PORT = '0';
  process.env.OBSERVER_TOKEN = 'synthetic-test-token';
  const file = path.join(root, '.observer', 'drafts', 'http-example.md');
  fs.writeFileSync(file, '---\nstatus: pending\nloop: http-example\n---\nHTTP body.\n');
  const server = startServer();
  await new Promise(resolve => server.on('listening', resolve));
  try {
    assert.equal(server.address().address, '127.0.0.1');
    const url = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: 'Bearer synthetic-test-token' };
    const pending = await (await fetch(`${url}/drafts/pending`, { headers })).json();
    assert.ok(pending.some(draft => draft.id === 'http-example'));
    const response = await fetch(`${url}/drafts/http-example/approve`, { method: 'POST', headers });
    assert.equal(response.status, 200);
    assert.equal(readDraft(file).data.status, 'approved');
    const repeat = await fetch(`${url}/drafts/http-example/reject`, { method: 'POST', headers });
    assert.equal(repeat.status, 409);
    assert.equal(readDraft(file).data.status, 'approved');
    const invalid = await fetch(`${url}/drafts/x%2Fy/approve`, { method: 'POST', headers });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: 'Invalid draft identifier' });
    const missing = await fetch(`${url}/drafts/absent-example/approve`, { method: 'POST', headers });
    assert.equal(missing.status, 404);
  } finally {
    delete process.env.PORT;
    delete process.env.OBSERVER_TOKEN;
    await new Promise(resolve => server.close(resolve));
  }
});

test('explicit vault overrides a discovered parent record', () => {
  const other = path.join(root, 'other-record');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'CLAUDE.md'), '# Other synthetic record\n');
  const cli = path.join(process.cwd(), 'dist/cli.js');
  const output = execFileSync(process.execPath, [cli, 'status'], {
    cwd: other, env: { ...process.env, VAULT_PATH: root }, encoding: 'utf8',
  });
  assert.ok(output.includes(`Vault: ${root}\n`));
  assert.ok(!output.includes(`Vault: ${other}\n`));
});

test('CLI help does not initialize the webhook server or require a vault', () => {
  const cli = path.join(process.cwd(), 'dist/cli.js');
  const configModule = path.join(process.cwd(), 'dist/config.js');
  const env = { ...process.env };
  delete env.VAULT_PATH;
  const script = `require(${JSON.stringify(configModule)}).findVaultRoot = () => null;
    process.argv = [process.execPath, ${JSON.stringify(cli)}, '--help'];
    require(${JSON.stringify(cli)});`;
  const output = execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
  assert.match(output, /Usage: observer/);
});
