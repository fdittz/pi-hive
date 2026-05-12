# AGENTS.md

This file provides guidance for agents and LLMs working with pi-hive agents.

---

## Agent Architecture

Pi-hive agents are specialized Markdown files with YAML frontmatter that run in isolated child `pi` processes. The extension supports three execution modes:

- **Single**: `{ agent, task }` — one agent, one task
- **Parallel**: `{ tasks: [...] }` — multiple agents run concurrently (max 8, 4 concurrent)
- **Chain**: `{ chain: [...] }` — sequential tasks with `{previous}` placeholder for prior output

Each agent runs in its own context window, so passing context between agents is explicit and intentional.

---

## Bundled Agents

| Agent | Role | Tools | Color | Use When |
|-------|------|-------|-------|----------|
| **scout** | Fast codebase reconnaissance | read, grep, find, ls, bash, handoff | cyan | Need to locate code, find patterns, understand structure |
| **planner** | Creates implementation plans | read, grep, find, ls, handoff | yellow | Have context, need step-by-step plan |
| **reviewer** | Code review & security audit | read, grep, find, ls, bash, handoff (read-only except handoff) | red | Need quality/security assessment |
| **debugger** | Systematic bug diagnosis | read, grep, find, ls, bash, handoff (read-only except handoff) | orange | Need root-cause investigation |
| **worker** | General implementation | (all default) | green | Build, fix, refactor, or execute a plan |

---

## Agent Frontmatter

```yaml
---
name: agent-name                    # Required: unique identifier
description: What it does           # Required: one-line description
when: when to use this agent        # Optional: dynamic guidance selection hint
examples:                           # Optional: representative requests
  - "Find authentication code"
triggers: find, auth, inspect       # Optional: comma-separated trigger words/phrases
tools: read, grep, find, ls, handoff # Optional: restrict available tools
model: inherit                       # Optional standalone default: inherit, model name, or name:thinking
thinking: inherit                   # Optional standalone default: off, minimal, low, medium, high, xhigh
color: cyan                         # Optional: simple names, hex (#rrggbb), or pi theme colors
handoffAllowList: reviewer, planner # Optional: comma-separated agents this can delegate to
---

System prompt goes here.
```

**Frontmatter aliases:**
- `handoffAllowList` = `handoffAllowlist` = `handoff-allow-list` = `allowList`

**Color options:**
- Simple: `red`, `green`, `yellow`, `blue`, `magenta`, `purple`, `cyan`, `orange`, `gray`, `white`
- Hex: `#38bdf8`
- Pi theme: `accent`, `success`, `error`, `warning`, `muted`, `toolTitle`, etc.

---

## How to Create an Agent

1. **Location**: User-level at `~/.pi/agent/agents/*.md`, or project-level at `.pi/agents/*.md` (requires `agentScope: "both"`)

2. **Frontmatter**: Define name, description, tools, model, thinking, color

3. **System Prompt**: Clear role, focus areas, output format

4. **Optional Handoff**: If another agent should follow, include `handoff` in `tools:` (or omit `tools:` for defaults) and call the `handoff` tool from the child process:
   ```json
   {
     "agent": "reviewer",
     "task": "Review for security issues",
     "reason": "Code handles auth tokens"
   }
   ```
   Legacy final-output JSON blocks are still parsed as a fallback, but tool calls are preferred.

5. **Test**: Invoke via `subagent` tool or inspect via `/subagents` UI

---

## Tool Restrictions

- If `tools:` is present and non-empty, child `pi` receives `--tools <list>`
- If `tools:` is omitted, child `pi` uses default tool behavior (all available)
- Recommended: restrict read-only agents to `read, grep, find, ls` plus `bash` only when read-only shell inspection is useful
- Add `handoff` to restricted agents that should be able to delegate follow-up work
- Recommended: omit `tools:` for implementation agents (worker) to allow full capabilities

---

## Model & Thinking Configuration

**Frontmatter:**
```yaml
model: inherit              # Default: use parent pi's model
model: copproxy/gpt-5.5    # Explicit model name
model: copproxy/gpt-5.5:high  # Model with thinking suffix
thinking: inherit          # Default: inherit parent's thinking
thinking: high            # Explicit: off, minimal, low, medium, high, xhigh
```

**Subagent resolution order:**
1. Config override from `/subagent-model` (saved in `~/.pi/agent/subagent.json`, optionally with `:<thinking>` suffix)
2. Parent pi's current model/thinking
3. Child pi defaults when parent values are unavailable

Agent frontmatter `model:` and `thinking:` remain useful as standalone defaults, but they are intentionally not used as subagent inheritance fallbacks.

---

## Agent Discovery

Discovery loads agents in this order (later overrides earlier):

