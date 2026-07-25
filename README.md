# Observer Protocol

AI agent protocol for local markdown vaults. Two-way negation between human and machine. Catches drift on both sides.

Built by [Victor Valentine Romo](https://victorvalentineromo.com) at [Scale With Search](https://scalewithsearch.com).

Part of a larger system: this repository documents **P11 (voice is a written standard)** from the [Seventeen Principles](https://victorvalentineromo.com/principles). It is the written standard; [observer-daemon](https://github.com/b2bvic/observer-daemon) is the machine that enforces it.

## What It Does

- **Intake**: Capture voice/text into vault via webhooks or CLI
- **Loops**: Self-running tasks with approval gates
- **Corrections**: Log when you're corrected, learn patterns, auto-correct
- **Drafts**: Queue outputs for approval before publishing
- **Reflection**: Analyze activity patterns over time

## Install

```bash
cd Observer\ Protocol
npm install
```

## Usage

### CLI

```bash
# Initialize .observer in vault
npm run dev -- init

# Check status
npm run dev -- status

# Start webhook server
npm run dev -- server

# Manual intake
npm run dev -- intake "thought to capture"

# List loops
npm run dev -- loop list

# Run a loop once
npm run dev -- loop run <id>

# List pending drafts
npm run dev -- drafts

# Approve/reject drafts
npm run dev -- approve <id>
npm run dev -- reject <id> -r "reason"

# Reflection analysis
npm run dev -- reflect -d 7

# Recent files
npm run dev -- recent -d 1

# View corrections
npm run dev -- corrections
```

### Webhook Endpoints

```
GET  /health              Health check
POST /intake/voice        Voice transcription
POST /intake/text         Text intake
GET  /loops               List loops
POST /loops/:id/run       Run loop once
POST /loops/:id/pause     Pause loop
POST /loops/:id/resume    Resume loop
GET  /drafts              List all drafts
GET  /drafts/pending      List pending drafts
POST /drafts/:id/approve  Approve draft
POST /drafts/:id/reject   Reject draft
GET  /corrections         Get corrections/patterns
POST /corrections         Log a correction
GET  /reflect             Reflection analysis
GET  /recent              Recent file changes
```

### Voice Intake (iOS)

Hardware button → Wispr Flow → Webhook → Vault

See `iOS Shortcut Setup.md` for configuration.

## Directory Structure

```
.observer/
├── corrections.jsonl     # Logged corrections
├── patterns.json         # Learned patterns
├── loops/                # Loop YAML configs
│   └── *.yaml
├── drafts/               # Pending outputs
│   └── *.md
└── intake/               # Captured voice/text
    └── *.md
```

## Loop Configuration

```yaml
id: example-loop
type: interval
status: active
objective: "What this loop does"

source:
  paths:
    - "folder/**/*.md"
  filter: "status:: ready"

constraints:
  privacy_weight: 0.7
  restricted_topics:
    - client-names
    - revenue-numbers
  max_per_day: 3

schedule:
  type: interval
  value: 8h
  jitter: 2h
  active_hours: [8, 22]

output:
  require_approval: true
  draft_path: "Drafts/"
```

## Obsidian Plugin

Plugin scaffolding in `obsidian-plugin/`. To install:

```bash
cd obsidian-plugin
npm install
npm run build
```

Copy `main.js`, `styles.css`, `manifest.json` to `.obsidian/plugins/observer-protocol/`

## Philosophy

This is not a second brain. It's a control system.

The daemon doesn't speak. It listens. When you drift, it catches you. When it drifts, you correct it.

Voice is closer to raw signal than typing. Approval gates prevent automation from running ahead.

Built for sovereignty-seekers with friction tolerance.

## How this was built

Specification and judgment: human. Implementation: AI models executing that specification under a build contract, with an adversarial audit before publish. The division of labor is the point; see [P07](https://victorvalentineromo.com/principles).
