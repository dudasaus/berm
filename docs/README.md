# Command Center Architecture

This document summarizes the current architecture and key components of Command Center.

## Overview

Command Center is a Bun-based web terminal application that:

- Uses tmux + zsh on the backend
- Streams terminal I/O over WebSocket
- Uses TanStack React + xterm.js + shadcn/ui on the frontend
- Organizes sessions under user-selected projects (filesystem directories)

A project maps to a real directory path, and each project can contain many terminal sessions.

## Runtime Architecture

- Server runtime: `Bun.serve()` in `src/server/index.ts`
- Frontend runtime: React app mounted from `src/web/index.html` and `src/web/main.tsx`
- Terminal backend: `TerminalSessionManager` in `src/server/terminal-session.ts`
- Registry persistence: JSON file managed by `src/server/session-registry.ts`
- Protocol contract: `src/shared/protocol.ts`

## Backend Components

### 1. HTTP + WebSocket server

File: `src/server/index.ts`

Responsibilities:

- Serves frontend app
- Exposes project/session REST APIs
- Handles WebSocket upgrades for terminal streams
- Converts manager errors into structured JSON responses

### 2. TerminalSessionManager

File: `src/server/terminal-session.ts`

Responsibilities:

- Project CRUD surface used by API layer (`listProjects`, `selectProject`, `deleteProject`)
- Project-scoped session lifecycle (`createSession`, `listSessions`, `deleteSession`)
- WebSocket client attach/detach and message handling
- tmux reconciliation and availability/error management

Notable behavior:

- Session names are unique per project
- Same session name can exist in different projects
- Internal tmux session name format: `<projectId>__<sessionId>`
- Project delete removes all of that project's sessions and kills their tmux sessions

### 3. Session registry

File: `src/server/session-registry.ts`

Stored in default path:

- `~/.command-center/sessions.json`

Current schema (version 2):

- `projects[]`
- `sessions[]` where each session references `projectId` and `tmuxSessionName`

Properties:

- Atomic writes via temp file + rename
- Auto-create file/directory if missing
- Invalid JSON backup behavior (`.bak-<timestamp>`)
- Legacy schema is cleared and rewritten as empty v2 (no migration of old sessions)

## Project Model

A project is defined by:

- Canonical absolute directory path (`realpath`)
- Deterministic ID (`proj_<sha1-prefix>`)
- Name derived from directory basename

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
- `POST /api/projects/pick` (native folder picker on macOS)
- `DELETE /api/projects/:id` (deletes project + all sessions)

### Sessions (project-scoped)

- `GET /api/projects/:projectId/sessions`
- `POST /api/projects/:projectId/sessions` with optional `{ name }`
- `GET /api/projects/:projectId/sessions/:id`
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
- Exposes project actions (pick, enter path, delete)

Left pane structure:

- **Project Management** (collapsible)
- **Session Management** (below project section)

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

This keeps ordering and selection stable while allowing independent state per project.

## tmux Integration

- tmux socket namespace defaults to `command-center`
- All tmux commands run as `tmux -L <socket> ...`
- Session creation uses selected project path as tmux cwd (`-c <project.path>`)

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

## Environment Variables

- `PORT` (default `3000`)
- `COMMAND_CENTER_TMUX_SOCKET` (optional tmux socket name override)
- `COMMAND_CENTER_REGISTRY_PATH` (optional registry file override)
