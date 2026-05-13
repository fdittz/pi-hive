# Background Job Execution - Implementation Status

## ✅ Completed

1. **background-jobs.ts** - Job queue and persistence
   - Queue, progress tracking, completion/failure/cancellation
   - Auto-cleanup of old jobs
   - File: `~/.pi/agent/background-jobs.json`

## 🚧 TODO

### 1. Add `--background` flag support to subagent tool (`index.ts`)

In the `subagent` tool `execute` function (~line 1767):
- Parse `--background` from start of `params.task`
- If present:
  - Extract and remove flag
  - Call `queueBackgroundJob(agent, task)`
  - Spawn child process WITHOUT await
  - Return: `{ content: [{ type: "text", text: `Job queued: ${id}` }] }`
  - Attach listener to update job progress/completion

Example:
```
/subagent --background scout Find authentication code
→ Job queued (id: bg_scout_abc123_xyz)
```

### 2. Add `/subagent-jobs` command (`index.ts`)

Register command handler for:
- `/subagent-jobs` - list all running/recent
- `/subagent-jobs status` - count + summary
- `/subagent-jobs results <id>` - show result
- `/subagent-jobs cancel <id>` - cancel running job

### 3. Add visual indicator above input box

Location: TUI above input text box
Format: `⚙️  Running: scout (Find auth..., 45%), planner (Plan..., 12%)`

Implementation:
- Hook into main render loop
- Poll `getBackgroundJobs()` every 500ms
- Show only running jobs
- Use agent colors (scout=cyan, planner=yellow, etc)

Files to modify:
- TUI component registration in `index.ts`
- Add status bar component

### 4. Import and initialize in `index.ts`

```typescript
import { 
  queueBackgroundJob, 
  getBackgroundJobs, 
  updateJobProgress, 
  completeJob, 
  failJob, 
  formatRunningJobs 
} from "./background-jobs.js";

// In session_start:
await cleanupOldJobs();
```

## Architecture

```
User: /subagent --background scout Find auth
  ↓
Tool detects --background
  ↓
queueBackgroundJob("scout", "Find auth") → returns id
  ↓
Spawn child pi process (non-blocking)
  ↓
Child updates progress via updateJobProgress(id, progress)
  ↓
TUI indicator shows: "⚙️  Running: scout (Find auth..., 23%)"
  ↓
Child completes: completeJob(id, result)
  ↓
User can /subagent-jobs results <id> to see output
```

## Next Steps

1. Update index.ts to support --background
2. Add /subagent-jobs command
3. Add visual indicator component
4. Test with multiple concurrent background jobs
