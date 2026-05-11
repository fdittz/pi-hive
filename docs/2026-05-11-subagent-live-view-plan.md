# Subagent Live View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use a task-by-task implementation workflow. Do not implement multiple tasks at once. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live fullscreen subagent transcript view to the existing pi `subagent` extension, opened with `Ctrl+Shift+O`, fallback `Alt+O`, or `/subagents`, with left/right navigation across all subagent runs in the current/history session.

**Architecture:** Keep the implementation decoupled from private `InteractiveMode` internals. Capture the subagent JSON event stream into a run registry, persist completed full streams as gzipped JSONL sidecar files, feed events into a small transcript adapter, and render with public pi TUI components such as `AssistantMessageComponent` and `ToolExecutionComponent`. Provide a plain-text fallback if native components fail, sidecar files are missing, or pi changes component APIs.

**Tech Stack:** TypeScript pi extension loaded by jiti, Node subprocess JSON streams, `@earendil-works/pi-coding-agent` public exports, `@earendil-works/pi-tui` components/key handling.

---

## Non-negotiable constraints

1. **No private pi imports.** Import only from package roots:
   - `@earendil-works/pi-coding-agent`
   - `@earendil-works/pi-tui`
   - `@earendil-works/pi-ai` when needed for public message types
2. **Do not instantiate `InteractiveMode`.** It owns a real terminal/runtime and is not a nested view component.
3. **Keep compatibility boundaries small.** If pi changes, the likely edit surface must be limited to `compatibility.ts` and `transcript-adapter.ts`.
4. **Live and persistent history are both required.** Streaming live uses in-memory events; completed historical runs must remain inspectable after closing pi and resuming the main session.
5. **Persist full transcripts outside the session file.** Store full child JSON event streams as `.jsonl.gz` sidecar files and store only a small reference plus compact fallback in the main session tool result details.
6. **Always preserve existing subagent tool behavior.** The existing collapsed/expanded tool result renderer must keep working even if live view fails.
7. **Fallback view must always work.** If native transcript rendering throws or a gzip sidecar is missing/corrupt, show a readable plain-text transcript from compact session details.

---

## Target UX

### Entry points

- `Ctrl+Shift+O`: toggle the fullscreen live view.
- `Alt+O`: fallback toggle for terminals that do not distinguish `Ctrl+Shift+O` from `Ctrl+O`.
- `/subagents`: command to open the same view.

Optional later alias, not required for first implementation:

- `/subagents`

### Inside the view

- `←` / `→`: previous/next subagent run across all known runs.
- `↑` / `↓`: scroll one line.
- `PageUp` / `PageDown`: scroll one page.
- `Home` / `End`: jump to top/bottom.
- `Ctrl+O`: toggle expanded/collapsed tool rendering inside the live transcript.
- `Ctrl+Shift+O`, `Alt+O`, `Esc`, or `q`: close and return to the main pi UI.

### Visual layout

