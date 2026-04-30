# Windows file picker support plan

## Goal
Add Windows support for the project directory picker used by `POST /api/projects/pick`, while preserving current macOS behavior and existing API semantics.

## Current state
- Server picker implementation is in `src/server/index.ts`.
- It currently hard-fails on non-macOS platforms with `PROJECT_PICK_UNSUPPORTED`.
- Web UI calls this route from `src/web/components/terminal/terminal-view.tsx`.
- Docs currently describe the picker as macOS-only in `docs/README.md`.

## Proposed approach
1. **Refactor picker logic behind a platform-aware helper**
   - Extract `pickProjectDirectory()` into a small cross-platform module or split it into:
     - `pickProjectDirectoryMacOS()`
     - `pickProjectDirectoryWindows()`
     - optional fallback/unsupported handler
   - Keep the route contract unchanged: `{ path }` on success, `{ error, code }` on failure.

2. **Implement Windows native folder selection**
   - Use `powershell`/`pwsh` to open a native folder picker.
   - Preferred implementation: `System.Windows.Forms.FolderBrowserDialog`.
   - Return the selected absolute path as plain stdout for the Bun route to consume.
   - Handle:
     - successful selection
     - user cancel
     - PowerShell unavailable / execution failure
     - empty stdout

3. **Normalize Windows-specific error handling**
   - Map Windows outcomes to the existing API codes where possible:
     - cancel → `PROJECT_PICK_CANCELLED`
     - launch/runtime failure → `PROJECT_PICK_FAILED`
     - no path returned → `PROJECT_PICK_EMPTY`
   - Reserve `PROJECT_PICK_UNSUPPORTED` only for platforms with no implementation.

4. **Validate Windows path compatibility end-to-end**
   - Confirm `POST /api/projects/select` accepts Windows absolute paths because validation goes through `isAbsolute()` and `realpathSync()` in `src/server/terminal-session.ts`.
   - Verify no downstream code assumes POSIX separators for stored project paths or rendered UI labels.
   - Audit any path display logic if needed so Windows paths are shown correctly without normalization bugs.

5. **Add tests**
   - Extend route tests in `tests/server/index.routes.test.ts` for picker behavior by injecting a mocked picker response.
   - Add focused tests for platform-specific picker result mapping if the logic is extracted.
   - Cover:
     - Windows success
     - Windows cancel
     - Windows failure
     - unsupported platform fallback

6. **Update docs**
   - Update `docs/README.md` to state that `POST /api/projects/pick` supports macOS and Windows.
   - Document the failure codes and note that Linux/other platforms may still return unsupported unless implemented later.

## Suggested implementation details
- Keep the route using an injected `pickProjectDirectory` function so tests stay simple.
- For Windows, try `powershell` first; optionally fall back to `pwsh` if needed.
- Example direction for the Windows command:
  - load `System.Windows.Forms`
  - instantiate `FolderBrowserDialog`
  - set description/title like “Select Berm Project”
  - write selected path to stdout only on OK
  - emit a recognizable cancel signal via exit code or stderr text

## Risks / things to verify
- Windows machines without usable PowerShell GUI support.
- Behavior in non-interactive/headless sessions.
- Quoting/escaping when embedding PowerShell in `Bun.spawnSync()`.
- Whether `FolderBrowserDialog` behaves correctly under Bun-launched processes.

## Acceptance criteria
- Clicking/opening the picker on Windows returns a selected folder path and allows project selection.
- macOS behavior remains unchanged.
- Unsupported platforms still fail cleanly with `PROJECT_PICK_UNSUPPORTED`.
- Tests cover the new route behavior.
- `docs/README.md` reflects the new support matrix.
