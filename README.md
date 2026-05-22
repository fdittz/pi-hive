# pi-hive

Coordinated subagent orchestration for pi with isolated context windows.

For complete local extension documentation, see [`EXTENSION.md`](./EXTENSION.md).

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes
- **Live transcript view**: Open a fullscreen overlay with `/subagents`, `Ctrl+Shift+O`, or fallback `Alt+O`
- **Overlay performance**: Viewport rendering, incremental transcript replay, and per-component render caching keep large transcripts responsive
- **Model and thinking selection**: Use `/subagent-model` to configure each subagent's model plus optional thinking level
- **Handoff tool**: Child subagents get a real `handoff` tool to request follow-up work; handoffs run automatically by default
- **Natural chains**: Sequential chains automatically pass the previous step output to later steps unless disabled in config
- **Dynamic agent guidance**: Discovered agents are summarized into `promptSnippet`/`promptGuidelines` so pi can suggest the right specialist
- **Agent metadata**: Frontmatter supports `when`, `examples`, `triggers`, and `triggers_en` for better discovery and guidance
- **Translated trigger cache**: Use `/subagents-lang <lang>` to translate English agent triggers once, cache them, and improve delegation matching for non-English requests
- **Nested subagent prevention**: Child processes cannot call `subagent` or `subagent_continue`; they use `handoff` instead
- **Debugger agent**: Bundled `debugger` diagnoses root causes and delegates fixes without editing files
- **Persistent transcripts**: Completed subagent JSON streams are saved as compressed `.jsonl.gz` sidecars and reload with the main session

## Structure

