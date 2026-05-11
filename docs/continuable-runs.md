# Continuable Subagent Runs Design

Status: implemented for new runs. Runs created before child-session support remain view-only.

This document describes the intended design for continuing a subagent run after its original child `pi` process has exited.

## Goal

Allow a user to continue a previous subagent run by short run id, while preserving the original run's context and rendering the continuation as part of the same logical run in the `/subagents` live viewer.

Example UX:

```text
/subagent-continue scout@40f8e738 continue investigating the auth flow
/subagent-continue 40f8e738
```

Inside `/subagents`, a future enhancement may expose a `c` keybinding:

```text
c  continue selected run
```

## Compatibility decision

Use **Option A** for older runs:

> Runs created before continuable child sessions exist are view-only and cannot be truly continued.

The extension should show a clear message for such runs:

```text
Run scout@40f8e738 was created before child sessions were enabled.
It can be viewed but not continued.
```

No pseudo-continuation should be attempted by stuffing old transcript text into a new prompt. That would not be the same context and would make behavior harder to reason about.

## Why gzip transcripts are not enough

Current `.jsonl.gz` transcript sidecars are optimized for visual replay:

```text
~/.pi/agent/subagent-transcripts/<session-key>/<run-id>.jsonl.gz
```

They contain the JSON event stream emitted by `pi --mode json`, including streaming updates and tool execution events. This is excellent for UI replay, but it is not a pi session file that the child `pi` process can resume as conversation context.

To continue a run correctly, each subagent run needs its own child pi session JSONL.

## Proposed execution model

Today subagents run with:

```bash
pi --mode json -p --no-session ...
```

Continuable runs should instead run with a child session file:

```bash
pi --mode json -p \
  --session ~/.pi/agent/subagent-sessions/<main-session-key>/<run-id>.jsonl \
  --model <resolved-model> \
  --tools <agent-tools> \
  --append-system-prompt <agent-system-prompt> \
  "Task: ..."
```

When continuing the same run, spawn another child process with the same `--session` path and a continuation prompt:

```bash
pi --mode json -p \
  --session ~/.pi/agent/subagent-sessions/<main-session-key>/<run-id>.jsonl \
  --model <resolved-model> \
  --tools <agent-tools> \
  --append-system-prompt <agent-system-prompt> \
  "Continue from where you stopped. <optional instruction>"
```

The child `pi` process loads the previous child session and appends new messages to it.

## Proposed persisted metadata

Each `SingleResult` should gain a child session reference:

```ts
childSessionRef?: {
  kind: "pi-session-jsonl-v1";
  relativePath: "subagent-sessions/<main-session-key>/<run-id>.jsonl";
  createdAt: number;
}
```

A run is continuable when:

- it has `childSessionRef`;
- the child session file exists;
- the original agent definition can still be resolved or enough agent metadata was persisted to recreate the child process.

## Transcript segment storage

Do not append to the same `.jsonl.gz` file.

Although gzip can technically concatenate members, that complicates checksums, atomic writes, event counts, and corruption recovery.

Instead, store transcript segments:

```text
~/.pi/agent/subagent-transcripts/<main-session-key>/<run-id>/
  0001.jsonl.gz
  0002.jsonl.gz
  0003.jsonl.gz
```

Persist segment refs:

```ts
transcriptSegments?: Array<{
  index: number;
  relativePath: string;
  sha256: string;
  eventCount: number;
  uncompressedBytes: number;
  compressedBytes: number;
  createdAt: number;
}>;
```

The live viewer loads all segments in index order and renders them as one logical transcript.

## Command design

### `/subagent-continue`

Primary deterministic command:

```text
/subagent-continue <run-prefix> [instruction]
```

Examples:

```text
/subagent-continue 40f8e738
/subagent-continue scout@40f8e738 continue investigating the auth flow
```

Behavior:

1. Resolve `<run-prefix>` using the same prefix logic as `/subagents <prefix>`.
2. If no run matches, show a warning.
3. If multiple runs match, show an ambiguity warning.
4. If the run lacks `childSessionRef`, show the Option A view-only warning.
5. If continuable, spawn a new child `pi --mode json` process with the same child session file.
6. Stream new events into the same logical run.
7. Persist a new transcript segment when the continuation finishes.

## Natural-language continuation

Question:

```text
continue a sessao 238831282893
```

With only a slash command, this will **not** be deterministic. Slash commands are handled before normal LLM processing; a natural-language message is sent to the main model and the command is not automatically invoked.

Natural language is supported through the LLM-callable tool in addition to the slash command:

```ts
subagent_continue({ run: "238831282893", instruction?: string })
```

The tool includes prompt metadata:

```ts
promptSnippet: "Continue a previous subagent run by short run id or agent@id label"
promptGuidelines: [
  "Use subagent_continue when the user asks to continue, resume, or pick up a previous subagent run by id, short id, or agent@id label."
]
```

With this tool, a user message such as:

```text
continue a sessao 238831282893
```

can work because the main model can call `subagent_continue`.

However, it is model-mediated rather than a guaranteed command dispatch. For deterministic behavior, use:

```text
/subagent-continue 238831282893
```

### Optional deterministic input alias

A future enhancement could add an `input` event handler for exact patterns:

```text
continue session <id>
continue run <id>
continue subagent <id>
continue a sessao <id>
```

The handler could either:

- invoke the same continuation function directly; or
- transform the request into a tool-oriented prompt.

Direct invocation is more deterministic but must be implemented carefully because input handlers have a different context than command handlers.

## UI design

In `/subagents`, display continuable status:

```text
scout@40f8e738  done  continuable
reviewer@a91c2f11  done  view-only
```

Potential keybinding:

```text
c  continue selected run
```

If selected run is view-only:

```text
This run was created before child sessions were enabled and cannot be continued.
```

## Risks

### Child session storage growth

Continuable runs introduce real child pi session JSONL files in addition to transcript gzip files.

Mitigation:

- store under a dedicated directory;
- document cleanup;
- future `/subagents cleanup` command.

### Agent definition changes

If the agent prompt/tools/model changes after the run was created, continuation may not exactly match the original run.

Mitigation:

- persist resolved agent metadata at run creation time;
- use persisted metadata when continuing;
- show a warning if the current agent definition differs.

### Concurrent continuations

Continuing the same run twice at the same time could corrupt expectations or race for the child session file.

Mitigation:

- maintain a per-run continuation lock;
- reject concurrent continuation for the same run while one is active.

### Main session details updates

The parent session needs updated metadata after continuation completes.

Mitigation:

- return a normal `subagent_continue` tool result containing the updated run metadata;
- hydrate from both original `subagent` and later `subagent_continue` tool results.

## Recommended implementation phases

### Implemented

- Child session files for new runs.
- `childSessionRef` persistence.
- Older runs marked as view-only.
- `/subagent-continue` command.
- Transcript segments.
- `subagent_continue` LLM-callable tool with prompt metadata/guidelines.
- Hydration from original `subagent`, later `subagent_continue`, and custom `subagent-run-update` entries.

### Future enhancements

- Per-run continuation lock for concurrent interactive use.
- Optional `c` keybinding in `/subagents` overlay.
- Cleanup command for orphaned child sessions and transcript segments.
