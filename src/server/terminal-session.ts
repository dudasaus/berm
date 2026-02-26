import {
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
  type TerminalStatusState,
} from "../shared/protocol";

export interface SessionClient {
  id: string;
  send: (message: ServerMessage) => void;
  close?: (code?: number, reason?: string) => void;
}

export interface SessionMetadata {
  id: string;
  state: TerminalStatusState;
  connected: boolean;
  cols: number;
  rows: number;
  pid: number | null;
  createdAt: string;
  lastActiveAt: string;
  attachedClients: number;
}

interface SessionAttachment {
  client: SessionClient;
  proc: Bun.Subprocess;
  spawnVersion: number;
}

interface TerminalSession {
  id: string;
  cols: number;
  rows: number;
  state: TerminalStatusState;
  createdAtMs: number;
  lastActiveAtMs: number;
  attachments: Map<string, SessionAttachment>;
  nextSpawnVersion: number;
}

interface TmuxSessionRef {
  id: string;
  createdAtMs: number;
}

interface TerminalSessionManagerOptions {
  defaultCols?: number;
  defaultRows?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 34;
const textDecoder = new TextDecoder();

class SessionManagerError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode = 500, code = "SESSION_ERROR") {
    super(message);
    this.name = "SessionManagerError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function isNotRunningTmuxError(stderr: string): boolean {
  const lowered = stderr.toLowerCase();
  return lowered.includes("no server running") || lowered.includes("failed to connect to server");
}

function isMissingSessionError(stderr: string): boolean {
  return loweredIncludesAny(stderr, ["can't find session", "can't find pane"]);
}

function isTmuxUnavailableError(stderr: string): boolean {
  return loweredIncludesAny(stderr, ["operation not permitted", "permission denied", "access denied"]);
}

function loweredIncludesAny(value: string, patterns: string[]): boolean {
  const lowered = value.toLowerCase();
  return patterns.some((pattern) => lowered.includes(pattern));
}

function parseSessionCreatedAt(value: string): number {
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  return Date.now();
}

function parseSessionLine(line: string): TmuxSessionRef | null {
  if (!line.trim()) {
    return null;
  }

  const [id, created] = line.split("\t");
  if (!id?.trim()) {
    return null;
  }

  return {
    id: id.trim(),
    createdAtMs: parseSessionCreatedAt(created ?? ""),
  };
}

export class TerminalSessionManager {
  private readonly options: Required<TerminalSessionManagerOptions>;
  private readonly sessions = new Map<string, TerminalSession>();
  private tmuxUnavailableReason: string | null = null;

  constructor(options: TerminalSessionManagerOptions = {}) {
    this.options = {
      defaultCols: options.defaultCols ?? DEFAULT_COLS,
      defaultRows: options.defaultRows ?? DEFAULT_ROWS,
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
    };

    this.syncSessionsFromTmux();
  }

  isTmuxAvailable(): boolean {
    return this.tmuxUnavailableReason === null;
  }

  listSessions(): SessionMetadata[] {
    this.syncSessionsFromTmux();
    if (!this.isTmuxAvailable()) {
      return [];
    }

    return [...this.sessions.values()]
      .sort((a, b) => b.lastActiveAtMs - a.lastActiveAtMs)
      .map((session) => this.toMetadata(session));
  }

  hasSession(sessionId: string): boolean {
    this.syncSessionsFromTmux();
    if (!this.isTmuxAvailable()) {
      return false;
    }

    return this.sessions.has(sessionId);
  }

  createSession(name?: string): SessionMetadata {
    this.syncSessionsFromTmux();
    this.assertTmuxAvailable();

    const targetName = name?.trim() ? name.trim() : this.nextAutoName();
    this.validateSessionName(targetName);

    if (this.sessions.has(targetName) || this.tmuxSessionExists(targetName)) {
      throw new SessionManagerError(`Session '${targetName}' already exists`, 409, "SESSION_EXISTS");
    }

    const createResult = this.runTmux(["new-session", "-d", "-s", targetName, "-c", this.options.cwd, "zsh"]);
    if (createResult.exitCode !== 0) {
      throw new SessionManagerError(
        `Failed to create tmux session '${targetName}': ${createResult.stderr || "unknown error"}`,
        500,
        "SESSION_CREATE_FAILED",
      );
    }

    const now = Date.now();
    const session: TerminalSession = {
      id: targetName,
      cols: this.options.defaultCols,
      rows: this.options.defaultRows,
      state: "ready",
      createdAtMs: now,
      lastActiveAtMs: now,
      attachments: new Map(),
      nextSpawnVersion: 1,
    };

    this.sessions.set(session.id, session);
    this.syncSessionsFromTmux();

    return this.toMetadata(this.sessions.get(session.id)!);
  }

