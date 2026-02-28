# Berm Architecture

This document summarizes the current architecture and key components of Berm.

## Overview

Berm is a Bun-based web terminal application that:

- Uses tmux + zsh on the backend
- Streams terminal I/O over WebSocket
- Uses TanStack React + xterm.js + shadcn/ui on the frontend
- Organizes sessions under user-selected projects (filesystem directories)
- Supports optional per-project git worktree session workflows

A project maps to a real directory path, and each project can contain many terminal sessions.

## Runtime Architecture

- Server runtime: `Bun.serve()` in `src/server/index.ts`
- Frontend runtime: React app mounted from `src/web/index.html` and `src/web/main.tsx`
- Terminal backend: `TerminalSessionManager` in `src/server/terminal-session.ts`
- Registry persistence: JSON file managed by `src/server/session-registry.ts`
- Protocol contract: `src/shared/protocol.ts`
- Session lifecycle contract: `src/shared/session-lifecycle.ts`

## Backend Components

### 1. HTTP + WebSocket server

File: `src/server/index.ts`

Responsibilities:

- Serves frontend app
- Exposes project/session REST APIs
- Exposes GitHub PR/CI sync API for session tiles (`gh`-powered)
- Handles WebSocket upgrades for terminal streams
- Converts manager errors into structured JSON responses

### 2. TerminalSessionManager

File: `src/server/terminal-session.ts`

Responsibilities:

- Project CRUD surface used by API layer (`listProjects`, `selectProject`, `updateProject`, `deleteProject`)
- Project-scoped session lifecycle (`createSession`, `listSessions`, `updateSessionLifecycleState`, `deleteSession`)
- WebSocket client attach/detach and message handling
- tmux reconciliation and availability/error management
- git worktree creation/removal for worktree-mode sessions

Notable behavior:

- Session names are unique per project
- Same session name can exist in different projects
- Worktree sessions use branch name as session ID
- Optional per-project post-create hook runs in the new worktree before session creation
- Hook failures pause session creation and require an explicit user decision (abort cleanup or continue)
- Internal tmux names are derived from `<projectId>__<sessionId>` with sanitization/hash for branch-style IDs
- Project delete removes all of that project's sessions and kills their tmux sessions
- Worktree session delete also removes the worktree directory and branch (non-force, safety-first)

### 3. Session registry

File: `src/server/session-registry.ts`

Stored in default path:

- `~/.command-center/sessions.json`

Current schema (version 5):

- `projects[]`
  - includes `worktreeEnabled`, `worktreeParentPath`, `worktreeHookCommand`, `worktreeHookTimeoutMs`
- `sessions[]`
  - includes `projectId`, `tmuxSessionName`, and workspace metadata:
    - `workspaceType` (`main` or `worktree`)
    - `workspacePath`
    - `branchName` (for worktree sessions)
    - `lifecycleState` (`planning`, `exploration`, `implementing`, `in_review`, `submitted_pr`, `merged`, `blocked`, `paused`)
    - `lifecycleUpdatedAt` (ISO timestamp of last lifecycle change)

Properties:

- Atomic writes via temp file + rename
- Auto-create file/directory if missing
- Invalid JSON backup behavior (`.bak-<timestamp>`)
- v2/v3/v4 registry data is loaded with defaults for new fields and then saved in v5 format

## Project Model

A project is defined by:

- Canonical absolute directory path (`realpath`)
- Deterministic ID (`proj_<sha1-prefix>`)
- Name derived from directory basename
- Worktree settings:
  - `worktreeEnabled` (manual toggle)
  - `worktreeParentPath` (absolute existing directory)
  - `worktreeHookCommand` (optional shell command run after `git worktree add`)
  - `worktreeHookTimeoutMs` (hook timeout in milliseconds; default 15000)

Validation rules for selection:

- Path must be absolute
- Path must exist
- Path must be a directory

## API Surface

### Health

- `GET /api/health`

### Projects

- `GET /api/projects`
- `POST /api/projects/select` with `{ path }`
- `PATCH /api/projects/:id` with optional `{ worktreeEnabled, worktreeParentPath, worktreeHookCommand, worktreeHookTimeoutMs }`
- `POST /api/projects/pick` (native folder picker on macOS)
- `DELETE /api/projects/:id` (deletes project + all sessions)

### Sessions (project-scoped)

- `GET /api/projects/:projectId/sessions`
- `GET /api/projects/:projectId/sessions/github-sync`
  - Uses GitHub CLI (`gh`) + local git branch resolution per session workspace
  - Returns PR metadata and CI check summary for each session when available
  - Response shape: `{ sessions: [{ sessionId, branchName, pr, ci, source, error? }], syncedAt, cached }`
- `POST /api/projects/:projectId/sessions`
  - Main session: `{ mode: "main", name? }`
  - Worktree session: `{ mode: "worktree", branchName }`
  - Success response: `{ session, hook }`
  - `hook` is `null` when no hook command runs; otherwise includes command, stdout, stderr, exit code, timeout, and success status
- `POST /api/projects/:projectId/sessions/worktree-hook-decision`
  - Resolve failed hook with `{ decisionToken, decision }`
  - `decision` is `"abort"` (cleanup worktree+branch) or `"continue"` (create tmux session anyway)
- `GET /api/projects/:projectId/sessions/:id`
- `PATCH /api/projects/:projectId/sessions/:id` with `{ lifecycleState }`
- `DELETE /api/projects/:projectId/sessions/:id`

### WebSocket

- `GET /ws/terminal?projectId=<id>&sessionId=<id>` (upgrade)

## Terminal Protocol

File: `src/shared/protocol.ts`

Client -> Server:

- `input`, `resize`, `reset`, `ping`

Server -> Client:

- `output`, `status`, `exit`, `error`, `pong`
- `session_deleted`, `session_not_found`

## Frontend Components

### 1. TerminalView

File: `src/web/components/terminal/terminal-view.tsx`

Responsibilities:

- Queries project/session APIs with React Query
- Manages selected project + selected session
- Manages per-project manual session ordering
- Renders left control pane and right terminal pane
- Supports multi-session workspace layouts (`single`, `split`, `quad`) in the terminal pane
- Supports per-slot session assignment with optional focus mode for one slot
- Supports saving/loading named workspace presets per project
- Supports cross-project pinned session board for quick switching
- Renders per-session PR/CI sync badges in session rows and workspace slot headers
- Renders workspace slot state badges (`Focused`, `Active`, `Live`) with tooltips
- Routes default session actions through the active slot session (shown in command palette header)
- Exposes project actions (pick, enter path, settings, delete)
- Uses a shared frontend action registry so commands can be invoked from both UI controls and command palette
- Exposes a global command palette (`Cmd/Ctrl+K`) with session commands first, then project commands:
  - new project
  - delete project
  - new session (auto/custom)
  - delete session
  - reconnect
  - set session lifecycle state (`planning`, `exploration`, `implementing`, `in review`, `submitted PR`, `merged`, `blocked`, `paused`)
  - toggle wide mode (full-width layout with minimal side padding)
  - hide header / show header
- Renders session lifecycle badges and "time in state" in the session list
- Supports per-session lifecycle updates from both command palette and session-row dropdown menu
- Persists header visibility preference in browser `localStorage` across sessions
- Uses a shared confirmation dialog for destructive actions (delete session/project) instead of `window.confirm`
- Includes a modal for per-project worktree settings

Action registry files:

- `src/web/components/terminal/actions.ts` (action ids, availability rules, confirmation metadata, handlers)
- `src/web/components/ui/confirm-dialog.tsx` (shared destructive/default confirmation dialog)

Left pane structure:

- **Project Management** (collapsible)
- **Session Management** (below project section)

Session creation menu behavior:

- Always offers main-session creation (auto/custom name)
- For worktree-enabled projects, also offers create in a new worktree (manual branch name)

### 2. TerminalPane

File: `src/web/components/terminal/terminal-pane.tsx`

Responsibilities:

- Owns xterm.js instance + fit addon
- Opens WebSocket per selected project/session
- Sends terminal input/resize/ping
- Receives and renders protocol messages
- Handles reconnect behavior

## Session/Project State in Browser

Stored in web storage:

- Selected project ID in `sessionStorage`
- Selected session ID per project in `sessionStorage`
- Session order per project in `localStorage`
- Header visibility in `localStorage` (`command-center.header-visible`)
- Wide mode in `localStorage` (`command-center.wide-mode`)
- Workspace layout per project in `localStorage` (`command-center.workspace-layout.<projectId>`)
- Workspace slot assignments per project in `localStorage` (`command-center.workspace-slots.<projectId>`)
- Workspace presets per project in `localStorage` (`command-center.workspace-presets.<projectId>`)
- Cross-project pinned workspace board in `localStorage` (`command-center.workspace-board`)

This keeps ordering and selection stable while allowing independent state per project.

## tmux Integration

- tmux socket namespace defaults to `command-center`
- All tmux commands run as `tmux -L <socket> ...`
- Session creation uses workspace path as tmux cwd (`-c <workspacePath>`)

Worktree mode commands:

- Create worktree session from current project HEAD:
  - `git -C <project.path> worktree add -b <branch> <worktreePath>`
- Delete worktree session resources:
  - `git -C <project.path> worktree remove <worktreePath>`
  - `git -C <project.path> branch -d <branch>`

Optional post-create hook:

- Runs as `zsh -lc "<worktreeHookCommand>"` with cwd set to the new worktree path
- Receives environment variables:
  - `COMMAND_CENTER_PROJECT_ID`
  - `COMMAND_CENTER_PROJECT_NAME`
  - `COMMAND_CENTER_PROJECT_PATH`
  - `COMMAND_CENTER_WORKTREE_BRANCH`
  - `COMMAND_CENTER_WORKTREE_PATH`
- Non-zero exit code or timeout returns `WORKTREE_HOOK_FAILED` with hook output and a `decisionToken`
- Client must call the decision endpoint to abort/cleanup or continue creating the session

## Native Folder Picker

- Endpoint: `POST /api/projects/pick`
- Uses AppleScript (`osascript`) on macOS to open folder chooser
- Returns picker-specific error codes for unsupported/cancel/failure paths
- Frontend also supports manual path entry fallback

## Testing

Server tests live in `tests/server/`:

- `protocol.test.ts`: protocol parsing/validation
- `session.integration.test.ts`: tmux/project/session lifecycle + behavior
- `http.test.ts`: response helpers and unknown-session handling

Run tests:

```bash
bun test
```

Type check:

```bash
bun run typecheck
```

## Build / Packaging

- Compile command: `bun run compile`
- Wrapper script: `compile.sh`
- Build implementation: `scripts/compile.ts`

Important detail:

- We compile via `Bun.build({ compile: true, plugins: [tailwindPlugin] })` instead of `bun build --compile ...` directly.
- Reason: current Bun CLI compile flow does not apply `[serve.static].plugins` from `bunfig.toml`, which can skip Tailwind CSS processing for standalone binaries.

Output behavior:

- Build emits a standalone binary and normalizes it to `./command-center` at repository root.
- `compile.sh` can optionally move this binary to `~/.local/bin/command-center`.

## Environment Variables

- `COMMAND_CENTER_PORT` (default `3000`)
- `COMMAND_CENTER_TMUX_SOCKET` (optional tmux socket name override)
- `COMMAND_CENTER_REGISTRY_PATH` (optional registry file override)
