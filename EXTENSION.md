# Subagent Extension Documentation

This extension adds a `subagent` tool to pi. The tool delegates work to specialized agents that run in isolated `pi --mode json -p --no-session` subprocesses. It also provides a live fullscreen transcript viewer for inspecting subagent runs while they stream and after the main session is resumed.

## Package installation

This repository is installable as a pi package from GitHub.

```bash
pi install git:github.com/<owner>/<repo>
```

With an explicit ref:

```bash
pi install git:github.com/<owner>/<repo>@main
pi install git:github.com/<owner>/<repo>@v0.1.0
```

For temporary testing without adding the package to settings:

```bash
pi -e git:github.com/<owner>/<repo>
```

For local development from this checkout:

```bash
pi install <project-dir>
pi --no-extensions -e <project-dir>/index.ts
```

The package manifest is in `package.json` and exposes:

```json
{
  "pi": {
    "extensions": ["./index.ts"],
    "prompts": ["./prompts"]
  }
}
```

`agents/` is not a native pi package resource type, so this extension discovers bundled agents from its own package directory at runtime. This makes GitHub installs self-contained.

## Installed location

When installed globally by pi, package files are cloned under pi's package storage. The active global development copy in this environment is:

```text
~/.pi/agent/extensions/subagent/
```

The project/repository copy is:

```text
<project-dir>/
```

## Capabilities

- Delegate tasks to named agents from `~/.pi/agent/agents/*.md`.
- Run one agent, multiple agents in parallel, or a sequential chain.
- Stream child process JSON events from each subagent.
- Preserve the existing compact/expanded `subagent` tool result display.
- Open a fullscreen live transcript overlay with `/subagents`, `Ctrl+Shift+O`, or fallback `Alt+O`.
- Configure per-subagent model selection with `/subagent-model`.
- Navigate historical subagent runs from the current main session.
- Persist completed subagent transcripts as compressed `.jsonl.gz` sidecar files.
- Rehydrate persisted subagent transcripts when the main pi session is resumed.
- Fall back to compact replay events if compressed sidecar files are missing or corrupt.

## User-facing commands and shortcuts

### `/subagents`

Open the live/historical subagent transcript viewer.

```text
/subagents
```

Open a specific run by unique short id or label prefix:

```text
/subagents d82c9a36
/subagents scout@d82c9a36
```

Runs are displayed as `agent@shortid`, similar to short Git commit hashes. The short id is derived from the final UUID segment of the full run id. If a prefix matches more than one run, the command reports an ambiguity warning.

The command is UI-only. In JSON/print mode it exits without opening an overlay because no TUI is available.

### `Ctrl+Shift+O`

Open or close the fullscreen subagent transcript viewer.

Some terminals do not distinguish `Ctrl+Shift+O` from `Ctrl+O`. Use `Alt+O` if the shortcut is not detected.

### `Alt+O`

Fallback shortcut to open or close the fullscreen subagent transcript viewer.

### `/subagent-model`

Configure which model each subagent uses.

Flow:

1. Select a subagent from the available agents list.
2. Select `inherit` or a specific available model.
3. After selecting, the command returns to the subagent list so another agent can be configured.
4. Press `Esc` from the subagent list to exit.

`inherit` is the default. It means the subagent process inherits the current parent pi model (`ctx.model`) explicitly. If no parent model is available, the child process falls back to pi's default model behavior.

Overrides are stored in:

```text
~/.pi/agent/subagent-models.json
```

Selecting `inherit` removes that agent's override from the config file.

## Live viewer keybindings

Inside the fullscreen viewer:

| Key | Action |
|-----|--------|
| `←` / `→` | Switch between all known subagent runs in the current main session |
| `↑` / `↓` | Scroll one line |
| `PageUp` / `PageDown` | Scroll one page |
| `Home` / `End` | Jump to top/bottom |
| `Ctrl+O` | Toggle expanded/collapsed tool rendering inside the viewer |
| `Esc` | Close viewer and return to main pi UI |
| `q` | Close viewer and return to main pi UI |
| `Alt+O` | Close viewer |
| `Ctrl+Shift+O` | Close viewer |

## Tool usage

The extension registers one tool:

```text
subagent
```

### Single agent

```json
{
  "agent": "scout",
  "task": "Inspect the authentication code and summarize entry points.",
  "cwd": "/path/to/project"
}
```

### Parallel agents

