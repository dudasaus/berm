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
}

interface TerminalSession {
  id: string;
  cols: number;
  rows: number;
  state: TerminalStatusState;
  createdAtMs: number;
  lastActiveAtMs: number;
  spawnVersion: number;
  client?: SessionClient;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  proc?: Bun.Subprocess;
}

interface TerminalSessionManagerOptions {
  reconnectGraceMs?: number;
  defaultCols?: number;
  defaultRows?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 34;
const DEFAULT_RECONNECT_GRACE_MS = 20_000;
const textDecoder = new TextDecoder();

export class TerminalSessionManager {
  private readonly options: Required<TerminalSessionManagerOptions>;
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(options: TerminalSessionManagerOptions = {}) {
    this.options = {
      reconnectGraceMs: options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS,
      defaultCols: options.defaultCols ?? DEFAULT_COLS,
      defaultRows: options.defaultRows ?? DEFAULT_ROWS,
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
    };
  }

  attachClient(sessionId: string, client: SessionClient): SessionMetadata {
    const session = this.getOrCreateSession(sessionId);

    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = undefined;
    }

    if (session.client && session.client.id !== client.id) {
      session.client.close?.(4001, "Replaced by a newer connection");
    }

    session.client = client;
    session.lastActiveAtMs = Date.now();

    if (!session.proc) {
      this.spawnSessionProcess(session);
    } else {
      session.state = "ready";
      this.send(session, { type: "status", state: "ready" });
    }

    return this.getSessionMetadata(session.id)!;
  }

  detachClient(sessionId: string, clientId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.client?.id !== clientId) {
      return;
    }

    session.client = undefined;
    session.state = "reconnecting";

    session.reconnectTimer = setTimeout(() => {
      const current = this.sessions.get(sessionId);
      if (current && !current.client) {
        this.destroySession(sessionId);
      }
    }, this.options.reconnectGraceMs);
  }

  handleClientMessage(sessionId: string, rawMessage: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const parsed = parseClientMessage(rawMessage);
    if (!parsed.ok) {
      this.send(session, { type: "error", message: parsed.error });
      return;
    }

    session.lastActiveAtMs = Date.now();
    this.applyClientMessage(session, parsed.value);
  }

  getSessionMetadata(sessionId: string): SessionMetadata | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    return {
      id: session.id,
      state: session.state,
      connected: Boolean(session.client),
      cols: session.cols,
      rows: session.rows,
      pid: session.proc?.pid ?? null,
      createdAt: new Date(session.createdAtMs).toISOString(),
      lastActiveAt: new Date(session.lastActiveAtMs).toISOString(),
    };
  }

  async shutdown(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.destroySession(id)));
  }

  private getOrCreateSession(sessionId: string): TerminalSession {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const session: TerminalSession = {
      id: sessionId,
      cols: this.options.defaultCols,
      rows: this.options.defaultRows,
      state: "starting",
      createdAtMs: now,
      lastActiveAtMs: now,
      spawnVersion: 0,
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  private applyClientMessage(session: TerminalSession, message: ClientMessage): void {
    switch (message.type) {
      case "input": {
        session.proc?.terminal?.write(message.data);
        return;
      }

      case "resize": {
        session.cols = message.cols;
        session.rows = message.rows;
        session.proc?.terminal?.resize(message.cols, message.rows);
        return;
      }

      case "reset": {
        this.resetSession(session);
        return;
      }

      case "ping": {
        this.send(session, { type: "pong", ts: message.ts });
        return;
      }

      default: {
        const neverMessage: never = message;
        throw new Error(`Unhandled message ${(neverMessage as { type: string }).type}`);
      }
    }
  }

  private resetSession(session: TerminalSession): void {
    this.stopProcess(session);
    this.spawnSessionProcess(session);
  }

  private spawnSessionProcess(session: TerminalSession): void {
    session.spawnVersion += 1;
    const version = session.spawnVersion;

    session.state = "starting";
    this.send(session, { type: "status", state: "starting" });

    const proc = Bun.spawn(["zsh"], {
      cwd: this.options.cwd,
      env: this.options.env,
        terminal: {
          cols: session.cols,
          rows: session.rows,
          data: (_terminal, data) => {
            if (this.sessions.get(session.id)?.spawnVersion !== version) {
              return;
            }
            session.lastActiveAtMs = Date.now();
            this.send(session, {
              type: "output",
              data: typeof data === "string" ? data : textDecoder.decode(data),
            });
          },
        },
      });

    session.proc = proc;
    session.state = "ready";
    this.send(session, { type: "status", state: "ready" });

    void proc.exited
      .then((code) => {
        const active = this.sessions.get(session.id);
        if (!active || active.spawnVersion !== version) {
          return;
        }

        active.proc = undefined;
        active.lastActiveAtMs = Date.now();
        this.send(active, { type: "exit", code, signal: null });

        if (!active.client) {
          void this.destroySession(active.id);
        }
      })
      .catch((error) => {
        const active = this.sessions.get(session.id);
        if (!active || active.spawnVersion !== version) {
          return;
        }
        this.send(active, {
          type: "error",
          message: `Shell process failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
  }

  private async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
    }

    session.client = undefined;

    this.stopProcess(session);
    this.sessions.delete(sessionId);
  }

  private stopProcess(session: TerminalSession): void {
    const proc = session.proc;
    if (!proc) {
      return;
    }

    session.proc = undefined;

    try {
      proc.kill();
    } catch {
      // Process may already be stopped.
    }

    try {
      proc.terminal?.close();
    } catch {
      // Terminal may already be closed.
    }
  }

  private send(session: TerminalSession, message: ServerMessage): void {
    try {
      session.client?.send(message);
    } catch {
      // Client may disconnect between checks.
    }
  }
}