  deleteSession(sessionId: string): boolean {
    this.syncSessionsFromTmux();
    this.assertTmuxAvailable();

    const existsLocally = this.sessions.has(sessionId);
    const existsInTmux = this.tmuxSessionExists(sessionId);
    if (!existsLocally && !existsInTmux) {
      return false;
    }

    const session = this.sessions.get(sessionId);
    if (session) {
      this.broadcastToSession(session, { type: "session_deleted", sessionId });
      this.stopAllAttachments(session, false);
      this.sessions.delete(sessionId);
    }

    const killResult = this.runTmux(["kill-session", "-t", sessionId]);
    if (killResult.exitCode !== 0 && !isMissingSessionError(killResult.stderr)) {
      throw new SessionManagerError(
        `Failed to delete tmux session '${sessionId}': ${killResult.stderr || "unknown error"}`,
        500,
        "SESSION_DELETE_FAILED",
      );
    }

    return true;
  }

  attachClient(sessionId: string, client: SessionClient): SessionMetadata | null {
    this.syncSessionsFromTmux();
    if (!this.isTmuxAvailable()) {
      this.sendToClient(client, {
        type: "error",
        message: this.tmuxUnavailableReason ?? "tmux is not available in this environment",
      });
      return null;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    this.detachClient(sessionId, client.id);

    session.lastActiveAtMs = Date.now();
    this.sendToClient(client, { type: "status", state: "starting" });
    this.spawnAttachment(session, client);

    return this.toMetadata(session);
  }

  detachClient(sessionId: string, clientId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    this.stopAttachment(session, clientId, false);
    session.lastActiveAtMs = Date.now();
  }

  handleClientMessage(sessionId: string, clientId: string, rawMessage: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const parsed = parseClientMessage(rawMessage);
    if (!parsed.ok) {
      const attachment = session.attachments.get(clientId);
      if (attachment) {
        this.sendToClient(attachment.client, { type: "error", message: parsed.error });
      }
      return;
    }

    session.lastActiveAtMs = Date.now();
    this.applyClientMessage(session, clientId, parsed.value);
  }

  getSessionMetadata(sessionId: string): SessionMetadata | null {
    this.syncSessionsFromTmux();
    if (!this.isTmuxAvailable()) {
      return null;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    return this.toMetadata(session);
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      this.stopAllAttachments(session, false);
    }
  }

  private applyClientMessage(session: TerminalSession, clientId: string, message: ClientMessage): void {
    const attachment = session.attachments.get(clientId);

    switch (message.type) {
      case "input": {
        attachment?.proc.terminal?.write(message.data);
        return;
      }

      case "resize": {
        session.cols = message.cols;
        session.rows = message.rows;
        attachment?.proc.terminal?.resize(message.cols, message.rows);
        return;
      }

      case "reset": {
        this.resetSession(session.id);
        return;
      }

      case "ping": {
        if (attachment) {
          this.sendToClient(attachment.client, { type: "pong", ts: message.ts });
        }
        return;
      }

      default: {
        const neverMessage: never = message;
        throw new Error(`Unhandled message ${(neverMessage as { type: string }).type}`);
      }
    }
  }

  private resetSession(sessionId: string): void {
    this.syncSessionsFromTmux();
    if (!this.isTmuxAvailable()) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        return;
      }
      this.broadcastToSession(session, {
        type: "error",
        message: this.tmuxUnavailableReason ?? "tmux is not available",
      });
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const clients = [...session.attachments.values()].map((attachment) => attachment.client);
    this.stopAllAttachments(session, false);

    const killResult = this.runTmux(["kill-session", "-t", sessionId]);
    if (killResult.exitCode !== 0 && !isMissingSessionError(killResult.stderr)) {
      for (const client of clients) {
        this.sendToClient(client, {
          type: "error",
          message: `Failed to reset session '${sessionId}': ${killResult.stderr || "unknown error"}`,
        });
      }
      return;
    }

    const createResult = this.runTmux(["new-session", "-d", "-s", sessionId, "-c", this.options.cwd, "zsh"]);
    if (createResult.exitCode !== 0) {
      for (const client of clients) {
        this.sendToClient(client, {
          type: "error",
          message: `Failed to recreate session '${sessionId}': ${createResult.stderr || "unknown error"}`,
        });
      }
      return;
    }

    session.state = "starting";
    session.lastActiveAtMs = Date.now();

    for (const client of clients) {
      this.sendToClient(client, { type: "status", state: "starting" });
      this.spawnAttachment(session, client);
    }
  }

