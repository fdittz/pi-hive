# pi-hive Extension Documentation

This extension adds a `subagent` tool to pi. The tool delegates work to specialized agents that run in isolated `pi --mode json -p --no-session` subprocesses. Child subprocesses receive a real `handoff` tool for requesting follow-up agents without enabling nested `subagent` calls. The extension also provides a live fullscreen transcript viewer for inspecting subagent runs while they stream and after the main session is resumed.

## Package installation

This repository is installable as a pi package from GitHub.

```bash
pi install git:git@github.com:fdittz/pi-hive.git
```

With an explicit ref:

```bash
pi install git:git@github.com:fdittz/pi-hive.git@main
pi install git:git@github.com:fdittz/pi-hive.git@v0.1.0
```

For temporary testing without adding the package to settings:

```bash
pi -e git:git@github.com:fdittz/pi-hive.git
```

For local development from this checkout:

```bash
pi install /path/to/pi-hive
pi --no-extensions -e /path/to/pi-hive/index.ts
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

When installed globally by pi, package files are cloned under pi's package storage. A typical installed copy is:

```text
~/.pi/agent/extensions/pi-hive/
```

A local project/repository copy is:

```text
/path/to/pi-hive/
```

## Capabilities

- Delegate tasks to bundled package agents and user agents from `~/.pi/agent/agents/*.md`.
- Run one agent, multiple agents in parallel, or a sequential chain.
- Automatically pass previous chain-step output to later steps by injecting `{previous}` when absent.
- Prevent nested subagent process chains by withholding parent orchestration tools from child processes marked with `PI_SUBAGENT=1`.
- Let child subagents request follow-up work through a real `handoff` tool.
- Stream child process JSON events from each subagent.
- Preserve the existing compact/expanded `subagent` tool result display.
- Open a fullscreen live transcript overlay with `/subagents`, `Ctrl+Shift+O`, or fallback `Alt+O`.
- Render large overlays efficiently with viewport rendering and per-component cache invalidation.
- Configure per-subagent model and thinking selection with `/subagent-model`.
- Generate dynamic agent guidance from discovered agents using `promptSnippet`/`promptGuidelines`.
- Use agent metadata fields (`when`, `examples`, `triggers`, `triggers_en`) to improve suggestions.
- Translate and cache English trigger terms with `/subagents-lang <lang>` for non-English delegation matching.
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
3. Optionally configure an explicit thinking level.
4. After selecting, the command returns to the subagent list so another agent can be configured.
5. Press `Esc` from the subagent list to exit.

`inherit` is the default. It means the subagent process inherits the current parent pi model (`ctx.model`) and thinking level explicitly. If no parent model/thinking is available, the child process falls back to pi's default behavior. Explicit thinking choices are saved as suffixes such as `inherit:high` or `copproxy/gpt-5.5:high`.

Overrides are stored in the unified extension config:

```text
~/.pi/agent/subagent.json
```

Selecting `inherit` removes that agent's override from the config file.

### `/subagent-handoff`

Configure handoff behavior stored in:

```text
~/.pi/agent/subagent.json
```

Defaults:

```json
{
  "handoff": {
    "enabled": true,
    "mode": "auto",
    "maxDepth": 2,
    "maxHandoffsPerRun": 3,
    "requireApprovalForProjectAgents": false,
    "blockSelfHandoff": false
  }
}
```

`mode: "auto"` means handoffs execute without confirmation. `mode: "manual"` asks for confirmation when UI is available. `mode: "off"` disables handoff execution.

Child subagent processes do not receive the `subagent` or `subagent_continue` tools. If a child needs another specialized agent, it should call the `handoff` tool with `agent`, `task`, and optional `reason`. The parent process extracts those tool calls from the child assistant messages and runs allowed handoffs with the same policy below. Legacy JSON `handoff` / `handoffs` blocks in final output remain supported as a fallback.

By default, all subagents can hand off to all other subagents. Restrict a source agent with frontmatter:

```yaml
handoffAllowList: reviewer, planner
```

Supported aliases are `handoffAllowList`, `handoffAllowlist`, `handoff-allow-list`, and `allowList`.

### Chain previous-output injection

Sequential `subagent` chains pass context with a `{previous}` placeholder. By default, before execution pi-hive normalizes every chain step after the first: if the step task does not already contain a previous placeholder, it appends:

```text
Contexto do passo anterior (auto-inserido):
{previous}
```

Existing placeholders are respected case-insensitively and with optional whitespace, so `{previous}`, `{ previous }`, and `{Previous}` are all treated as explicit placeholders. Disable the behavior in `~/.pi/agent/subagent.json` when a chain's steps must remain independent:

```json
{
  "chain": {
    "autoInjectPrevious": {
      "enabled": false,
      "mode": "append-block"
    }
  }
}
```

The default is `enabled: true`; `mode` currently supports `append-block`.

### `/subagents-lang`

Translate and cache subagent trigger terms for a target language:

```text
/subagents-lang pt
/subagents-lang ja
/subagents-lang pt-BR
```

The command discovers the normal user-scope agents used by auto-delegation and the current project scope (`agentScope: "both"`), translates each agent's English trigger source once, and stores the result in:

```text
~/.pi/agent/subagents-lang.json
```

Bundled agents provide `triggers_en` so only English terms are translated. Older user/project agents without `triggers_en` fall back to `triggers`. Cache entries are keyed by language and agent source/name (for example `package:scout` or `project:worker`) and include a SHA-256 hash of the English trigger list. If the English list changes, the next command run retranslates that agent.

During delegation scoring, pi-hive applies the active language cache before matching. Each active agent receives:

```ts
triggers: [original_english, ...translated]
triggers_en: original_english
```

The command prints the resulting trigger arrays so users can verify exactly what will be matched. Japanese/Chinese trigger matching also supports substring checks for Han, Hiragana, and Katakana terms, since whitespace tokenization is insufficient for those scripts.

### Request headers

Subagent child processes can inject custom headers into provider/model requests. The default config enables:

```json
{
  "requestHeaders": {
    "enabled": true,
    "providers": ["*"],
    "headers": {
      "x-initiator": "agent"
    }
  }
}
```

The default is the literal string `agent`, not the agent name. Use `{agent}` if you want the actual subagent name.

This affects provider/model requests made by child subagent `pi` processes. It does not intercept arbitrary HTTP traffic from shell commands.

Supported templates:

```text
{agent}
{runId}
{shortRunId}
{runLabel}
{mode}
{source}
{parentToolCallId}
```

Example:

```json
{
  "requestHeaders": {
    "enabled": true,
    "providers": ["copproxy"],
    "headers": {
      "x-initiator": "{agent}",
      "x-pi-subagent-label": "{runLabel}"
    }
  }
}
```

### `/subagent-continue`

Continue a previous run by unique short id or label prefix:

```text
/subagent-continue <run-prefix> [instruction]
/subagent-continue 40f8e738
/subagent-continue scout@40f8e738 continue investigating the auth flow
```

Only runs with `childSessionRef` are continuable. Older runs created before child sessions existed are view-only.

## Live viewer keybindings

Inside the fullscreen viewer:

| Key | Action |
|-----|--------|
| `←` / `→` | Switch between all known subagent runs in the current main session |
| `↑` / `↓` | Scroll one line |
| `PageUp` / `PageDown` | Scroll one page |
| Mouse wheel | Scroll the transcript inside the overlay |
| `Home` / `End` | Jump to top/bottom |
| `Ctrl+O` | Toggle expanded/collapsed tool rendering inside the viewer |
| `Esc` | Close viewer and return to main pi UI |
| `q` | Close viewer and return to main pi UI |
| `Alt+O` | Close viewer |
| `Ctrl+Shift+O` | Close viewer |

## Tool usage

The parent process registers two orchestration tools:

```text
subagent
subagent_continue
```

Child subagent processes register `handoff` instead of those parent orchestration tools.

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

`{previous}` is replaced with the previous step's final assistant output. If a later step omits the placeholder, pi-hive appends the default previous-context block automatically unless `chain.autoInjectPrevious.enabled` is set to `false` in `~/.pi/agent/subagent.json`.

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
~/.pi/agent/extensions/pi-hive/prompts/
```

## Agent definitions

Agents are Markdown files with YAML frontmatter:

```markdown
---
name: scout
description: Fast codebase recon that returns compressed context for handoff to other agents
when: when you need to locate relevant code or gather context before planning
examples:
  - "Find where authentication sessions are created"
triggers: find, locate, inspect, trace, reconnaissance
tools: read, grep, find, ls, bash, handoff
model: inherit
thinking: inherit
color: cyan
handoffAllowList: reviewer, planner
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

Optional metadata fields drive dynamic guidance:

| Field | Meaning |
|-------|---------|
| `when` | Human-readable selection guidance |
| `examples` | Representative user requests |
| `triggers` | Keywords or phrases that should suggest the agent |

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
| `debugger` | orange |
| `worker` | green |

## Execution model

Each subagent is a separate pi process:

```bash
pi --mode json -p --no-session --model <resolved-model> --thinking <resolved-thinking> --tools <agent.tools> --append-system-prompt <temp-agent-prompt> "Task: ..."
```

Important properties:

- The child agent has an isolated context window.
- The child agent does not create its own pi session because `--no-session` is used.
- The parent extension captures the child process stdout JSON event stream.
- The parent extension collects assistant messages, tool results, token usage, and final output.
- Abort signals propagate to child processes.

## Live Transcript Architecture (Updated)

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

### Height-Indexed Virtualization

Components are indexed by their rendered height. When rendering a viewport:

1. `getLineCount(width)` measures dirty components, updates the height index, returns total
2. `renderViewport(width, offset, height)` uses index to locate the first visible component
3. Only intersecting components are fully rendered; their output is sliced to viewport bounds
4. Small components (≤50 lines) render cache per width to avoid re-render on same-width scroll
5. Large components are re-rendered on demand; `WrappedLineVirtualizer` caches wrapped lines per source line + width

### Rendered Output Memory

- `ComponentRenderCache` no longer stores full `.lines` array for rendered output
- Instead: `.height`, `.cachedSlice` (optional, for small components), `.dirty` flag
- Viewport render returns ~300 displayed lines max + overscan per call
- Internal caches may retain small component slices or wrapped source lines per width
- Full transcript events remain in memory during an active run and are persisted to the sidecar JSONL after completion

### Scroll Performance

- **Steady-state scroll** in viewport: only visible components/lines are rendered
- **First render or width change:** all components measured; O(n) cost (unavoidable for exact line count)
- **Lazy caching:** small components cached; large components rendered on-demand
- **Result:** smooth scrolling for long transcripts; first viewport calculation has O(n) cost amortized
- Very long transcripts (10k+ events, 1000+ rendered lines) scroll smoothly **within same width/state**

## Files

### Entry point

```text
index.ts
```

Registers:

- `subagent` and `subagent_continue` tools in the parent process
- `handoff` tool in child subagent processes
- `/subagents` command
- `/subagent-model` command
- `/subagent-handoff` command
- `/subagents-lang` command
- `Ctrl+Shift+O` shortcut
- `Alt+O` shortcut
- session hydration/shutdown hooks
- dynamic prompt guidance before agent start
- short run labels such as `scout@d82c9a36`

Captures JSON events from child pi processes and stores run metadata.

### Agent discovery

```text
agents.ts
```

Loads bundled, user-level, and optionally project-level agent definitions, including presentation metadata such as `color:` and selection metadata such as `when`, `examples`, `triggers`, and `triggers_en`.

### Dynamic guidance

```text
delegation-guidance.ts
```

Builds dynamic `promptSnippet`, `promptGuidelines`, and injected prompt sections from discovered agent metadata.

### Agent colors

```text
agent-colors.ts
```

Resolves `color:` frontmatter values to ANSI/theme styling for the live viewer and tool result rendering.

### Unified config, model overrides, and translated triggers

```text
subagent-config.ts
model-overrides.ts
model-selector.ts
subagents-lang.ts
pi-invocation.ts
request-headers.ts
```

`subagent-config.ts` owns the unified `~/.pi/agent/subagent.json` config file.

`model-overrides.ts` reads and writes the `models.overrides` section, resolves `inherit`, and formats model references.

`model-selector.ts` implements the `/subagent-model` interactive loop.

`request-headers.ts` applies `requestHeaders` templates inside child subagent processes.

`pi-invocation.ts` centralizes spawning the current `pi` executable or script.

`subagents-lang.ts` owns `~/.pi/agent/subagents-lang.json`, refreshes trigger translations by spawning `pi --no-extensions --mode json -p --no-session`, and applies cached `[original_english, ...translated]` trigger arrays during delegation scoring.

Resolution order when an agent is launched as a subagent:

1. saved override in `~/.pi/agent/subagent.json` (`models.overrides`), including any `:<thinking>` suffix;
2. current parent pi model/thinking;
3. child pi defaults when parent values are unavailable.

When the resolved model setting is `inherit`, the extension passes the current parent model (`provider/id`) to the child `pi` process. When no explicit `:<thinking>` override is saved, it also passes the current parent thinking level. This gives real parent inheritance rather than falling back to agent frontmatter or the global default model.

Agent frontmatter can still define standalone defaults:

```yaml
thinking: inherit
```

Supported values:

```text
inherit, off, minimal, low, medium, high, xhigh
```

For subagent launches, these frontmatter values are intentionally not used as inheritance fallbacks. Use `/subagent-model` to save an explicit override. Pi's model shorthand is also accepted in standalone frontmatter:

```yaml
model: copproxy/gpt-5.5:high
```

A thinking suffix in `model:` takes precedence over `thinking:` for standalone frontmatter defaults.

### Handoff

```text
handoff.ts
```

Extracts `handoff` tool calls from child assistant messages, supports legacy JSON handoff parsing, evaluates config and frontmatter allow lists, confirms manual handoffs, and implements `/subagent-handoff`.

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

Renders one selected run using the native adapter. It incrementally consumes transcript events, renders only the requested viewport, and falls back to plain text if native rendering fails.

### Fullscreen overlay

```text
subagent-overlay.ts
```

Fullscreen TUI overlay for `/subagents`, `Ctrl+Shift+O`, and `Alt+O`.

Handles navigation, scrolling, expand/collapse, close behavior, mouse-wheel capture, and coalesced render scheduling for high-frequency transcript updates.

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
  -e ~/.pi/agent/extensions/pi-hive/index.ts \
  --list-models
```

### Check no private imports

```bash
grep -R "pi-coding-agent/dist" \
  ~/.pi/agent/extensions/pi-hive \
  --include='*.ts'
```

Expected: no output.

### Smoke test subagent tool

```bash
cd ~
pi --no-extensions \
  -e ~/.pi/agent/extensions/pi-hive/index.ts \
  --tools subagent \
  --mode json \
  -p "Use the subagent tool with agent scout and task: list the top-level files in ~/.pi/agent/extensions/pi-hive and return a concise summary."
```

Expected:

- `subagent` tool is called.
- `scout` runs.
- tool result details include `runId`, `replayEvents`, and `transcriptRef`.
- a `.jsonl.gz` sidecar is created.

### Validate sidecar checksum and parsing

```bash
python3 - <<'PY'
import gzip, json, pathlib
root = pathlib.Path.home() / '.pi/agent/subagent-transcripts'
path = max(root.rglob('*.jsonl.gz'), key=lambda p: p.stat().st_mtime)
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

## Continuable runs

Continuing a previous subagent run is implemented for runs created after child-session support was added. Full design and storage details are documented in:

```text
docs/continuable-runs.md
```

Key decisions:

- new runs use real child pi session JSONL files under `~/.pi/agent/subagent-sessions/`;
- older runs created before child sessions are view-only (Option A);
- transcript continuation uses gzip segments (`0001.jsonl.gz`, `0002.jsonl.gz`, ...) instead of appending to one gzip file;
- `/subagent-continue <run-prefix> [instruction]` is the deterministic command;
- `subagent_continue` is an LLM-callable tool for natural-language continuation requests.

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
rm -rf ~/.pi/agent/extensions/pi-hive
cp -a <backup-path>/pi-hive.before ~/.pi/agent/extensions/pi-hive
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
~/.pi/agent/extensions/pi-hive/LIVE_VIEW_IMPLEMENTATION_MANIFEST.txt
```

It records changed files, validation commands, and checksums.
