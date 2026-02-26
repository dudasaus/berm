# command-center

Web terminal app powered by Bun PTY + zsh on the backend and TanStack React + xterm.js + shadcn/ui on the frontend.

## Projects

- Sessions are scoped to a selected project directory.
- Use the `Project` control in the UI to select an existing absolute path.
- Recent projects are persisted and reusable.
- Deleting a project from the UI deletes all sessions in that project.

## Run

```bash
bun install
bun run dev
```

## Test

```bash
bun test
```