```text
┌─ Subagents ───────────────────────────────────────────────┐
│ 3/7  scout  running  copproxy/gpt-5.5  ctx:/project         │
│ ←/→ agent · ↑/↓ scroll · Ctrl+O expand · Esc back      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   Transcript rendered with native pi components             │
│   - assistant markdown                                      │
│   - tool execution cards                                    │
│   - edit diffs                                              │
│   - partial/live output                                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

The overlay should occupy the terminal as much as possible:

```ts
ctx.ui.custom(factory, {
  overlay: true,
  overlayOptions: {
    anchor: "center",
    width: "100%",
    maxHeight: "100%",
    margin: 0,
  },
});
```

---

## File map

### Create

- `~/.pi/agent/extensions/subagent/transcript-types.ts`
  - Shared run/event types used by registry, adapter, overlay, and persisted details.

- `~/.pi/agent/extensions/subagent/live-registry.ts`
  - In-memory registry of all subagent runs for the active pi session.
  - Subscriber model for live updates.
  - Hydration helpers for historical completed runs from session tool results.

- `~/.pi/agent/extensions/subagent/transcript-storage.ts`
  - Persists completed full JSON event streams as `.jsonl.gz` sidecar files.
  - Resolves sidecar paths from the main session file.
  - Loads and validates gzip transcripts during `/reload` or resumed sessions.

- `~/.pi/agent/extensions/subagent/transcript-adapter.ts`
  - Converts pi JSON event stream events into native TUI components.
  - Small equivalent of the relevant `InteractiveMode.handleEvent` mapping, but using public exports only.

- `~/.pi/agent/extensions/subagent/transcript-view.ts`
  - Renders one selected subagent run.
  - Supports native rendering and plain-text fallback.
  - Handles expanded/collapsed state.

- `~/.pi/agent/extensions/subagent/subagent-overlay.ts`
  - Fullscreen overlay component.
  - Keyboard handling for navigation, scrolling, close, and expansion.

- `~/.pi/agent/extensions/subagent/compatibility.ts`
  - Version guard and safe constructors for public pi components.
  - Plain fallback helpers.

### Modify

- `~/.pi/agent/extensions/subagent/index.ts`
  - Capture and record child process JSON events.
  - Add run ids to `SingleResult`.
  - Persist gzip transcript references plus compact replay fallback in tool result details.
  - Register `/subagents` command.
  - Register `ctrl+shift+o` and `alt+o` shortcuts.
  - Hydrate registry on `session_start`.
  - Clear subscribers on `session_shutdown`.

- `~/.pi/agent/extensions/subagent/README.md`
  - Document live view, shortcuts, command, limitations, and troubleshooting.

---

## Data model

### `transcript-types.ts`

Define public, extension-owned types. Keep event payloads loose enough to tolerate pi changes.

```ts
export type SubagentRunStatus = "running" | "done" | "failed" | "aborted";

export interface StoredTranscriptEvent {
  type: string;
  [key: string]: unknown;
}

export interface TranscriptStorageRef {
  kind: "gzip-jsonl-v1";
  relativePath: string;
  absolutePath?: string;
  sha256: string;
  eventCount: number;
  uncompressedBytes: number;
  compressedBytes: number;
  createdAt: number;
}

export interface SubagentRunRecord {
  id: string;
  parentToolCallId: string;
  mode: "single" | "parallel" | "chain";
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  cwd: string;
  step?: number;
  index?: number;
  model?: string;
  status: SubagentRunStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  stopReason?: string;
  errorMessage?: string;

  /** Live event stream, may contain high-frequency message_update/tool_execution_update events. */
  liveEvents: StoredTranscriptEvent[];

  /** Compact replay events safe to persist into session details as fallback. */
  replayEvents: StoredTranscriptEvent[];

  /** Full transcript sidecar reference, available after a run finishes and storage succeeds. */
  transcriptRef?: TranscriptStorageRef;

  /** Storage failure message, if full gzip persistence failed but normal tool execution continued. */
  transcriptStorageError?: string;
}
```

### Extend `SingleResult` in `index.ts`

```ts
interface SingleResult {
  runId: string;
  replayEvents: StoredTranscriptEvent[];
  transcriptRef?: TranscriptStorageRef;
  transcriptStorageError?: string;
  // existing fields remain unchanged
}
```

### Persistence policy

Use a hybrid persistence model.

#### Full transcript sidecar

Persist the full child JSON event stream after each subagent run completes as gzip-compressed JSON Lines:

```text
~/.pi/agent/subagent-transcripts/<session-key>/<run-id>.jsonl.gz
```

Each line is one raw JSON event emitted by the child `pi --mode json` process:

```jsonl
{"type":"agent_start"}
{"type":"message_update", ...}
{"type":"tool_execution_end", ...}
```

Use Node built-ins only:

```ts
import { gzip as gzipCallback, gunzip as gunzipCallback } from "node:zlib";
import { promisify } from "node:util";

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);
import { createHash } from "node:crypto";
```

Store a small reference in `SingleResult` / tool result `details`:

```ts
transcriptRef: {
  kind: "gzip-jsonl-v1",
  relativePath: "subagent-transcripts/<session-key>/<run-id>.jsonl.gz",
  sha256: "...",
  eventCount: 1234,
  uncompressedBytes: 456789,
  compressedBytes: 32100,
  createdAt: 1778490000000,
}
```

Use a session-key derived from `ctx.sessionManager.getSessionFile()` when available. For ephemeral/no-session main runs, skip sidecar persistence and keep memory-only live view.

#### Compact fallback in session details

Also persist compact replay events directly in session details so the viewer still works if the gzip file is missing/corrupt or the session is moved without sidecars.

Persist compact fallback events only:

- `message_end`
- `tool_execution_start`
- `tool_execution_end`

Do not persist aggregate lifecycle events such as `turn_end` or `agent_end` in session details because they duplicate full messages. Those events remain available in the `.jsonl.gz` sidecar.

Do not store high-frequency fallback events in session details:

- `message_update`
- `tool_execution_update`

Keep high-frequency events in memory for live streaming, and store them only in the gzip sidecar after completion.

---

## Event capture plan

### Current behavior

`runSingleAgent()` reads child process stdout line-by-line:

```ts
proc.stdout.on("data", (data) => {
  buffer += data.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) processLine(line);
});
```

`processLine()` currently parses JSON and stores final messages/usage.

### Required change

Add run registration before spawning:

```ts
const run = registry.startRun({
  parentToolCallId,
  mode,
  agent: agentName,
  agentSource: agent.source,
  task,
  cwd: cwd ?? defaultCwd,
  step,
  index,
  model: agent.model,
});
```

Record every parsed event for live view:

```ts
registry.recordEvent(run.id, event);
```

Also build compact replay events:

```ts
if (shouldPersistEvent(event)) {
  registry.recordReplayEvent(run.id, event);
}
```

At completion:

```ts
const transcriptRef = await transcriptStorage.persistRun(run);
registry.attachTranscriptRef(run.id, transcriptRef);