```
pi-hive/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts             # Agent discovery and metadata parsing
├── agent-colors.ts       # Frontmatter color parsing/rendering helpers
├── child-session-storage.ts # Child pi sessions for continuable runs
├── compatibility.ts      # Version guard and fallback rendering
├── delegation-guidance.ts # Dynamic promptSnippet/promptGuidelines generation
├── handoff.ts            # Handoff extraction, policy, confirmation, and config UI
├── live-registry.ts      # In-memory and hydrated run registry
├── model-overrides.ts    # Per-agent model/thinking override resolution
├── model-selector.ts     # /subagent-model interactive selector
├── pi-invocation.ts      # Shared helper for spawning the current pi executable
├── subagent-config.ts    # Unified ~/.pi/agent/subagent.json config
├── subagents-lang.ts     # Cached translated trigger config for delegation matching
├── subagent-overlay.ts   # Fullscreen live view overlay with viewport rendering
├── transcript-adapter.ts # JSON event stream -> cached native pi components
├── transcript-storage.ts # Gzipped JSONL transcript sidecar storage
├── transcript-types.ts   # Shared run/transcript types
├── transcript-view.ts    # Native/fallback transcript renderer
├── agents/               # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   ├── debugger.md      # Systematic diagnosis and delegation
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation from GitHub

This repository is a self-contained pi package. Install it from GitHub with:

```bash
pi install git:https://github.com/fdittz/pi-hive.git
```

Or with an explicit ref:

```bash
pi install git:https://github.com/fdittz/pi-hive.git@main
pi install git:https://github.com/fdittz/pi-hive.git@v0.1.0
```

For a one-off test without adding it to settings:

```bash
pi -e git:https://github.com/fdittz/pi-hive.git
```

The package manifest is in `package.json`:

```json
{
  "pi": {
    "extensions": ["./index.ts"],
    "prompts": ["./prompts"]
  }
}
```

The bundled `agents/` directory is discovered by the extension itself, so GitHub installs are self-contained. User-level agents in `~/.pi/agent/agents` override bundled package agents with the same name. Project agents override both when `agentScope` is `"both"` or `"project"`.

## Local development install

Install from this working tree:

```bash
pi install /path/to/pi-hive
```

Or test without installing:

```bash
pi --no-extensions -e /path/to/pi-hive/index.ts
```

## Local extension-only test

To test only the extension entrypoint without installing package prompts:

```bash
pi --no-extensions -e /path/to/pi-hive/index.ts
```

For normal usage, prefer `pi install /path/to/pi-hive` or GitHub installation so prompt templates are discovered too.

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

Child subagent processes are marked with `PI_SUBAGENT=1`. When the extension detects that flag inside a child process, it does not register the orchestration tools (`subagent` / `subagent_continue`) there. Instead, child agents can call the real `handoff` tool; the parent pi process extracts those tool calls after the child finishes and executes accepted follow-up agents. Legacy JSON handoff blocks remain supported as a fallback for older agent prompts.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Loads bundled package agents plus **user-level agents** from `~/.pi/agent/agents`, but excludes project-local agents.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

## Unified configuration

The extension uses one user-level config file:

```text
~/.pi/agent/subagent.json
```

Example:

```json
{
  "version": 1,
  "models": {
    "overrides": {
      "planner": "copproxy/gpt-5.5:high"
    }
  },
  "handoff": {
    "enabled": true,
    "mode": "auto",
    "maxDepth": 2,
    "maxHandoffsPerRun": 3,
    "requireApprovalForProjectAgents": false,
    "blockSelfHandoff": false
  },
  "requestHeaders": {
    "enabled": true,
    "providers": ["*"],
    "headers": {
      "x-initiator": "agent"
    }
  },
  "chain": {
    "autoInjectPrevious": {
      "enabled": true,
      "mode": "append-block"
    }
  }
}
```

### Config sections

| Section | Purpose |
|---------|---------|
| `models.overrides` | Optional per-agent model overrides used by `/subagent-model`; values may include `:<thinking>` |
| `handoff.enabled` | Master switch for handoff execution |
| `handoff.mode` | `auto`, `manual`, or `off` |
| `handoff.maxDepth` | Maximum nested handoff depth |
| `handoff.maxHandoffsPerRun` | Maximum handoffs accepted from a single run output |
| `handoff.requireApprovalForProjectAgents` | Require confirmation when target agent comes from `.pi/agents` |
| `handoff.blockSelfHandoff` | Prevent an agent from handing off to itself |
| `requestHeaders.enabled` | Enable provider/model request headers inside child subagent pi processes |
| `requestHeaders.providers` | Provider allowlist for headers; `"*"` means all providers |
| `requestHeaders.headers` | Header templates to inject into matching providers |
| `chain.autoInjectPrevious.enabled` | Automatically append a `{previous}` context block to chain steps after the first when they do not already contain one; default `true` |
| `chain.autoInjectPrevious.mode` | Injection format; currently `append-block` |

The old `~/.pi/agent/subagent-models.json` file is read as a migration fallback for model overrides, but new writes go to `subagent.json`.

Translated subagent trigger caches are intentionally stored separately in:

```text
~/.pi/agent/subagents-lang.json
```

### Subagent request headers

`requestHeaders` injects custom HTTP headers into provider/model requests made by child subagent `pi` processes. It does **not** intercept arbitrary network traffic from shell commands such as `curl`, `gh`, `npm`, or Python scripts.

Default:

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

Supported templates:

| Template | Meaning |
|----------|---------|
| `{agent}` | Agent name, e.g. `scout` |
| `{runId}` | Full run id |
| `{shortRunId}` | Short run id, e.g. `40f8e738` |
| `{runLabel}` | Label, e.g. `scout@40f8e738` |
| `{mode}` | `single`, `parallel`, or `chain` |
| `{source}` | `package`, `user`, or `project` |
| `{parentToolCallId}` | Parent `subagent` tool call id |

Example:

```json
{
  "requestHeaders": {
    "enabled": true,
    "providers": ["copproxy"],
    "headers": {
      "x-initiator": "{agent}",
      "x-pi-subagent": "true",
      "x-pi-subagent-run": "{shortRunId}",
      "x-pi-subagent-label": "{runLabel}"
    }
  }
}
```

The parent process marks child subagent launches with `PI_SUBAGENT_*` environment variables. When the extension loads inside the child process, it uses those values to register provider headers.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

For chain steps after the first, pi-hive appends a context block containing `{previous}` automatically unless the task already contains a placeholder such as `{previous}`, `{ previous }`, or `{Previous}`. Set `chain.autoInjectPrevious.enabled: false` in `~/.pi/agent/subagent.json` to keep chain tasks exactly as provided.

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

### Configure subagent models

```text
/subagent-model
```

This opens an interactive loop:

1. Select a subagent.
2. Select `inherit` or a specific available model.
3. Optionally configure an explicit thinking level (`off`, `minimal`, `low`, `medium`, `high`, or `xhigh`).
4. After saving, return to the subagent list to configure another one.
5. Press `Esc` from the subagent list to exit.

`inherit` is the default. It means the child subagent process uses the current parent pi model (`ctx.model`) and thinking level rather than hard-coded values from the agent file. Explicit thinking choices are stored as a model suffix, for example `inherit:high` or `copproxy/gpt-5.5:high`. Resolution order is saved override → parent pi model/thinking → child pi defaults. Model overrides are stored in the unified extension config:

```text
~/.pi/agent/subagent.json
```

### Translate subagent triggers

```text
/subagents-lang pt
/subagents-lang ja
```

`/subagents-lang <lang>` translates each agent's English triggers once with the current pi model, writes the cache to `~/.pi/agent/subagents-lang.json`, and enables that language for delegation matching. Cached agents use triggers in this shape:

```text
[original_english, ...translated_words]
```

Bundled agents declare `triggers_en` so translation uses only the English source terms even though their legacy multilingual `triggers` remain for backward compatibility. User and project agents without `triggers_en` fall back to their current `triggers` list as the English source. Re-running the same language reuses the cache unless an agent's English trigger list changes.

### Configure handoff behavior

```text
/subagent-handoff
```

Handoff is enabled by default and runs automatically without confirmation. Configuration is stored in:

```text
~/.pi/agent/subagent.json
```

The interactive command can change:

- `enabled` on/off;
- `mode`: `auto`, `manual`, or `off`;
- `maxDepth`;
- `maxHandoffsPerRun`;
- `requireApprovalForProjectAgents`;
- `blockSelfHandoff`.

Default handoff config:

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

Handoff modes:

| Mode | Behavior |
|------|----------|
| `auto` | Execute accepted handoffs automatically, without confirmation |
| `manual` | Ask for confirmation before executing accepted handoffs when UI is available |
| `off` | Do not execute handoffs |

A child subagent can request handoff by calling the `handoff` tool. The tool is available only inside child subagent processes; it records the request in the child transcript, then the parent executes accepted handoffs after the child finishes.

Tool parameters:

```json
{
  "agent": "reviewer",
  "task": "Review src/auth.ts for security issues.",
  "reason": "Scout found token handling code."
}
```

Multiple handoffs are supported by making multiple `handoff` tool calls. The parent extracts all valid `handoff` tool calls from assistant messages and applies the same config and allow-list policy to each request.

Legacy JSON handoff blocks in final output are still accepted as a fallback for older agents and docs. Supported fallback keys include:

```json
{ "handoff": { "agent": "reviewer", "task": "..." } }
{ "handoffs": [{ "agent": "reviewer", "task": "..." }] }
{ "delegate": { "agent": "reviewer", "task": "..." } }
{ "delegations": [{ "agent": "reviewer", "task": "..." }] }
```

By default, every subagent can hand off to every other subagent. To restrict a specific source agent, add an explicit frontmatter allow list to that agent's `.md` file:

```yaml
handoffAllowList: reviewer, planner
```

Supported aliases are:

```text
handoffAllowList
handoffAllowlist
handoff-allow-list
allowList
```

If an allow list is present, that source agent can only hand off to listed target agents. If no allow list is present, all target agents are allowed subject to the global `subagent.json` limits.

### Continue a subagent run

```text
/subagent-continue <run-prefix> [instruction]
```

Examples:

```text
/subagent-continue 40f8e738
/subagent-continue scout@40f8e738 continue investigating the auth flow
```

The extension also registers an LLM-callable tool named `subagent_continue`, so natural-language requests like `continue a sessao 40f8e738` can work when the main model chooses that tool. For deterministic behavior, use `/subagent-continue`.

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential; later steps receive prior output through `{previous}` (auto-injected by default) |

## Dynamic agent guidance

pi-hive discovers bundled agents plus user-level agents when the extension registers the `subagent` tool. It turns that discovery result into `promptSnippet` and `promptGuidelines` so the parent model can choose agents naturally instead of relying on hard-coded names.

When a conversation starts, the extension also injects a compact **Dynamic Subagent Guidance** section into the system prompt for sessions where `subagent` is selected. The section lists each available agent's source, description, `when` guidance, `triggers`, and examples. Project-local `.pi/agents` are included only when the user explicitly requests trusted project scope.

## Output Display

### Live fullscreen view

Open the subagent transcript viewer with:

```text
/subagents
/subagents <run-prefix>
Ctrl+Shift+O
Alt+O
```

`Alt+O` is provided as a fallback because some terminals do not distinguish `Ctrl+Shift+O` from `Ctrl+O`.

Runs are displayed as `agent@shortid`, similar to short Git commit hashes, for example:

```text
scout@d82c9a36
planner@a91c2f11
worker@e2b4a77c
```

The short id is derived from the final UUID segment of the full run id. You can open a specific run by unique prefix:

```text
/subagents d82c9a36
/subagents scout@d82c9a36
```

If the prefix is ambiguous or not found, pi shows a warning and does not open the viewer.

Inside the viewer:

| Key | Action |
|-----|--------|
| `←` / `→` | Switch between all known subagent runs in the current main session |
| `↑` / `↓` | Scroll one line |
| `PageUp` / `PageDown` | Scroll one page |
| Mouse wheel | Scroll the transcript inside the overlay |
| `Home` / `End` | Jump to top/bottom |
| `Ctrl+O` | Toggle expanded/collapsed tool rendering inside the viewer |
| `Esc`, `q`, `Alt+O`, `Ctrl+Shift+O` | Close the viewer |

The viewer replays the same JSON event stream emitted by child `pi --mode json` processes and renders built-in tool calls with public pi components such as `ToolExecutionComponent` and `AssistantMessageComponent`.

Large transcripts are rendered through height-indexed viewport virtualization instead of redrawing the entire history every frame. `TranscriptView` incrementally consumes new events, `TranscriptAdapter` tracks component heights and viewport slices, and the overlay coalesces live updates to avoid excessive TUI renders while a subagent is streaming.

While the viewer is open, pi-hive enables terminal mouse reporting so the mouse wheel scrolls the transcript instead of the terminal scrollback. Mouse reporting is disabled again when the viewer closes.

### Persistent transcript storage

While a subagent is running, the full JSON event stream is kept in memory for live updates. When the run completes, the extension writes the full stream as gzip-compressed JSON Lines under:

```text
~/.pi/agent/subagent-transcripts/<session-key>/<run-id>.jsonl.gz
```

The main session stores only a small `transcriptRef` plus compact fallback events in the `subagent` tool result details. When you close pi and later resume the main session, `/subagents` loads the compressed transcript sidecars. If a sidecar is missing or corrupt, the viewer falls back to compact replay events stored in the session details.

### Existing tool result view

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Performance: Transcript Virtualization

### How It Works

The subagent live view now uses **height-indexed viewport virtualization** to keep the viewport display around ~300 lines at a time.

**Before:**
- Full transcript rendered as lines in memory
- All components traversed on every viewport render
- Large transcripts caused high memory usage for **rendered output**

**After:**
- **Rendered output budget:** ~300 lines displayed on screen at one time
- **Internal caches:** small components/lines may be retained per width (implementation detail)
- **Overall memory:** grows with transcript/output size, but viewport/display is constant-bounded

### Budget

- **Rendered lines budget:** ~300 lines displayed on screen (not total transcript length)
- **Event stream:** Full transcript events remain in memory during active run (persisted to sidecar after completion)
- **Overscan:** +100 lines before/after visible viewport to reduce flicker on quick scroll
- **Internal caches:** small components/lines may be retained per width to reduce re-rendering; no fixed global cache cap is promised

### Behavior

- Within the same viewport width and state, scrolling is smooth and responsive because only visible content is rendered
- **Viewport display** is bounded (~300 lines) regardless of transcript length
- Internal render cache may grow with transcript; this trades memory for CPU (less re-render)
- Within the same viewport width and state, scroll is smooth and fast
- Changing width or scrolling after long inactivity may require re-measurement and show slight delay
- Stick-to-bottom auto-follows live streams correctly

### What's NOT Changed

- Event stream and persistence: full transcript still persisted to sidecar JSONL after run completes
- Replay and filtering: transcript contents/filtering behavior unchanged
- UI/UX: visual output identical; only rendering strategy optimized
- Fallback behavior: plain/text rendering available if native rendering fails

### Affected Paths

1. **Native adapter (transcript-adapter.ts)**: Highest ROI—most transcripts use this
2. **resultOutput**: Background jobs with large stdout
3. **Fallback plain**: Recovery path if native rendering fails

## Agent Definitions

For comprehensive agent documentation, including bundled agents, frontmatter reference, custom agent creation, workflows, best practices, and troubleshooting, see [`AGENTS.md`](./AGENTS.md).

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
when: when this agent should be selected
examples:
  - "A representative user request for this agent"
triggers: keyword, phrase, domain term
tools: read, grep, find, ls, handoff
model: inherit
thinking: inherit
color: cyan
handoffAllowList: reviewer, planner
---

System prompt for the agent goes here.
```

