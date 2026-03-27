# Berm

Berm helps you keep your flow: maintain speed through a line while staying in control at high velocity across multiple terminals, agents, and tasks.

Web terminal app powered by Bun PTY + zsh on the backend and TanStack React + xterm.js + shadcn/ui on the frontend.

## Projects

- Sessions are scoped to a selected project directory.
- Use the `Project` control in the UI to select an existing absolute path.
- Recent projects are persisted and reusable.
- Deleting a project from the UI deletes all sessions in that project.
- Projects can optionally enable git worktree mode.
- In worktree mode, you can create sessions either in the main project root or in a new worktree branch.
- You can manually import existing linked git worktrees via a selection dialog.
- Worktree-enabled projects can define an optional post-create hook command + timeout.
- If a hook fails, the UI shows hook stdout/stderr and lets you abort cleanup or continue session creation.
- Hook toasts include a "View output" action when stdout/stderr is present.
- Worktree sessions are persisted and cleaned up (worktree + branch) when deleted.
- Sessions have a persisted lifecycle state (`planning`, `exploration`, `implementing`, `in_review`, `submitted_pr`, `merged`, `blocked`, `paused`) that can be changed from the command palette or session list.
- The terminal area supports parallel workspace layouts (`1-up`, `2-up`, `4-up`) with per-slot session selection and optional focus mode.
- Workspace layouts and presets are saved per project in local storage.
- A cross-project workspace board lets you pin sessions from any project and jump back to them quickly.
- Workspace slot headers show `Focused` / `Active` / `Live` status with tooltips for quick context.
- Session-level actions (including command palette actions) default to the active slot session.
- The left control sidebar can be toggled with `Cmd/Ctrl+Shift+B` or from the command palette.
- Session tiles can show synced GitHub PR/CI status via `gh` (`open`/`draft`/`merged` and check summary).
- GitHub badge sync is cached and refreshed in the background, and optional activity indicators can be toggled on to surface when session refresh/GitHub sync work is running.

## Docs

- Architecture and API details: `docs/README.md`

## Run

```bash
bun install
bun run dev
```

## CLI

```bash
bunx @dudasaus/berm
```

- Starts Berm on port `3000` by default.
- Pass `--port <number>` or `-p <number>` to override the port.
- Use `--help` to print CLI usage.

## Publish

```bash
bun publish
```

The published CLI now ships prebuilt frontend assets from `dist/` so `bunx @dudasaus/berm` does not depend on the caller's local `bunfig.toml` or Tailwind plugin setup.

## Test

```bash
bun test
```