registry.finishRun(run.id, {
  status: wasAborted ? "aborted" : exitCode === 0 ? "done" : "failed",
  exitCode,
  stopReason: currentResult.stopReason,
  errorMessage: currentResult.errorMessage,
});
```

If JSON parse fails for a line, ignore for event replay, but keep existing stderr/output handling unchanged.

If gzip persistence fails at completion, do not fail the subagent tool. Record `transcriptStorageError` on the run/result and rely on compact replay fallback.

---

## Transcript storage plan

### `transcript-storage.ts`

Core API:

```ts
export class TranscriptStorage {
  constructor(private agentDir: string) {}

  getSessionKey(sessionFile: string | undefined, cwd: string): string | undefined;
  persistRun(run: SubagentRunRecord): Promise<TranscriptStorageRef | undefined>;
  loadTranscript(ref: TranscriptStorageRef): Promise<StoredTranscriptEvent[] | undefined>;
}
```

Path rules:

- Base directory: `${getAgentDir()}/subagent-transcripts/`.
- Session key: hash of the main session file path, plus session basename for readability.
- Run file: sanitized run id plus `.jsonl.gz`.
- Store `relativePath` in session details; resolve it relative to `getAgentDir()` on hydration.

Write rules:

- Serialize events as JSON Lines.
- Gzip the UTF-8 JSONL buffer.
- Compute SHA-256 over compressed bytes.
- Write to a `.tmp` file and atomically rename to `.jsonl.gz`.
- Never throw storage errors into the main subagent result path; return an error string for diagnostics.

Load rules:

- Resolve relative path under `getAgentDir()`.
- Read gzip file.
- Verify SHA-256 if present.
- Gunzip and parse JSONL.
- If any step fails, return `undefined` so hydration can use compact fallback.

---

## Native transcript adapter

### `transcript-adapter.ts`

This file is the only place that maps event stream semantics to native pi components.

Core fields:

```ts
class TranscriptAdapter {
  private container = new Container();
  private streamingComponent?: AssistantMessageComponent;
  private streamingMessage?: AssistantMessage;
  private pendingTools = new Map<string, ToolExecutionComponent>();

  constructor(private options: TranscriptAdapterOptions) {}

  consume(event: StoredTranscriptEvent): void;
  setExpanded(expanded: boolean): void;
  render(width: number): string[];
}
```

Options:

```ts
interface TranscriptAdapterOptions {
  tui: TUI;
  cwd: string;
  expanded: boolean;
  showImages: boolean;
  imageWidthCells: number;
  hideThinkingBlock: boolean;
  hiddenThinkingLabel: string;
}
```

Initial defaults:

```ts
showImages: true
imageWidthCells: 60
hideThinkingBlock: false
hiddenThinkingLabel: "Thinking..."
```

### Event mapping

Implement the same high-level behavior the main view uses:

```ts
case "message_start":
  if (message.role === "assistant") {
    streamingComponent = new AssistantMessageComponent(...);
    container.addChild(streamingComponent);
  }
  if (message.role === "user") {
    container.addChild(new UserMessageComponent(...));
  }
  break;