1. **Package bundled**: `agents/*.md` (scout, planner, reviewer, debugger, worker)
2. **User-level**: `~/.pi/agent/agents/*.md`
3. **Project-local**: `.pi/agents/*.md` (only when `agentScope: "both"` or `"project"`)

**Default `agentScope`**: `"user"` (excludes project agents)

**Project agents**: Repository-controlled prompts. Require trust. Enable only in trusted repos with `agentScope: "both"`.

Dynamic prompt guidance is generated from discovered agents using `description`, `when`, `examples`, and `triggers`.

---

## Common Workflows

**Scout → Planner → Worker** (investigate, plan, implement)
```json
{
  "chain": [
    { "agent": "scout", "task": "Find authentication code" },
    { "agent": "planner", "task": "Plan OAuth migration based on {previous}" },
    { "agent": "worker", "task": "Implement plan from {previous}" }
  ]
}
```

**Scout → Planner** (investigate, plan only)
```json
{
  "chain": [
    { "agent": "scout", "task": "Find session store" },
    { "agent": "planner", "task": "Plan Redis migration from {previous}" }
  ]
}
```

**Worker → Reviewer → Worker** (implement, review, fix)
```json
{
  "chain": [
    { "agent": "worker", "task": "Add input validation to API" },
    { "agent": "reviewer", "task": "Security audit of {previous}" },
    { "agent": "worker", "task": "Fix issues from {previous}" }
  ]
}
```

**Parallel scouts** (concurrent investigation)
```json
{
  "tasks": [
    { "agent": "scout", "task": "Find all model definitions" },
    { "agent": "scout", "task": "Find all provider configs" }
  ]
}
```

---

## Handoff Rules

**Default**: Agents may hand off to any available agent unless restricted.

Child agents request handoff with the `handoff` tool. Parent orchestration tools (`subagent`, `subagent_continue`) are intentionally not registered inside child processes to prevent nested subagent chains.

**Agent-level restriction**: Add `handoffAllowList` to frontmatter:
```yaml
handoffAllowList: reviewer, planner
```
Now this agent can only delegate to those two.

**Global config** (`~/.pi/agent/subagent.json`):
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

Configure with `/subagent-handoff` command.

---

## Agent Best Practices

1. **Specialize**: Each agent should have one clear role. Don't make one agent do everything.

2. **Restrict tools appropriately**: Read-only agents get `read, grep, find, ls` plus `handoff` if they delegate. Implementation agents can omit `tools:`.

3. **Define output format**: Specify exactly what the agent should return so consumers can parse it. Include sections like "Summary", "Findings", "Recommendations".

4. **Use `inherit` for models**: Unless your agent needs specific performance, keep `model: inherit`. Allows users to control all agents at once.

5. **Assign colors consistently**: Scout=cyan, Planner=yellow, Reviewer=red, Worker=green. Makes workflows visually clear.

6. **Avoid self-handoff**: An agent should not hand off to itself unless continuation is intentional. Use `/subagent-continue` instead.

7. **Test in isolation first**: Test your agent with simple tasks before chaining it into complex workflows.

8. **Trust and project agents**: Only enable `.pi/agents/*.md` in repositories you control. Repository-controlled prompts can instruct models to run arbitrary bash.

---

## Common Issues

**Agent not found**
- Check spelling and case
- Verify location: `~/.pi/agent/agents/*.md` (user) or `.pi/agents/*.md` (project)
- Ensure `agentScope: "both"` for project agents

**Project agent not discovered**
- Verify `agentScope: "both"` or `"project"` is passed
- Check file is in `.pi/agents/` (not `pi/agents`)
- File must be `.md`

**Tool unavailable**
- Add tool to `tools:` list, or omit `tools:` entirely
- Remember `bash` is separate; include it explicitly if needed

**Handoff not executing**
- Check `handoff.enabled: true` in config
- Verify target agent exists
- Verify `handoffAllowList` includes target (if present)
- Check global limits: `maxDepth`, `maxHandoffsPerRun`

**Model override not working**
- Resolution order for subagent launches: config override → parent pi → child default
- Verify `~/.pi/agent/subagent.json` exists and is valid JSON
- Use `/subagent-model` to set overrides interactively

---

## Related Files

- **[README.md](./README.md)** — Installation, setup, commands, full configuration reference
- **[EXTENSION.md](./EXTENSION.md)** — Extension architecture, detailed API, persistence, troubleshooting
- **[agents/scout.md](./agents/scout.md)** — Scout agent definition
- **[agents/planner.md](./agents/planner.md)** — Planner agent definition
- **[agents/reviewer.md](./agents/reviewer.md)** — Reviewer agent definition
- **[agents/debugger.md](./agents/debugger.md)** — Debugger agent definition
- **[agents/worker.md](./agents/worker.md)** — Worker agent definition