**Locations:**
- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

### Agent metadata

Agent frontmatter now supports optional selection metadata:

| Field | Purpose |
|-------|---------|
| `when` | Short natural-language guidance for when to use the agent |
| `examples` | YAML list or multiline list of representative requests |
| `triggers` | Comma-separated keywords/phrases that should make pi consider the agent |

This metadata is used by `delegation-guidance.ts` to build dynamic `promptSnippet`, `promptGuidelines`, and the injected guidance section for the parent model, in addition to documenting the child agent itself.

### Agent colors

Agents can define a presentation-only color in frontmatter:

```yaml
color: cyan
```

The color is used in the `/subagents` live viewer and in the normal `subagent` tool result to make agents easier to distinguish. It is also persisted in run details so historical runs keep the color they had when executed.

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

### Thinking level

Agents can define a thinking/effort level in frontmatter:

```yaml
thinking: inherit
```

Supported values:

```text
inherit, off, minimal, low, medium, high, xhigh
```

`inherit` is the default. When launched through pi-hive as a subagent, inheritance comes from the parent pi's current model/thinking (or child pi defaults when parent values are unavailable), not from agent frontmatter. Explicit subagent overrides are configured with `/subagent-model` and passed to child `pi` with `--thinking <level>`.

For standalone agent defaults, you may also use pi's model shorthand in `model:`:

```yaml
model: copproxy/gpt-5.5:high
```

An explicit suffix in `model:` takes precedence over `thinking:` for standalone frontmatter defaults.

## Sample Agents

| Agent | Purpose | Model | Thinking | Color | Tools |
|-------|---------|-------|----------|-------|-------|
| `scout` | Fast codebase recon | inherit | inherit | cyan | read, grep, find, ls, bash, handoff |
| `planner` | Implementation plans | inherit | inherit | yellow | read, grep, find, ls, handoff |
| `reviewer` | Code review | inherit | inherit | red | read, grep, find, ls, bash, handoff |
| `debugger` | Systematic bug diagnosis and delegation | inherit | inherit | orange | read, grep, find, ls, bash, handoff |
| `worker` | General-purpose | inherit | inherit | green | (all default) |

## Continuable runs

New subagent runs are continuable because each run gets a real child pi session file under:

```text
~/.pi/agent/subagent-sessions/<session-key>/<run-id>.jsonl
```

Continue a run deterministically with:

```text
/subagent-continue <run-prefix> [instruction]
```

Examples:

```text
/subagent-continue 40f8e738
/subagent-continue scout@40f8e738 continue investigating the auth flow
```

Natural-language requests such as `continue a sessao 238831282893` can work through the LLM-callable `subagent_continue` tool, but the slash command remains the deterministic path. Runs created before child sessions existed are view-only.