case "message_update":
  if (streamingComponent && message.role === "assistant") {
    streamingComponent.updateContent(message);
    for (const content of message.content) {
      if (content.type === "toolCall") ensureToolComponent(content);
    }
  }
  break;

case "message_end":
  if (message.role === "assistant") {
    ensureAssistantComponent();
    streamingComponent.updateContent(message);
    markPendingToolArgsComplete();
    streamingComponent = undefined;
  }
  if (message.role === "toolResult") {
    // Usually rendered through tool_execution_end. Keep as fallback only.
  }
  break;

case "tool_execution_start":
  ensureToolComponent({ id: toolCallId, name: toolName, arguments: args });
  component.markExecutionStarted();
  break;

case "tool_execution_update":
  component.updateResult({ ...partialResult, isError: false }, true);
  break;

case "tool_execution_end":
  component.updateResult({ ...result, isError });
  pendingTools.delete(toolCallId);
  break;
```

### Tool definitions

Pass `undefined` for `toolDefinition` initially:

```ts
new ToolExecutionComponent(
  toolName,
  toolCallId,
  args,
  { showImages, imageWidthCells },
  undefined,
  tui,
  cwd,
)
```

Reason: `ToolExecutionComponent` internally discovers built-in tool definitions for `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` from `cwd`. This gives native rendering for the important built-ins without importing private registries.

Limitation: custom tools from unrelated extensions may render with fallback output.

---

## Compatibility and fallback

### `compatibility.ts`

Responsibilities:

1. Import public pi version:

```ts
import { VERSION } from "@earendil-works/pi-coding-agent";
```

2. Warn on untested versions, but do not disable by default:

```ts
export function getCompatibilityWarning(): string | undefined {
  if (!VERSION.startsWith("0.74.")) {
    return `Subagent live view was built against pi 0.74.x; current pi is ${VERSION}. Falling back if native rendering fails.`;
  }
}
```

3. Safe native construction:

```ts
export function tryNative<T>(fn: () => T): T | undefined {
  try { return fn(); } catch { return undefined; }
}
```

4. Plain fallback renderer:

```ts
export function renderPlainTranscript(run: SubagentRunRecord): string[];
```

Fallback should show:

- agent name
- status
- task
- assistant text
- tool calls as `→ toolName {args}`
- tool results text
- errors/stderr if available

---

## Overlay plan

### `subagent-overlay.ts`

Implement a focusable fullscreen overlay component.

Core fields:

```ts
class SubagentOverlay implements Component {
  private selectedIndex = 0;
  private scrollOffset = 0;
  private expanded = false;
  private unsubscribe?: () => void;
  private activeAdapter?: TranscriptAdapter;

