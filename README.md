# AI agent governance protocol: observer-protocol

Observer-protocol captures Markdown intake, correction history, and local drafts for operators who review hosted-model work.
It helps you inspect recent record patterns and retain human review status before connecting an action service.

[Project page](https://scalewithsearch.com/code/observer-protocol)

## Install

Use Node.js 22 or 24, npm, and Git.

```bash
git clone https://github.com/b2bvic/observer-protocol.git
cd observer-protocol
npm ci
npm run build
```

## Quick start

Use a temporary Markdown record:

```bash
demo_record=$(mktemp -d)
export VAULT_PATH="$demo_record"
node dist/cli.js init
node dist/cli.js intake "Review the synthetic release notes."
node dist/cli.js status
node dist/cli.js reflect -d 7
```

The commands create `.observer/` storage, capture an intake file, and report local status.
`VAULT_PATH` selects the record explicitly. Without it, vault discovery looks for an ancestor `CLAUDE.md`.
Run `node dist/cli.js --help` to inspect the available commands.

## How it works

`Config` stores intake as Markdown, corrections as JSONL, patterns as JSON, and loops as YAML.
The analyzer scans recent Markdown files for recurring terms, possible contradictions, maintenance flags, and unchecked checkboxes.
Markdown agent behavior analysis uses heuristics. Review each finding against its source.
Agent correction history records triggers and repeated pattern counts; the `auto_correct` flag does not implement a text rewriter.

A loop with `require_approval: true` writes a pending draft.
CLI and HTTP draft commands update YAML status to approved or rejected and preserve the body.
These local review records are patterns a team can adopt for human-in-the-loop agent review.
Connect a separate action service that checks authorization where the action executes.

The optional webhook server binds to `127.0.0.1`. Protected endpoints require `OBSERVER_TOKEN`; `/health` reports only service status.
Set a token and review active loop configurations before running `node dist/cli.js server`.
The server starts configured active loops when it starts.

Run the checks:

```bash
npm run lint
npm test
npm audit --audit-level=moderate
```

## Limits

- This prototype supplies local records and heuristic analysis. It contains no model invocation, publishing adapter, or universal approval service.
- Approving a draft changes local status. It does not publish the draft or grant permission to an external service.
- Pending drafts do not stop active schedules. The current daily counter reset does not establish a reliable daily quota.
- Stopping an interval does not cancel an already queued jitter callback. Review scheduling behavior before using it for production work.
- Loop paths, regexes, and the vault must be trusted. Identifier validation does not create a filesystem sandbox or protect against symlink escapes.
- Privacy filters match basic text patterns. They do not prove that output contains no private information.
- Default draft commands inspect `.observer/drafts/`. A custom `draft_path` requires your own review adapter.
- `plugin/scripts/` contains a companion shell analyzer. It is not an installable Obsidian plugin.

## Related repositories

- [agent-oversight](https://github.com/b2bvic/agent-oversight): orchestration cluster and evaluation guide.
- [observer-daemon](https://github.com/b2bvic/observer-daemon): deterministic response writing checks.
- [skills](https://github.com/b2bvic/skills): explicit local artifact verification.
- [safe-api](https://github.com/b2bvic/safe-api): configured controls around REST write calls.

## License

[MIT](LICENSE).