  private spawnAttachment(session: TerminalSession, client: SessionClient): void {
    const spawnVersion = session.nextSpawnVersion++;

    const proc = Bun.spawn(["tmux", "attach-session", "-t", session.id], {
      cwd: this.options.cwd,
      env: this.options.env,
      terminal: {
        cols: session.cols,
        rows: session.rows,
        data: (_terminal, data) => {
          const activeSession = this.sessions.get(session.id);
          if (!activeSession) {
            return;
          }

          const activeAttachment = activeSession.attachments.get(client.id);
          if (!activeAttachment || activeAttachment.spawnVersion !== spawnVersion) {
            return;
          }

          activeSession.lastActiveAtMs = Date.now();
          this.sendToClient(client, {
            type: "output",
            data: typeof data === "string" ? data : textDecoder.decode(data),
          });
        },
      },
    });

    session.attachments.set(client.id, { client, proc, spawnVersion });
    session.state = "ready";
    this.sendToClient(client, { type: "status", state: "ready" });

    void proc.exited
      .then((code) => {
        const activeSession = this.sessions.get(session.id);
        if (!activeSession) {
          return;
        }

        const activeAttachment = activeSession.attachments.get(client.id);
        if (!activeAttachment || activeAttachment.spawnVersion !== spawnVersion) {
          return;
        }

        activeSession.attachments.delete(client.id);
        activeSession.lastActiveAtMs = Date.now();

        if (!this.tmuxSessionExists(session.id)) {
          this.sendToClient(client, { type: "session_not_found", sessionId: session.id });
        }

        this.sendToClient(client, { type: "exit", code, signal: null });
      })
      .catch((error) => {
        const activeSession = this.sessions.get(session.id);
        if (!activeSession) {
          return;
        }

        const activeAttachment = activeSession.attachments.get(client.id);
        if (!activeAttachment || activeAttachment.spawnVersion !== spawnVersion) {
          return;
        }

        activeSession.attachments.delete(client.id);
        this.sendToClient(client, {
          type: "error",
          message: `Attach process failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
  }

  private stopAttachment(session: TerminalSession, clientId: string, closeClient: boolean): void {
    const attachment = session.attachments.get(clientId);
    if (!attachment) {
      return;
    }

    session.attachments.delete(clientId);

    try {
      attachment.proc.kill();
    } catch {
      // Process may already be gone.
    }

    try {
      attachment.proc.terminal?.close();
    } catch {
      // PTY may already be closed.
    }

    if (closeClient) {
      attachment.client.close?.(4004, "Session closed");
    }
  }

  private stopAllAttachments(session: TerminalSession, closeClient: boolean): void {
    for (const clientId of [...session.attachments.keys()]) {
      this.stopAttachment(session, clientId, closeClient);
    }
  }

  private toMetadata(session: TerminalSession): SessionMetadata {
    const firstAttachment = session.attachments.values().next().value as SessionAttachment | undefined;

    return {
      id: session.id,
      state: session.state,
      connected: session.attachments.size > 0,
      cols: session.cols,
      rows: session.rows,
      pid: firstAttachment?.proc.pid ?? null,
      createdAt: new Date(session.createdAtMs).toISOString(),
      lastActiveAt: new Date(session.lastActiveAtMs).toISOString(),
      attachedClients: session.attachments.size,
    };
  }

  private sendToClient(client: SessionClient, message: ServerMessage): void {
    try {
      client.send(message);
    } catch {
      // Ignore send failures on disconnected sockets.
    }
  }

  private broadcastToSession(session: TerminalSession, message: ServerMessage): void {
    for (const attachment of session.attachments.values()) {
      this.sendToClient(attachment.client, message);
    }
  }

  private validateSessionName(name: string): void {
    if (!name) {
      throw new SessionManagerError("Session name cannot be empty", 400, "SESSION_NAME_INVALID");
    }

    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
      throw new SessionManagerError(
        "Session name may only include letters, numbers, underscores, and hyphens",
        400,
        "SESSION_NAME_INVALID",
      );
    }
  }

  private nextAutoName(): string {
    let index = 1;
    while (true) {
      const candidate = `session-${index.toString().padStart(3, "0")}`;
      if (!this.sessions.has(candidate) && !this.tmuxSessionExists(candidate)) {
        return candidate;
      }
      index += 1;
    }
  }

  private tmuxSessionExists(sessionId: string): boolean {
    if (!this.isTmuxAvailable()) {
      return false;
    }

    const result = this.runTmux(["has-session", "-t", sessionId]);
    return result.exitCode === 0;
  }

  private syncSessionsFromTmux(): void {
    const listResult = this.runTmux(["list-sessions", "-F", "#{session_name}\t#{session_created}"]);
    if (listResult.exitCode !== 0) {
      if (isNotRunningTmuxError(listResult.stderr)) {
        this.tmuxUnavailableReason = null;
        for (const session of this.sessions.values()) {
          this.stopAllAttachments(session, false);
        }
        this.sessions.clear();
        return;
      }

      if (isTmuxUnavailableError(listResult.stderr)) {
        this.tmuxUnavailableReason = `tmux is not accessible in this environment: ${listResult.stderr}`;
        for (const session of this.sessions.values()) {
          this.stopAllAttachments(session, false);
        }
        this.sessions.clear();
        return;
      }

      this.tmuxUnavailableReason = `Unable to use tmux: ${listResult.stderr || "unknown error"}`;
      for (const session of this.sessions.values()) {
        this.stopAllAttachments(session, false);
      }
      this.sessions.clear();
      return;
    }

    this.tmuxUnavailableReason = null;

    const listed = listResult.stdout
      .split("\n")
      .map((line) => parseSessionLine(line))
      .filter((session): session is TmuxSessionRef => session !== null);

    const listedIds = new Set(listed.map((session) => session.id));

    for (const [sessionId, session] of this.sessions.entries()) {
      if (!listedIds.has(sessionId)) {
        this.stopAllAttachments(session, false);
        this.sessions.delete(sessionId);
      }
    }

    for (const listedSession of listed) {
      const existing = this.sessions.get(listedSession.id);
      if (!existing) {
        this.sessions.set(listedSession.id, {
          id: listedSession.id,
          cols: this.options.defaultCols,
          rows: this.options.defaultRows,
          state: "ready",
          createdAtMs: listedSession.createdAtMs,
          lastActiveAtMs: listedSession.createdAtMs,
          attachments: new Map(),
          nextSpawnVersion: 1,
        });
        continue;
      }

      existing.createdAtMs = listedSession.createdAtMs;
      existing.state = "ready";
    }
  }

  private assertTmuxAvailable(): void {
    if (!this.tmuxUnavailableReason) {
      return;
    }

    throw new SessionManagerError(this.tmuxUnavailableReason, 503, "TMUX_UNAVAILABLE");
  }

  private runTmux(args: string[]): { exitCode: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync(["tmux", ...args], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    return {
      exitCode: result.exitCode,
      stdout: textDecoder.decode(result.stdout).trim(),
      stderr: textDecoder.decode(result.stderr).trim(),
    };
  }
}

export function isSessionManagerError(error: unknown): error is SessionManagerError {
  return error instanceof SessionManagerError;
}