```json
{
  "tasks": [
    {
      "agent": "scout",
      "task": "Map frontend structure.",
      "cwd": "/path/to/project"
    },
    {
      "agent": "scout",
      "task": "Map backend/API integration structure.",
      "cwd": "/path/to/project"
    },
    {
      "agent": "scout",
      "task": "Map UX flows and usability concerns.",
      "cwd": "/path/to/project"
    }
  ]
}
```

### Chain

```json
{
  "chain": [
    {
      "agent": "scout",
      "task": "Find relevant code for: add input validation"
    },
    {
      "agent": "planner",
      "task": "Create an implementation plan using this context: {previous}"
    },
    {
      "agent": "worker",
      "task": "Implement this plan: {previous}"
    }
  ]
}
```

`{previous}` is replaced with the previous step's final assistant output.

## Prompt templates

The installed prompt templates are:

```text
/implement
/scout-and-plan
/implement-and-review
```

They live in:

```text
~/.pi/agent/prompts/
```

The extension also contains copies under:

```text
~/.pi/agent/extensions/subagent/prompts/
```

## Agent definitions

Agents are Markdown files with YAML frontmatter:

```markdown
---
name: scout
description: Fast codebase recon that returns compressed context for handoff to other agents
tools: read, grep, find, ls, bash
model: inherit
color: cyan
---

System prompt goes here.
```

Bundled package agents are loaded from the installed repository:

```text
<package-root>/agents/*.md
```

Active user-level agents are loaded from:

```text
~/.pi/agent/agents/*.md
```

User-level agents override bundled package agents with the same name.

The extension supports project-local agents from:

```text
.pi/agents/*.md
```

Project-local agents are only used when `agentScope` is set to `"project"` or `"both"`. Project-local agents override both bundled package agents and user-level agents. The extension asks for confirmation before running project-local agents in interactive mode because those prompts are repository-controlled.

### Agent colors

Agents can define a presentation-only color in frontmatter:

```yaml
color: cyan
```

The color is used in the `/subagents` live viewer and the normal `subagent` tool result. The run stores `agentColor` in its details so historical runs keep the color used at execution time.

Supported simple color names:

```text
red, green, yellow, blue, magenta, purple, cyan, orange, gray, grey, white
```

Supported pi theme color names:

```text
accent, border, borderAccent, borderMuted, success, error, warning, muted, dim, text,
thinkingText, userMessageText, customMessageText, customMessageLabel, toolTitle, toolOutput,
mdHeading, mdLink, mdLinkUrl, mdCode, mdCodeBlock, mdCodeBlockBorder, mdQuote,
mdQuoteBorder, mdHr, mdListBullet, toolDiffAdded, toolDiffRemoved, toolDiffContext,
syntaxComment, syntaxKeyword, syntaxFunction, syntaxVariable, syntaxString, syntaxNumber,
syntaxType, syntaxOperator, syntaxPunctuation, thinkingOff, thinkingMinimal, thinkingLow,
thinkingMedium, thinkingHigh, thinkingXhigh, bashMode
```

Hex truecolor is also supported:

```text
#38bdf8, #f97316, #a78bfa
```

Invalid or missing colors fall back to the active pi theme's `accent`/`toolTitle` colors.

Bundled defaults:

| Agent | Color |
|-------|-------|
| `scout` | cyan |
| `planner` | yellow |
| `reviewer` | red |
| `worker` | green |

## Execution model

Each subagent is a separate pi process:

```bash
pi --mode json -p --no-session --model <agent.model> --tools <agent.tools> --append-system-prompt <temp-agent-prompt> "Task: ..."
```

Important properties:

- The child agent has an isolated context window.
- The child agent does not create its own pi session because `--no-session` is used.
- The parent extension captures the child process stdout JSON event stream.
- The parent extension collects assistant messages, tool results, token usage, and final output.
- Abort signals propagate to child processes.

## Live transcript architecture

The live viewer is intentionally not implemented by nesting pi's `InteractiveMode`. `InteractiveMode` owns terminal IO, editor state, footer/header state, and the main session runtime, so nesting it would make two UI runtimes compete for the same terminal.

Instead, this extension replays child JSON events into public pi TUI components.

```text
child pi --mode json events
        ↓
live-registry.ts
        ↓
transcript-adapter.ts
        ↓
public pi UI components
        ↓
transcript-view.ts
        ↓
subagent-overlay.ts
```

Public pi components used:

```ts
AssistantMessageComponent
ToolExecutionComponent
UserMessageComponent
```

The implementation avoids imports from private `dist/...` package paths.