  constructor(
    private tui: TUI,
    private done: () => void,
    private registry: LiveSubagentRegistry,
  ) {}

  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  dispose(): void;
}
```

### Rendering algorithm

1. Get sorted runs:

```ts
const runs = registry.getRunsSortedByStartTime();
```

2. If empty, render:

```text
No subagent runs found in this session yet.
Esc to return.
```

3. Clamp selected index.
4. Build/rebuild adapter for selected run if run id changed or expanded changed.
5. Feed run events into adapter.
6. Render header lines.
7. Render transcript body lines.
8. Clip body using `tui.terminal.rows`:

```ts
const viewportHeight = Math.max(1, tui.terminal.rows - headerLines.length - footerLines.length);
const visibleBody = bodyLines.slice(scrollOffset, scrollOffset + viewportHeight);
```

9. Pad output to avoid stale overlay visuals if necessary.

### Keyboard handling

Use public `matchesKey` / `Key` utilities from `@earendil-works/pi-tui`.

```ts
if (matchesKey(data, Key.left)) selectPreviousRun();
if (matchesKey(data, Key.right)) selectNextRun();
if (matchesKey(data, Key.up)) scrollUp();
if (matchesKey(data, Key.down)) scrollDown();
if (matchesKey(data, "pageup")) pageUp();
if (matchesKey(data, "pagedown")) pageDown();
if (matchesKey(data, "home")) scrollTop();
if (matchesKey(data, "end")) scrollBottom();
if (matchesKey(data, "ctrl+o")) toggleExpanded();
if (matchesKey(data, "escape") || data === "q") close();
if (matchesKey(data, "ctrl+shift+o") || matchesKey(data, "alt+o")) close();
```

After each state change:

```ts
this.invalidate();
this.tui.requestRender();
```

### Live updates

Subscribe to registry updates when overlay opens:

```ts
this.unsubscribe = registry.subscribe(() => {
  this.invalidate();
  this.tui.requestRender();
});
```

On dispose:

```ts
this.unsubscribe?.();
```

---

## Registry plan

### `live-registry.ts`

Core API:

```ts
export class LiveSubagentRegistry {
  startRun(input: StartRunInput): SubagentRunRecord;
  recordEvent(runId: string, event: StoredTranscriptEvent): void;
  recordReplayEvent(runId: string, event: StoredTranscriptEvent): void;
  attachTranscriptRef(runId: string, ref: TranscriptStorageRef | undefined): void;
  finishRun(runId: string, result: FinishRunInput): void;
  getRun(runId: string): SubagentRunRecord | undefined;
  getRunsSortedByStartTime(): SubagentRunRecord[];
  hydrateFromSessionEntries(entries: readonly SessionEntry[], storage: TranscriptStorage): Promise<void>;
  subscribe(listener: () => void): () => void;
  clearVolatileSubscribers(): void;
}
```

### Run id generation

Use stable-ish ids for tool result correlation:

```ts
const runId = `${parentToolCallId}:${mode}:${index ?? step ?? 0}:${agent}:${Date.now()}`;
```

If we want stronger uniqueness, use `crypto.randomUUID()`.

### Hydration from session

On `session_start`:

```ts
await registry.hydrateFromSessionEntries(ctx.sessionManager.getBranch(), transcriptStorage);
```

Scan entries:

```ts
entry.type === "message"
entry.message.role === "toolResult"
entry.message.toolName === "subagent"
entry.message.details?.results
```

For each result:

- if `transcriptRef` exists, try loading full gzip sidecar events first.
- if sidecar load succeeds, hydrate `liveEvents` from the full transcript and keep `replayEvents` as fallback.
- if sidecar load fails but `replayEvents` exists, hydrate native replay from compact fallback.
- otherwise reconstruct fallback events from old `messages` shape.

This gives persistent history after closing/resuming pi, while preserving backward compatibility with subagent runs created before the live-view feature.

---

## Command and shortcut registration

### In `index.ts`

Add shared function:

```ts
async function openSubagentsOverlay(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  const warning = getCompatibilityWarning();
  if (warning) ctx.ui.notify(warning, "warning");

  await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
    return new SubagentOverlay(tui, () => done(undefined), registry);
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "100%",
      maxHeight: "100%",
      margin: 0,
    },
  });
}
```

Register command:

```ts
pi.registerCommand("subagents", {
  description: "Open the live/historical subagent view",
  handler: async (_args, ctx) => {
    await openSubagentsOverlay(ctx);
  },
});
```

Register shortcuts:

```ts
pi.registerShortcut("ctrl+shift+o", {
  description: "Open/close the live subagent view",
  handler: async (ctx) => {
    await openSubagentsOverlay(ctx);
  },
});

pi.registerShortcut("alt+o", {
  description: "Fallback: open/close the live subagent view",
  handler: async (ctx) => {
    await openSubagentsOverlay(ctx);
  },
});
```

### Toggle behavior

Maintain module-level overlay state:

```ts
let activeOverlayClose: (() => void) | undefined;
```

If shortcut fires while overlay is open:

```ts
activeOverlayClose?.();
return;
```

When opening overlay, set `activeOverlayClose`; clear it in `finally` after `ctx.ui.custom` resolves.

---

## Integration changes in `runSingleAgent()`

### Signature change

Add metadata parameters:

```ts
async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  runMeta: {
    parentToolCallId: string;
    mode: "single" | "parallel" | "chain";
    index?: number;
  },
): Promise<SingleResult>
```

### Use `_toolCallId`

Change tool execute signature to use the id:

```ts
async execute(toolCallId, params, signal, onUpdate, ctx) {
  // pass toolCallId into all runSingleAgent calls
}
```

### Process JSON event

Inside `processLine`:

```ts
let event: StoredTranscriptEvent;
try {
  event = JSON.parse(line);
} catch {
  return;
}