Full design and storage details:

```text
docs/continuable-runs.md
```

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed
- **Handoff target not found**: skipped with a warning when UI is available
- **Handoff blocked by allow list**: skipped with a warning when UI is available
- **Handoff limits reached**: skipped when `maxDepth` or `maxHandoffsPerRun` is reached

## Handoff safety notes

Handoff gives subagents a way to ask the parent orchestrator to run other subagents. It is intentionally mediated by the parent process through the `handoff` tool rather than exposing the `subagent` tool directly to child agents.

Safety controls:

- `maxDepth` prevents infinite handoff chains.
- `maxHandoffsPerRun` prevents a single output from spawning too many runs.
- `handoffAllowList` in agent frontmatter restricts which agents a source agent may call.
- `blockSelfHandoff` can disable self-handoff loops.
- `mode: manual` can require confirmation.
- `requireApprovalForProjectAgents` can require approval for repository-controlled target agents.

Default policy is intentionally permissive, as requested:

```text
enabled: true
mode: auto
all agents may hand off to all other agents unless the source agent defines handoffAllowList
```

## Limitations

- Output truncated to last 10 items in collapsed tool-result view (expand to see all)
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
- The live viewer uses public pi UI components, not a nested `InteractiveMode`; this avoids controlling the terminal twice
- Built-in tools render with high fidelity; custom tools from unrelated extensions may fall back to textual output
- `.jsonl.gz` sidecars are stored separately from session files. If sessions are deleted manually, sidecars may remain until cleaned up manually
