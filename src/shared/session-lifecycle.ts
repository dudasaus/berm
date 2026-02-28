export const SESSION_LIFECYCLE_STATES = [
  "planning",
  "exploration",
  "implementing",
  "in_review",
  "submitted_pr",
  "merged",
  "blocked",
  "paused",
] as const;

export type SessionLifecycleState = (typeof SESSION_LIFECYCLE_STATES)[number];

export const DEFAULT_SESSION_LIFECYCLE_STATE: SessionLifecycleState = "planning";

export const SESSION_LIFECYCLE_LABELS: Record<SessionLifecycleState, string> = {
  planning: "Planning",
  exploration: "Exploration",
  implementing: "Implementing",
  in_review: "In Review",
  submitted_pr: "Submitted PR",
  merged: "Merged",
  blocked: "Blocked",
  paused: "Paused",
};

export function isSessionLifecycleState(value: unknown): value is SessionLifecycleState {
  return typeof value === "string" && (SESSION_LIFECYCLE_STATES as readonly string[]).includes(value);
}
