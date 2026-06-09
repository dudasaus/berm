export const NOTIFICATION_LEVELS = ["info", "success", "warning", "error"] as const;

export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export type NotificationSource = "api" | "cli" | "system";

export type NotificationRequest = {
  level?: NotificationLevel;
  title: string;
  message?: string;
  projectId?: string;
  sessionId?: string;
  source?: NotificationSource;
};

export type BermNotification = Required<Pick<NotificationRequest, "level" | "title" | "source">> & {
  id: string;
  createdAt: string;
  message: string | null;
  projectId: string | null;
  sessionId: string | null;
};

export type NotificationPublishResult = {
  ok: true;
  notification: BermNotification;
};

export type NotificationParseResult =
  | { ok: true; value: NotificationRequest }
  | { ok: false; error: string; code: string };

const MAX_TITLE_LENGTH = 140;
const MAX_MESSAGE_LENGTH = 1_000;
const MAX_CONTEXT_LENGTH = 200;

function optionalTrimmedString(value: unknown, fieldName: string, maxLength: number): NotificationParseResult | string | undefined {
  if (typeof value === "undefined" || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    return { ok: false, error: `${fieldName} must be a string`, code: "NOTIFICATION_INVALID" };
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    return {
      ok: false,
      error: `${fieldName} must be ${maxLength} characters or fewer`,
      code: "NOTIFICATION_INVALID",
    };
  }

  return trimmed || undefined;
}

export function parseNotificationRequest(input: unknown, defaultSource: NotificationSource): NotificationParseResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Notification payload must be an object", code: "NOTIFICATION_INVALID" };
  }

  const record = input as Record<string, unknown>;
  const title = optionalTrimmedString(record.title, "title", MAX_TITLE_LENGTH);
  if (typeof title !== "string") {
    if (typeof title === "object" && title !== null && "ok" in title) {
      return title;
    }
    return { ok: false, error: "title is required", code: "NOTIFICATION_INVALID" };
  }

  const message = optionalTrimmedString(record.message, "message", MAX_MESSAGE_LENGTH);
  if (typeof message === "object" && message !== null && "ok" in message) {
    return message;
  }

  const projectId = optionalTrimmedString(record.projectId, "projectId", MAX_CONTEXT_LENGTH);
  if (typeof projectId === "object" && projectId !== null && "ok" in projectId) {
    return projectId;
  }

  const sessionId = optionalTrimmedString(record.sessionId, "sessionId", MAX_CONTEXT_LENGTH);
  if (typeof sessionId === "object" && sessionId !== null && "ok" in sessionId) {
    return sessionId;
  }

  const level = typeof record.level === "undefined" ? "info" : record.level;
  if (!NOTIFICATION_LEVELS.includes(level as NotificationLevel)) {
    return {
      ok: false,
      error: `level must be one of: ${NOTIFICATION_LEVELS.join(", ")}`,
      code: "NOTIFICATION_INVALID",
    };
  }

  const source = typeof record.source === "undefined" ? defaultSource : record.source;
  if (source !== "api" && source !== "cli" && source !== "system") {
    return {
      ok: false,
      error: "source must be one of: api, cli, system",
      code: "NOTIFICATION_INVALID",
    };
  }

  return {
    ok: true,
    value: {
      level: level as NotificationLevel,
      title,
      message,
      projectId,
      sessionId,
      source,
    },
  };
}

export function createNotification(input: NotificationRequest): BermNotification {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    level: input.level ?? "info",
    title: input.title,
    message: input.message ?? null,
    projectId: input.projectId ?? null,
    sessionId: input.sessionId ?? null,
    source: input.source ?? "api",
  };
}
