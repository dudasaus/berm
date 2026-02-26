export type TerminalStatusState = "starting" | "ready" | "reconnecting";

export type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "reset" }
  | { type: "ping"; ts: number };

export type ServerMessage =
  | { type: "output"; data: string }
  | { type: "status"; state: TerminalStatusState }
  | { type: "exit"; code: number | null; signal: string | null }
  | { type: "error"; message: string }
  | { type: "pong"; ts: number }
  | { type: "session_deleted"; sessionId: string }
  | { type: "session_not_found"; sessionId: string };

type ParseSuccess<T> = { ok: true; value: T };
type ParseFailure = { ok: false; error: string };
export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function decodeRaw(input: unknown): ParseResult<unknown> {
  if (typeof input === "string") {
    try {
      return { ok: true, value: JSON.parse(input) };
    } catch {
      return { ok: false, error: "Message is not valid JSON" };
    }
  }

  if (input instanceof ArrayBuffer || input instanceof Uint8Array) {
    const decoded = new TextDecoder().decode(input);
    try {
      return { ok: true, value: JSON.parse(decoded) };
    } catch {
      return { ok: false, error: "Binary message is not valid JSON" };
    }
  }

  if (isRecord(input)) {
    return { ok: true, value: input };
  }

  return { ok: false, error: "Unsupported message payload" };
}

function validateClientMessage(value: unknown): ParseResult<ClientMessage> {
  if (!isRecord(value) || typeof value.type !== "string") {
    return { ok: false, error: "Client message must be an object with a type" };
  }

  switch (value.type) {
    case "input":
      if (typeof value.data !== "string") {
        return { ok: false, error: "input.data must be a string" };
      }
      return { ok: true, value: { type: "input", data: value.data } };

    case "resize":
      if (typeof value.cols !== "number" || typeof value.rows !== "number") {
        return { ok: false, error: "resize requires numeric cols and rows" };
      }
      if (!Number.isFinite(value.cols) || !Number.isFinite(value.rows)) {
        return { ok: false, error: "resize cols and rows must be finite" };
      }
      return {
        ok: true,
        value: {
          type: "resize",
          cols: Math.max(20, Math.floor(value.cols)),
          rows: Math.max(8, Math.floor(value.rows)),
        },
      };

    case "reset":
      return { ok: true, value: { type: "reset" } };

    case "ping":
      if (typeof value.ts !== "number" || !Number.isFinite(value.ts)) {
        return { ok: false, error: "ping.ts must be a finite number" };
      }
      return { ok: true, value: { type: "ping", ts: value.ts } };

    default:
      return { ok: false, error: `Unknown client message type: ${value.type}` };
  }
}

function validateServerMessage(value: unknown): ParseResult<ServerMessage> {
  if (!isRecord(value) || typeof value.type !== "string") {
    return { ok: false, error: "Server message must be an object with a type" };
  }

  switch (value.type) {
    case "output":
      if (typeof value.data !== "string") {
        return { ok: false, error: "output.data must be a string" };
      }
      return { ok: true, value: { type: "output", data: value.data } };

    case "status":
      if (value.state !== "starting" && value.state !== "ready" && value.state !== "reconnecting") {
        return { ok: false, error: "status.state is invalid" };
      }
      return { ok: true, value: { type: "status", state: value.state } };

    case "exit":
      if (value.code !== null && typeof value.code !== "number") {
        return { ok: false, error: "exit.code must be null or number" };
      }
      if (value.signal !== null && typeof value.signal !== "string") {
        return { ok: false, error: "exit.signal must be null or string" };
      }
      return {
        ok: true,
        value: {
          type: "exit",
          code: value.code ?? null,
          signal: value.signal ?? null,
        },
      };

    case "error":
      if (typeof value.message !== "string") {
        return { ok: false, error: "error.message must be a string" };
      }
      return { ok: true, value: { type: "error", message: value.message } };

    case "pong":
      if (typeof value.ts !== "number" || !Number.isFinite(value.ts)) {
        return { ok: false, error: "pong.ts must be a finite number" };
      }
      return { ok: true, value: { type: "pong", ts: value.ts } };

    case "session_deleted":
      if (typeof value.sessionId !== "string") {
        return { ok: false, error: "session_deleted.sessionId must be a string" };
      }
      return { ok: true, value: { type: "session_deleted", sessionId: value.sessionId } };

    case "session_not_found":
      if (typeof value.sessionId !== "string") {
        return { ok: false, error: "session_not_found.sessionId must be a string" };
      }
      return { ok: true, value: { type: "session_not_found", sessionId: value.sessionId } };

    default:
      return { ok: false, error: `Unknown server message type: ${value.type}` };
  }
}

export function parseClientMessage(input: unknown): ParseResult<ClientMessage> {
  const decoded = decodeRaw(input);
  if (!decoded.ok) {
    return decoded;
  }
  return validateClientMessage(decoded.value);
}

export function parseServerMessage(input: unknown): ParseResult<ServerMessage> {
  const decoded = decodeRaw(input);
  if (!decoded.ok) {
    return decoded;
  }
  return validateServerMessage(decoded.value);
}

export function serializeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}
