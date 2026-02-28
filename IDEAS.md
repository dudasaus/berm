# Command Center Ideas

This is a high-volume feature backlog for future planning. It mixes near-term pragmatic wins with bigger bets.

## Implemented

- Session lifecycle tracking shipped:
  - Persistent session state model: `planning`, `exploration`, `implementing`, `in_review`, `submitted_pr`, `merged`, `blocked`, `paused`.
  - Manual state changes from both command palette and session-row controls.
  - UI badges and “time in state” visibility in session list/details.
  - Backend persistence + API support for lifecycle updates.

## Session lifecycle and task tracking

- Session status model: `planning`, `exploration`, `implementing`, `in_review`, `submitted_pr`, `merged`, `blocked`, `paused`.
- Automatic status inference from terminal activity (git commands, test runs, PR creation, review comments).
- Manual status override from UI and command palette.
- Per-session task card with objective, acceptance criteria, and current blockers.
- Session progress timeline with timestamped transitions.
- “Last meaningful action” indicator (last code change, last test, last commit, last PR action).
- Confidence indicator for session health (green/yellow/red) based on errors and unresolved TODOs.
- SLA timers: “stuck in exploration for 90+ minutes” alerts.
- Blocker tagging: waiting on CI, waiting on review, waiting on user decision.
- Session-level notes and scratchpad with markdown.
- Session handoff summary generator for async transfer.
- “Resume context” action that rehydrates branch, open files, and intent summary.
- Milestone checklist per session (plan, implement, test, ship).
- Session goal drift detector when commands diverge from stated objective.

## Parallel workspaces and multi-session UI

- Multi-session grid view (2-up, 4-up, custom layouts).
- Split terminal panes with linked or independent scrolling.
- Cross-project workspace board to pin active sessions regardless of project.
- Drag-and-drop reorder for visible sessions.
- Session tabs with unread output badges.
- Focus mode for one session while keeping others live in background.
- Per-pane CPU/network usage overlay to identify noisy sessions.
- Quick compare view between two sessions (branch, commit, status, PR).
- “Follow session” mode that auto-focuses the most active pane.
- Multi-monitor optimized window presets.
- Save/load custom workspace layouts.
- Session bookmarking for fast reopen.
- Open same session in multiple viewers (read-only mirror + active pane).

## tmux interoperability

- Import external tmux sessions into Command Center.
- Discover and attach to all tmux sessions on a socket.
- One-click convert imported tmux session to managed session metadata.
- Detach from app without killing tmux session.
- Re-associate orphaned tmux sessions after server restart.
- Conflict resolution when imported session name collides with existing ID.
- tmux profile support (socket, environment, default cwd).
- Read-only attachment mode for imported sessions.
- Export managed sessions back to plain tmux labels.
- Auto-detect stale/dead tmux sessions and offer cleanup.

## Artifacts and external system linking

- Session/project artifacts panel with typed links.
- Native artifact types: Linear issue, GitHub repo, GitHub PR, GitHub issue, docs page, design doc.
- Auto-create Linear issue from session context.
- Auto-create GitHub draft PR from current branch.
- PR status sync (draft/open/merged/closed) displayed in session row.
- CI check summary inline for linked PRs.
- Two-way status mapping: session state updates Linear status and vice versa.
- Artifact timeline feed mixing terminal events + external updates.
- Artifact tags and filters (critical, blocked, customer-facing).
- “Required artifacts” policy per project (e.g., must link issue + PR).
- Smart link parsing from terminal output (detect PR URLs and attach automatically).
- Multiple repos per project with default repo selection.
- Repository health widget (open PR count, flaky tests, failing default branch).

## Git and code workflow automation

- Branch naming suggestions from linked issue keys.
- Guardrails before destructive git commands with confirmation.
- Built-in stacked PR workflow helpers.
- One-click rebase/update branch from main.
- Auto-generate commit message from diff summary.
- Pre-PR checklist runner (tests, lint, typecheck, changelog).
- Auto-fix suggestions from failed checks (where deterministic).
- Conflict assistant for rebase/cherry-pick failures.
- “Ship readiness” score per session.
- Background branch freshness monitor with reminders.

## Agent autonomy and orchestration

- Session autonomy levels: manual, guided, autonomous, fully autonomous with safeguards.
- Goal-based runbooks where user defines intent and agent executes staged plan.
- Approval gates for risky actions (delete, force-push, schema changes).
- Multi-step background jobs (implement -> test -> open PR -> post summary).
- Retry policies for flaky commands/tests.
- Policy engine for command allow/deny rules by project.
- Autonomous “next best action” recommendations.
- Prompt templates for common tasks (bugfix, refactor, release prep).
- Multi-agent mode with one coordinator and several worker sessions.
- Agent performance analytics (cycle time, success rate, rollback rate).

## Review and collaboration

- Built-in code review queue by session/project.
- “Needs review” smart detection when diff grows beyond threshold.
- Review checklist templates by repo type.
- Inline review comments anchored to commits/PR links.
- Reviewer routing suggestions from CODEOWNERS and file history.
- Session pairing mode with shared terminal control.
- Comment-to-task conversion in session notes.
- Publish daily digest to Slack/Discord/email.
- Team activity map showing who is working on what.

## Reliability, safety, and recovery

- Persistent command history across sessions with search.
- Session snapshots/checkpoints (state + notes + linked artifacts).
- Crash recovery flow restoring sessions and pane layout.
- Connection quality indicator and reconnect diagnostics.
- Auto-reconnect with exponential backoff and clear state machine.
- Command execution sandbox profiles (strict/moderate/open).
- Audit log for critical actions.
- Secret redaction in terminal output and logs.
- Permission escalation workflow for sensitive commands.
- Backup/restore for session registry and metadata.

## Observability and analytics

- Per-session metrics: commands run, test pass rate, errors/hour.
- Time-in-state analytics for lifecycle statuses.
- Throughput dashboards: tasks/week, PR lead time, merge latency.
- Cost analytics if using external LLM APIs.
- “Top bottlenecks” report from historical patterns.
- Event stream export to JSON/CSV.
- Webhook support for key events (session created, PR opened, blocked).

## UX and quality-of-life

- Global fuzzy search across sessions, projects, artifacts, and commands.
- Command palette personalization based on frequency.
- Keyboard macro recording for repetitive workflows.
- Rich notifications center with snooze and mute controls.
- Contextual empty states with suggested next actions.
- Better onboarding wizard for first project/session.
- Theme presets and density settings.
- Accessibility pass for keyboard/screen reader behavior.
- Mobile/compact read-only mode for monitoring sessions on the go.
- Undo support for reversible actions.

## Project-level operations

- Project templates with predefined commands, hooks, and policies.
- Bulk operations across project sessions (pause, archive, close).
- Archiving model for old sessions/artifacts.
- Per-project environment variable profiles.
- Project health score from open blockers, stale branches, CI failures.
- Dependency update assistant per project.
- Release train view across related projects.

## Extensibility platform

- Plugin API for custom commands and panels.
- Custom artifact providers (Jira, Notion, Asana, ClickUp).
- Custom event handlers and automations via scripts/webhooks.
- Import/export command sets as versioned JSON.
- Org-wide policy packs for consistency.
- Public API for external tooling integrations.

## Candidate rollout order (suggested)

- Phase 1: session statuses, artifact links, reconnect diagnostics, import tmux sessions.
- Phase 2: multi-session grid + cross-project board + PR/CI syncing.
- Phase 3: autonomy levels + approval gates + runbook orchestration.
- Phase 4: plugin system + org policies + advanced analytics.