## Files

### Entry point

```text
index.ts
```

Registers:

- `subagent` tool
- `/subagents` command
- `/subagent-model` command
- `Ctrl+Shift+O` shortcut
- `Alt+O` shortcut
- session hydration/shutdown hooks
- short run labels such as `scout@d82c9a36`

Captures JSON events from child pi processes and stores run metadata.

### Agent discovery

```text
agents.ts
```

Loads bundled, user-level, and optionally project-level agent definitions, including presentation metadata such as `color:`.

### Agent colors

```text
agent-colors.ts
```

Resolves `color:` frontmatter values to ANSI/theme styling for the live viewer and tool result rendering.

### Model overrides

```text
model-overrides.ts
model-selector.ts
```

`model-overrides.ts` reads and writes `~/.pi/agent/subagent-models.json`, resolves `inherit`, and formats model references.

`model-selector.ts` implements the `/subagent-model` interactive loop.

Resolution order:

1. saved override in `~/.pi/agent/subagent-models.json`;
2. `model:` in the agent frontmatter;
3. `inherit` if no model is set.

When the resolved setting is `inherit`, the extension passes the current parent model (`provider/id`) to the child `pi` process. This gives real parent-model inheritance rather than falling back to the global default model.

### Live run registry

```text
live-registry.ts
```

Stores known subagent runs in memory, supports live subscriptions, and hydrates persisted runs from main session history.

### Transcript storage

```text
transcript-storage.ts
```

Persists completed full event streams as compressed sidecar files:

```text
~/.pi/agent/subagent-transcripts/<session-key>/<run-id>.jsonl.gz
```

Also loads and validates sidecars during session hydration.

### Transcript event types

```text
transcript-types.ts
```

Shared types for run records, storage refs, events, and replay filtering.

### Native transcript adapter

```text
transcript-adapter.ts
```

Maps child JSON events to public pi TUI components.

It handles:

- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`

### Transcript view

```text
transcript-view.ts
```

Renders one selected run using the native adapter. Falls back to plain text if native rendering fails.

### Fullscreen overlay

```text
subagent-overlay.ts
```

Fullscreen TUI overlay for `/subagents`, `Ctrl+Shift+O`, and `Alt+O`.

Handles navigation, scrolling, expand/collapse, and close behavior.

### Compatibility helpers

```text
compatibility.ts
```

Contains:

- pi version warning
- safe native rendering wrapper
- plain transcript fallback renderer

## Persistent transcript storage

### What is stored in the main session

The main session stores compact metadata in the `subagent` tool result details:

```ts
{
  runId: "...",
  replayEvents: [...],
  transcriptRef: {
    kind: "gzip-jsonl-v1",
    relativePath: "subagent-transcripts/<session-key>/<run-id>.jsonl.gz",
    sha256: "...",
    eventCount: 200,
    uncompressedBytes: 382715,
    compressedBytes: 6139,
    createdAt: 1778504917695
  }
}
```

### What is stored in the sidecar file

The sidecar contains the complete child JSON event stream as gzip-compressed JSON Lines:

```jsonl
{"type":"session", ...}
{"type":"agent_start"}
{"type":"message_start", ...}
{"type":"message_update", ...}
{"type":"tool_execution_start", ...}
{"type":"tool_execution_end", ...}
{"type":"agent_end", ...}
```

### Why sidecar storage is used

Sidecars avoid bloating the main session JSONL with high-frequency streaming events. Gzip compresses JSON event streams very effectively, and the main session only needs a small reference plus compact fallback events.

### Fallback behavior

When `/subagents` opens after a reload/resume:

1. The registry scans the main session branch for `subagent` tool results.
2. If a `transcriptRef` exists, the extension tries to load the `.jsonl.gz` sidecar.
3. The compressed file SHA-256 is verified.
4. The file is gunzipped and parsed as JSONL.
5. If loading succeeds, the full transcript is used.
6. If loading fails, compact `replayEvents` from session details are used.
7. If compact replay is unavailable, older `messages` are converted into basic replay events.

## Storage location

Sidecars are written under:

```text
~/.pi/agent/subagent-transcripts/
```

In this environment:

```text
~/.pi/agent/subagent-transcripts/
```

You can inspect sidecars with:

```bash
find ~/.pi/agent/subagent-transcripts -name '*.jsonl.gz' -type f
```

You can read one manually with:

```bash
gzip -dc ~/.pi/agent/subagent-transcripts/<session-key>/<run-id>.jsonl.gz | head
```

## Validation commands

### Check extension loads

```bash
pi --no-extensions \
  -e ~/.pi/agent/extensions/subagent/index.ts \
  --list-models
