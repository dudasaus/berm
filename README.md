# command-center

Web terminal app powered by Bun PTY + zsh on the backend and TanStack React + xterm.js + shadcn/ui on the frontend.

## Projects

- Sessions are scoped to a selected project directory.
- Use the `Project` control in the UI to select an existing absolute path.
- Recent projects are persisted and reusable.
- Deleting a project from the UI deletes all sessions in that project.
- Projects can optionally enable git worktree mode.
- In worktree mode, you can create sessions either in the main project root or in a new worktree branch.
- Worktree-enabled projects can define an optional post-create hook command + timeout.
- If a hook fails, the UI shows hook stdout/stderr and lets you abort cleanup or continue session creation.
- Hook toasts include a "View output" action when stdout/stderr is present.
- Worktree sessions are persisted and cleaned up (worktree + branch) when deleted.

## Docs

- Architecture and API details: `docs/README.md`

## Run

```bash
bun install
bun run dev
```

## Compile

```bash
bun run compile
```

- Produces a standalone binary at `./command-center`.
- `compile.sh` can optionally move it to `~/.local/bin/command-center`.
- Compilation is implemented in `scripts/compile.ts` using `Bun.build()` with the `bun-plugin-tailwind` plugin so frontend CSS is bundled correctly.

## Test

```bash
bun test
```