registry.recordEvent(runId, event);
if (shouldPersistEvent(event)) registry.recordReplayEvent(runId, event);

// full `liveEvents` will be gzipped to a sidecar at completion
// keep existing usage/message accumulation logic unchanged
```

### Ensure result includes replay events

Before return:

```ts
const storedRun = registry.getRun(runId);
currentResult.replayEvents = storedRun?.replayEvents ?? [];
currentResult.transcriptRef = storedRun?.transcriptRef;
currentResult.transcriptStorageError = storedRun?.transcriptStorageError;
```

---

## Testing plan

### Static/syntax smoke

Run after implementation:

```bash
pi --no-extensions -e ~/.pi/agent/extensions/subagent/index.ts --mode json -p "Reply with OK only" >/tmp/pi-subagent-ext-smoke.jsonl
```

Expected:

- process exits 0;
- no extension import errors;
- JSONL contains `agent_end`.

### Subagent tool smoke

In interactive pi after `/reload`:

```text
Use scout to list files in the current directory
```

Expected:

- `subagent` tool runs;
- existing collapsed result still works;
- `Ctrl+Shift+O` or `Alt+O` opens overlay during or after execution;
- transcript shows the scout run.

### Parallel live smoke

In interactive pi:

```text
Lance 3 scouts em paralelo no diretório <your-project-dir>: frontend, backend e UX. Não implemente nada.
```

While running:

1. Press `Ctrl+Shift+O`.
2. If not detected, press `Alt+O`.
3. Confirm overlay opens.
4. Use `←` / `→` to move between scout runs.
5. Confirm at least one run updates while streaming.
6. Press `Ctrl+O` to expand tool output.
7. Press `Esc` to return.

Expected:

- main UI is visually covered;
- no crash;
- live content appears;
- navigation works;
- returning to main UI preserves the original agent run.

### Historical smoke

After runs complete:

```text
/subagents
```

Expected:

- overlay opens;
- previous scout/worker runs appear;
- left/right cycles all known runs;
- completed transcripts render without needing live processes.

### Reload hydration smoke

After a completed subagent run:

```text
/reload
/subagents
```

Expected:

- completed runs with persisted `replayEvents` appear;
- older runs without `replayEvents` use plain reconstructed fallback.

### Gzip persistence smoke

After a completed subagent run, verify sidecar storage:

```bash
find ~/.pi/agent/subagent-transcripts -name "*.jsonl.gz" -type f | tail
```

Expected:

- at least one `.jsonl.gz` file exists for the current session;
- `transcriptRef.relativePath` appears in the subagent tool result details;
- after `/reload`, `/subagents` loads the transcript from gzip;
- if the gzip file is temporarily renamed away, `/subagents` falls back to compact replay instead of crashing.

### Shortcut fallback smoke

Test all open/close entry points:

- `Ctrl+Shift+O`
- `Alt+O`
- `/subagents`
- `Esc` inside overlay
- `q` inside overlay

Expected:

- no duplicate overlays;
- toggle closes an already-open overlay;
- shortcuts do not break `Ctrl+O` tool expansion in the main UI.

### Compatibility guard smoke

Temporarily force `getCompatibilityWarning()` to return a warning.

Expected:

- warning notification appears once when opening overlay;
- native rendering still attempts;
- fallback appears if native rendering throws.

---

## Task breakdown

### Task 1: Backup and baseline

**Files:**
- Read: `~/.pi/agent/extensions/subagent/index.ts`
- Read: `~/.pi/agent/extensions/subagent/README.md`
- Backup: `~/.pi/agent/backups/<timestamp>/subagent-before-live-view/`

- [ ] Create a timestamped backup of the extension directory.
- [ ] Verify current `subagent` tool still works before changes.
- [ ] Record current file checksums in the backup manifest.

### Task 2: Add transcript types

**Files:**
- Create: `~/.pi/agent/extensions/subagent/transcript-types.ts`

- [ ] Define `SubagentRunStatus`.
- [ ] Define `StoredTranscriptEvent`.
- [ ] Define `SubagentRunRecord`.
- [ ] Define `StartRunInput` and `FinishRunInput` helper interfaces.
- [ ] Export a type guard/helper for events with `message` fields.

### Task 3: Add live registry

**Files:**
- Create: `~/.pi/agent/extensions/subagent/live-registry.ts`

- [ ] Implement `LiveSubagentRegistry`.
- [ ] Add `startRun()`.
- [ ] Add `recordEvent()` and `recordReplayEvent()`.
- [ ] Add `attachTranscriptRef()`.
- [ ] Add `finishRun()`.
- [ ] Add `subscribe()` and notification fanout.
- [ ] Add `getRunsSortedByStartTime()`.
- [ ] Add async hydration from session branch plus gzip storage.
- [ ] Add backward-compatible reconstruction from old `SingleResult.messages`.

### Task 4: Add gzip transcript storage

**Files:**
- Create: `~/.pi/agent/extensions/subagent/transcript-storage.ts`

- [ ] Implement `TranscriptStorage`.
- [ ] Add session-key derivation from `ctx.sessionManager.getSessionFile()` / cwd.
- [ ] Add path creation under `${getAgentDir()}/subagent-transcripts/`.
- [ ] Add JSONL serialization of full event streams.
- [ ] Add gzip compression using `node:zlib` plus `node:util.promisify`.
- [ ] Add SHA-256 metadata using `node:crypto`.
- [ ] Add atomic `.tmp` write and rename.
- [ ] Add gzip loading, checksum verification, gunzip, and JSONL parsing.
- [ ] Return `undefined`/diagnostics instead of throwing into normal subagent execution.

### Task 5: Add compatibility layer

**Files:**
- Create: `~/.pi/agent/extensions/subagent/compatibility.ts`

- [ ] Import `VERSION` from package root.
- [ ] Add `getCompatibilityWarning()`.
- [ ] Add `tryNative()` helper.
- [ ] Add plain transcript formatting helpers.
- [ ] Ensure no private imports.

### Task 6: Add transcript adapter

**Files:**
- Create: `~/.pi/agent/extensions/subagent/transcript-adapter.ts`

- [ ] Import only public components from package roots.
- [ ] Implement `TranscriptAdapter` constructor.
- [ ] Implement `consume()` for message events.
- [ ] Implement `consume()` for tool execution events.
- [ ] Implement `ensureToolComponent()`.
- [ ] Implement `setExpanded()`.
- [ ] Implement `render()`.
- [ ] Wrap native component creation with `tryNative()` and fallback if needed.

### Task 7: Add transcript view wrapper

**Files:**
- Create: `~/.pi/agent/extensions/subagent/transcript-view.ts`

- [ ] Build an adapter from a `SubagentRunRecord`.
- [ ] Replay `run.liveEvents` for active/current-memory runs.
- [ ] Replay `run.replayEvents` for hydrated historical runs.
- [ ] Use plain fallback when native replay fails.
- [ ] Expose `renderRun(run, options)` or a reusable `TranscriptView` class.

### Task 8: Add fullscreen overlay

**Files:**
- Create: `~/.pi/agent/extensions/subagent/subagent-overlay.ts`

- [ ] Implement `SubagentOverlay` component.
- [ ] Add selected-run state.
- [ ] Add scroll state.
- [ ] Add expanded state.
- [ ] Add header/footer rendering.
- [ ] Add clipping based on `tui.terminal.rows`.
- [ ] Add keyboard navigation.
- [ ] Add registry subscription for live updates.
- [ ] Add `dispose()` cleanup.

### Task 9: Wire registry and capture into `index.ts`

**Files:**
- Modify: `~/.pi/agent/extensions/subagent/index.ts`

- [ ] Import registry/types.
- [ ] Create module-level `registry`.
- [ ] Extend `SingleResult` with `runId`, `replayEvents`, `transcriptRef`, and `transcriptStorageError`.
- [ ] Change `runSingleAgent()` signature to accept run metadata.
- [ ] Start registry run before spawning subprocess.
- [ ] Record each parsed JSON event.
- [ ] Persist compact replay events into session details.
- [ ] Persist full event streams as gzip sidecars at run completion.
- [ ] Attach `transcriptRef` metadata to each result.
- [ ] Finish run on success/failure/abort.
- [ ] Preserve existing `messages`, usage, partial update, and final result behavior.
- [ ] Pass parent `toolCallId` and mode/index metadata from single/parallel/chain code paths.

### Task 10: Register command and shortcuts

**Files:**
- Modify: `~/.pi/agent/extensions/subagent/index.ts`

- [ ] Implement `openSubagentsOverlay(ctx)`.
- [ ] Add active overlay toggle guard.
- [ ] Register `/subagents`.
- [ ] Register `ctrl+shift+o`.
- [ ] Register `alt+o`.
- [ ] Add no-UI behavior: return notification/text instead of throwing.

### Task 11: Hydrate history on session start

**Files:**
- Modify: `~/.pi/agent/extensions/subagent/index.ts`

- [ ] Add `session_start` handler.
- [ ] Hydrate registry from `ctx.sessionManager.getBranch()` and gzip sidecars.
- [ ] Add `session_shutdown` handler to clear subscribers/active overlay state.
- [ ] Verify `/reload` does not duplicate hydrated runs.

### Task 12: Documentation

**Files:**
- Modify: `~/.pi/agent/extensions/subagent/README.md`

- [ ] Document `/subagents`.
- [ ] Document `Ctrl+Shift+O` and `Alt+O`.
- [ ] Document terminal caveat for `Ctrl+Shift+O`.
- [ ] Document live vs persisted history behavior.
- [ ] Document `.jsonl.gz` sidecar storage location and fallback behavior.
- [ ] Document fallback behavior.
- [ ] Document known limitation for custom tools from other extensions.

### Task 13: Validation

**Files:**
- No code files unless fixes are required.

- [ ] Run static/syntax smoke.
- [ ] Run single subagent smoke.
- [ ] Run parallel live smoke.
- [ ] Run historical smoke.
- [ ] Run reload hydration smoke.
- [ ] Run gzip persistence smoke.
- [ ] Verify no private imports:

```bash
grep -R "pi-coding-agent/dist" ~/.pi/agent/extensions/subagent \
  --exclude-dir=node_modules \
  --exclude='*.md'
