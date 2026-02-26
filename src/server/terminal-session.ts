import {
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
  type TerminalStatusState,
} from "../shared/protocol";
import {
  defaultSessionRegistryPath,
  loadSessionRegistry,
  saveSessionRegistry,
  type SessionRegistryEntry,
} from "./session-registry";

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
  tmuxSocketName?: string;
  registryPath?: string;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 34;
const DEFAULT_TMUX_SOCKET_NAME = "command-center";
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
  if (lowered.includes("no server running") || lowered.includes("failed to connect to server")) {
    return true;
  }

  return lowered.includes("error connecting to") && lowered.includes("no such file or directory");
}

function loweredIncludesAny(value: string, patterns: string[]): boolean {
  const lowered = value.toLowerCase();
  return patterns.some((pattern) => lowered.includes(pattern));
}

function isMissingSessionError(stderr: string): boolean {
  return loweredIncludesAny(stderr, ["can't find session", "can't find pane"]);
}

function isTmuxUnavailableError(stderr: string): boolean {
  return loweredIncludesAny(stderr, ["operation not permitted", "permission denied", "access denied"]);
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

function entryToTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return Date.now();
  }
  return parsed;
}

export class TerminalSessionManager {
  private readonly options: Required<TerminalSessionManagerOptions>;
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly registry = new Map<string, SessionRegistryEntry>();
  private unavailableReason: string | null = null;

