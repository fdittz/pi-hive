# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

For complete local extension documentation, see [`EXTENSION.md`](./EXTENSION.md).

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes
- **Live transcript view**: Open a fullscreen overlay with `/subagents`, `Ctrl+Shift+O`, or fallback `Alt+O`
- **Model selection**: Use `/subagent-model` to configure each subagent to inherit the parent model or use a specific available model
- **Persistent transcripts**: Completed subagent JSON streams are saved as compressed `.jsonl.gz` sidecars and reload with the main session

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── live-registry.ts     # In-memory and hydrated run registry
├── transcript-storage.ts # Gzipped JSONL transcript sidecar storage
├── transcript-adapter.ts # JSON event stream -> native pi components
├── transcript-view.ts   # Native/fallback transcript renderer
├── subagent-overlay.ts  # Fullscreen live view overlay
├── compatibility.ts     # Version guard and fallback rendering
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation from GitHub

This directory is a self-contained pi package. After pushing it to a GitHub repository, install it with:

```bash
pi install git:github.com/<owner>/<repo>
```

Or with an explicit ref:

```bash
pi install git:github.com/<owner>/<repo>@main
pi install git:github.com/<owner>/<repo>@v0.1.0
```

For a one-off test without adding it to settings:

```bash
pi -e git:github.com/<owner>/<repo>
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
pi install <project-dir>
```

Or test without installing:

```bash
pi --no-extensions -e <project-dir>/index.ts
```

## Legacy symlink installation

From the repository root, symlink the files:

```bash
# Symlink the extension (must be in a subdirectory with index.ts)
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts

# Symlink agents
mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# Symlink workflow prompts
mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

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
3. After saving, return to the subagent list to configure another one.
4. Press `Esc` from the subagent list to exit.

`inherit` is the default. It means the child subagent process uses the current parent pi model (`ctx.model`) rather than a hard-coded model from the agent file. Model overrides are stored in:

```text
~/.pi/agent/subagent-models.json
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

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
| `Home` / `End` | Jump to top/bottom |
| `Ctrl+O` | Toggle expanded/collapsed tool rendering inside the viewer |
| `Esc`, `q`, `Alt+O`, `Ctrl+Shift+O` | Close the viewer |

The viewer replays the same JSON event stream emitted by child `pi --mode json` processes and renders built-in tool calls with public pi components such as `ToolExecutionComponent` and `AssistantMessageComponent`.

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

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: inherit
color: cyan
---

System prompt for the agent goes here.
```

**Locations:**
- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

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

## Sample Agents

| Agent | Purpose | Model | Color | Tools |
|-------|---------|-------|-------|-------|
| `scout` | Fast codebase recon | inherit | cyan | read, grep, find, ls, bash |
| `planner` | Implementation plans | inherit | yellow | read, grep, find, ls |
| `reviewer` | Code review | inherit | red | read, grep, find, ls, bash |
| `worker` | General-purpose | inherit | green | (all default) |

## Continuable runs design

Continuing a previous subagent run is planned but not implemented yet. The design is documented in:

```text
docs/continuable-runs.md
```

Planned deterministic command:

```text
/subagent-continue <run-prefix> [instruction]
```

Natural-language requests such as `continue a sessao 238831282893` require an additional LLM-callable `subagent_continue` tool or deterministic input alias; a slash command alone is not invoked automatically from ordinary chat text.

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

## Limitations

- Output truncated to last 10 items in collapsed tool-result view (expand to see all)
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
- The live viewer uses public pi UI components, not a nested `InteractiveMode`; this avoids controlling the terminal twice
- Built-in tools render with high fidelity; custom tools from unrelated extensions may fall back to textual output
- `.jsonl.gz` sidecars are stored separately from session files. If sessions are deleted manually, sidecars may remain until cleaned up manually