```

### Check no private imports

```bash
grep -R "pi-coding-agent/dist" \
  ~/.pi/agent/extensions/subagent \
  --include='*.ts'
```

Expected: no output.

### Smoke test subagent tool

```bash
cd ~
pi --no-extensions \
  -e ~/.pi/agent/extensions/subagent/index.ts \
  --tools subagent \
  --mode json \
  -p "Use the subagent tool with agent scout and task: list the top-level files in ~/.pi/agent/extensions/subagent and return a concise summary."
```

Expected:

- `subagent` tool is called.
- `scout` runs.
- tool result details include `runId`, `replayEvents`, and `transcriptRef`.
- a `.jsonl.gz` sidecar is created.

### Validate sidecar checksum and parsing

```bash
python3 - <<'PY'
import gzip, json, hashlib, pathlib
path = max(pathlib.Path('~/.pi/agent/subagent-transcripts').rglob('*.jsonl.gz'), key=lambda p: p.stat().st_mtime)
compressed = path.read_bytes()
print('PATH', path)
print('COMPRESSED_BYTES', len(compressed))
with gzip.open(path, 'rt', encoding='utf-8') as f:
    lines = [line for line in f if line.strip()]
print('EVENT_LINES', len(lines))
print('FIRST_EVENT', json.loads(lines[0])['type'])
print('LAST_EVENT', json.loads(lines[-1])['type'])
PY
```

## Continuable runs design

Continuing a previous subagent run is planned but not implemented yet. The design is documented in:

```text
docs/continuable-runs.md
```

Key decisions:

- new runs need real child pi session JSONL files;
- older runs created before child sessions are view-only (Option A);
- transcript continuation should use gzip segments instead of appending to one gzip file;
- `/subagent-continue <run-prefix> [instruction]` is the deterministic command;
- natural-language requests require a future `subagent_continue` tool or input alias.

## Operational workflow

After editing this extension, reload pi:

```text
/reload
```

Then test:

```text
Use scout to list files in the current directory.
```

Open the viewer:

```text
/subagents
```

Or:

```text
Ctrl+Shift+O
Alt+O
```

## Troubleshooting

### `/subagents` does nothing in JSON/print mode

Expected. The command requires an interactive UI. In JSON/print mode `ctx.hasUI` is false, so the command returns without opening an overlay.

### `Ctrl+Shift+O` does not open the viewer

Your terminal may not emit a distinct sequence for `Ctrl+Shift+O`.

Use:

```text
Alt+O
```

or:

```text
/subagents
```

### Viewer opens but custom tool output is plain text

Built-in tools render with high fidelity. Custom tools from unrelated extensions may fall back to textual output because their renderers may not be available to this extension.

### Completed runs disappear after resume

Check whether the main session contains `subagent` tool result details with `transcriptRef` or `replayEvents`.

Also check whether sidecars exist:

```bash
find ~/.pi/agent/subagent-transcripts -name '*.jsonl.gz' -type f
```

If the sidecar is missing, compact replay should still be used when available.

### Sidecar files accumulate

Sidecars are stored separately from main session files. If sessions are manually deleted, sidecars may remain.

Safe manual cleanup is possible by removing old directories under:

```text
~/.pi/agent/subagent-transcripts/
```

A future enhancement could add:

```text
/subagents cleanup
```

## Rollback

A pre-live-view backup exists at:

```text
~/.pi/agent/backups/subagent-live-view-implementation-20260511-095905/subagent.before
```

To restore that backup:

```bash
rm -rf ~/.pi/agent/extensions/subagent
cp -a ~/.pi/agent/backups/subagent-live-view-implementation-20260511-095905/subagent.before ~/.pi/agent/extensions/subagent
```

Then reload pi:

```text
/reload
```

## Known limitations

- The live viewer uses public pi UI components, not a nested `InteractiveMode`.
- Built-in tools have high-fidelity rendering; custom external tools may fall back to text.
- `Ctrl+Shift+O` may not be distinguishable in every terminal.
- Sidecar cleanup is manual for now.
- The viewer is available only in interactive TUI mode.

## Implementation manifest

The implementation manifest is stored at:

```text
~/.pi/agent/extensions/subagent/LIVE_VIEW_IMPLEMENTATION_MANIFEST.txt
```

It records changed files, validation commands, and checksums.