```

Expected: no output.

- [ ] Verify existing tool result renderer still works with `Ctrl+O` in the main UI.

---

## Risk register

### Risk: `Ctrl+Shift+O` not distinguishable in terminal

Mitigation:

- Register `Alt+O` fallback.
- Provide `/subagents` command.
- Document terminal limitation.

### Risk: pi public component constructor changes

Mitigation:

- Use package-root imports only.
- Add compatibility wrapper.
- Add plain fallback renderer.
- Keep event adapter isolated.

### Risk: session file bloat

Mitigation:

- Store full streams in gzip sidecar files, not directly in the main session JSONL.
- Store only `transcriptRef` metadata and compact fallback events in tool result details.
- Keep high-frequency `message_update` and `tool_execution_update` out of session details.

### Risk: gzip sidecar files are missing or corrupt

Mitigation:

- Verify SHA-256 on load.
- Fall back to compact replay events from session details.
- If compact replay is also unavailable, fall back to old `messages` reconstruction or plain text.

### Risk: orphaned gzip sidecar files

Mitigation:

- Store sidecars under a dedicated `subagent-transcripts/` directory so they are easy to inspect and remove.
- Keep the path derived from the main session file so ownership is clear.
- Future enhancement: add `/subagents cleanup` to remove sidecars whose main session files no longer exist.

### Risk: custom tools from other extensions do not render natively

Mitigation:

- Native rendering remains excellent for built-in tools.
- Custom tools fall back to textual cards.
- Future enhancement: expose a renderer registry from pi core or upstream `AgentTranscriptComponent`.

### Risk: overlay steals input during active agent run

Mitigation:

- Overlay is explicitly opened by shortcut/command.
- `Esc`, `Alt+O`, `Ctrl+Shift+O`, and `q` close it.
- No input is forwarded to the main editor while overlay has focus.

---

## Definition of done

- `/subagents` opens a fullscreen overlay.
- `Ctrl+Shift+O` opens/closes the overlay.
- `Alt+O` opens/closes the overlay as fallback.
- Overlay can be opened while subagents are still streaming.
- Overlay updates live as child JSON events arrive.
- `←` / `→` navigate all known subagent runs.
- Built-in tool calls render with native pi visual components.
- Edit diffs render with native coloring.
- Completed runs remain inspectable after execution.
- Persisted completed runs hydrate after `/reload` or resumed main sessions when gzip sidecars exist.
- Missing/corrupt gzip sidecars fall back to compact replay events.
- Existing subagent result rendering remains intact.
- Fallback text rendering works if native rendering fails.
- No imports from private `dist/...` paths.