  constructor(options: TerminalSessionManagerOptions = {}) {
    this.options = {
      defaultCols: options.defaultCols ?? DEFAULT_COLS,
      defaultRows: options.defaultRows ?? DEFAULT_ROWS,
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      tmuxSocketName: options.tmuxSocketName ?? DEFAULT_TMUX_SOCKET_NAME,
      registryPath: options.registryPath ?? defaultSessionRegistryPath(),
    };

    try {
      const loaded = loadSessionRegistry(this.options.registryPath);
      for (const [id, entry] of loaded.entries()) {
        this.registry.set(id, entry);
      }
    } catch (error) {
      this.unavailableReason = `Session registry is not accessible: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }

    this.syncSessionsFromTmux();
  }

  isTmuxAvailable(): boolean {
    return this.unavailableReason === null;
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
    this.assertAvailable();

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

    if (!this.tmuxSessionExists(targetName)) {
      const details = createResult.stderr || "tmux did not report an active session";
      if (isTmuxUnavailableError(details)) {
        throw new SessionManagerError(
          `tmux is not accessible in this environment: ${details}`,
          503,
          "TMUX_UNAVAILABLE",
        );
      }

      throw new SessionManagerError(
        `Failed to create tmux session '${targetName}': ${details}`,
        500,
        "SESSION_CREATE_FAILED",
      );
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    this.registry.set(targetName, {
      id: targetName,
      createdAt: nowIso,
      lastActiveAt: nowIso,
    });
    this.saveRegistry();

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
    return this.toMetadata(session);
  }

  deleteSession(sessionId: string): boolean {
    this.syncSessionsFromTmux();
    this.assertAvailable();

    const existsLocally = this.sessions.has(sessionId);
    const existsInRegistry = this.registry.has(sessionId);
    if (!existsLocally && !existsInRegistry) {
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

    this.registry.delete(sessionId);
    this.saveRegistry();

    return true;
  }

  attachClient(sessionId: string, client: SessionClient): SessionMetadata | null {
    this.syncSessionsFromTmux();
    if (!this.isTmuxAvailable()) {
      this.sendToClient(client, {
        type: "error",
        message: this.unavailableReason ?? "tmux is not available in this environment",
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
        message: this.unavailableReason ?? "tmux is not available",
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

    const proc = Bun.spawn(["tmux", "-L", this.options.tmuxSocketName, "attach-session", "-t", session.id], {
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
    if (this.unavailableReason?.startsWith("Session registry")) {
      return;
    }

    const listResult = this.runTmux(["list-sessions", "-F", "#{session_name}\t#{session_created}"]);

    if (listResult.exitCode !== 0) {
      if (isNotRunningTmuxError(listResult.stderr)) {
        this.unavailableReason = null;
        this.reconcileFromListed([]);
        return;
      }

      if (isTmuxUnavailableError(listResult.stderr)) {
        this.unavailableReason = `tmux is not accessible in this environment: ${listResult.stderr}`;
        for (const session of this.sessions.values()) {
          this.stopAllAttachments(session, false);
        }
        this.sessions.clear();
        return;
      }

      this.unavailableReason = `Unable to use tmux: ${listResult.stderr || "unknown error"}`;
      for (const session of this.sessions.values()) {
        this.stopAllAttachments(session, false);
      }
      this.sessions.clear();
      return;
    }

    this.unavailableReason = null;

    const listed = listResult.stdout
      .split("\n")
      .map((line) => parseSessionLine(line))
      .filter((session): session is TmuxSessionRef => session !== null);

    this.reconcileFromListed(listed);
  }

  private reconcileFromListed(listed: TmuxSessionRef[]): void {
    const listedMap = new Map(listed.map((session) => [session.id, session]));
    const listedIds = new Set(listedMap.keys());
    let registryChanged = false;

    for (const registryId of [...this.registry.keys()]) {
      if (!listedIds.has(registryId)) {
        this.registry.delete(registryId);
        registryChanged = true;
      }
    }

    const trackedIds = new Set<string>();
    for (const registryId of this.registry.keys()) {
      if (listedIds.has(registryId)) {
        trackedIds.add(registryId);
      }
    }

    for (const [sessionId, session] of this.sessions.entries()) {
      if (!trackedIds.has(sessionId)) {
        this.stopAllAttachments(session, false);
        this.sessions.delete(sessionId);
      }
    }

    for (const sessionId of trackedIds) {
      const listedSession = listedMap.get(sessionId);
      const registryEntry = this.registry.get(sessionId);
      if (!listedSession || !registryEntry) {
        continue;
      }

      const createdAtMs = entryToTimestamp(registryEntry.createdAt);
      const registryLastActiveMs = entryToTimestamp(registryEntry.lastActiveAt);

      const existing = this.sessions.get(sessionId);
      if (!existing) {
        this.sessions.set(sessionId, {
          id: sessionId,
          cols: this.options.defaultCols,
          rows: this.options.defaultRows,
          state: "ready",
          createdAtMs,
          lastActiveAtMs: registryLastActiveMs,
          attachments: new Map(),
          nextSpawnVersion: 1,
        });
        continue;
      }

      existing.createdAtMs = createdAtMs;
      existing.state = "ready";
      if (existing.lastActiveAtMs < registryLastActiveMs) {
        existing.lastActiveAtMs = registryLastActiveMs;
      }

      const normalizedLastActive = new Date(existing.lastActiveAtMs).toISOString();
      const normalizedCreatedAt = new Date(existing.createdAtMs).toISOString();
      if (registryEntry.createdAt !== normalizedCreatedAt || registryEntry.lastActiveAt !== normalizedLastActive) {
        this.registry.set(sessionId, {
          ...registryEntry,
          createdAt: normalizedCreatedAt,
          lastActiveAt: normalizedLastActive,
        });
        registryChanged = true;
      }
    }

    if (registryChanged) {
      this.saveRegistry();
    }
  }

  private saveRegistry(): void {
    try {
      saveSessionRegistry(this.options.registryPath, this.registry);
    } catch (error) {
      this.unavailableReason = `Session registry is not writable: ${error instanceof Error ? error.message : String(error)}`;
      throw new SessionManagerError(this.unavailableReason, 500, "REGISTRY_WRITE_FAILED");
    }
  }

  private assertAvailable(): void {
    if (!this.unavailableReason) {
      return;
    }

    const code = this.unavailableReason.startsWith("Session registry") ? "REGISTRY_UNAVAILABLE" : "TMUX_UNAVAILABLE";
    throw new SessionManagerError(this.unavailableReason, 503, code);
  }

  private runTmux(args: string[]): { exitCode: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync(["tmux", "-L", this.options.tmuxSocketName, ...args], {
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
