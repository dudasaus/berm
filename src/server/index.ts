import app from "../web/index.html";
import { serializeMessage, type ServerMessage } from "../shared/protocol";
import {
  type CreateSessionResult,
  type CreateSessionRequest,
  type ProjectMetadata,
  type ResolveWorktreeHookDecisionRequest,
  type ResolveWorktreeHookDecisionResult,
  type SessionMetadata,
  TerminalSessionManager,
  type UpdateProjectRequest,
  type UpdateSessionLifecycleRequest,
  isSessionManagerError,
  type SessionClient,
} from "./terminal-session";

type WebSocketData = {
  projectId: string;
  sessionId: string;
  clientId: string;
};

type GitHubPullRequestState = "OPEN" | "CLOSED" | "MERGED";

type GitHubSessionPrInfo = {
  number: number;
  title: string;
  url: string;
  state: GitHubPullRequestState;
  isDraft: boolean;
};

type GitHubSessionCiState = "success" | "failure" | "pending" | "none";

type GitHubSessionCiInfo = {
  state: GitHubSessionCiState;
  summary: string;
  total: number;
  passing: number;
  failing: number;
  pending: number;
};

type GitHubSessionSyncItem = {
  sessionId: string;
  branchName: string | null;
  pr: GitHubSessionPrInfo | null;
  ci: GitHubSessionCiInfo | null;
  source: "github" | "none" | "error";
  error?: string;
};

type GitHubSyncResponse = {
  sessions: GitHubSessionSyncItem[];
  syncedAt: string;
  cached: boolean;
};

const GITHUB_SYNC_CACHE_TTL_MS = 15_000;
const githubSyncCache = new Map<string, { expiresAtMs: number; payload: GitHubSyncResponse }>();
const textDecoder = new TextDecoder();

export interface SessionManagerLike {
  listProjects(): ProjectMetadata[];
  selectProject(path: string): ProjectMetadata;
  updateProject(projectId: string, input: UpdateProjectRequest): ProjectMetadata;
  deleteProject(projectId: string): boolean;
  getProject(projectId: string): ProjectMetadata | null;
  listSessions(projectId: string): SessionMetadata[];
  createSession(projectId: string, request?: CreateSessionRequest): CreateSessionResult;
  resolveWorktreeHookDecision(projectId: string, request: ResolveWorktreeHookDecisionRequest): ResolveWorktreeHookDecisionResult;
  updateSessionLifecycleState(projectId: string, sessionId: string, input: UpdateSessionLifecycleRequest): SessionMetadata;
  deleteSession(projectId: string, sessionId: string): boolean;
  hasSession(projectId: string, sessionId: string): boolean;
  attachClient(projectId: string, sessionId: string, client: SessionClient): SessionMetadata | null;
  handleClientMessage(projectId: string, sessionId: string, clientId: string, rawMessage: unknown): void;
  detachClient(projectId: string, sessionId: string, clientId: string): void;
  getSessionMetadata(projectId: string, sessionId: string): SessionMetadata | null;
  shutdown(): Promise<void>;
}

interface CreateServerOptions {
  manager?: SessionManagerLike;
  pickProjectDirectory?: () => Response;
  port?: number;
}

export interface ServerConfig {
  routes: Record<string, unknown>;
  websocket: {
    data: WebSocketData;
    open: (ws: Bun.ServerWebSocket<WebSocketData>) => void;
    message: (ws: Bun.ServerWebSocket<WebSocketData>, message: string | Buffer<ArrayBuffer>) => void;
    close: (ws: Bun.ServerWebSocket<WebSocketData>) => void;
  };
}

function createDefaultManager(): TerminalSessionManager {
  return new TerminalSessionManager({
    tmuxSocketName: Bun.env.COMMAND_CENTER_TMUX_SOCKET ?? undefined,
    registryPath: Bun.env.COMMAND_CENTER_REGISTRY_PATH ?? undefined,
  });
}

export function buildHealthResponse(): Response {
  return Response.json({
    ok: true,
    now: new Date().toISOString(),
  });
}

export function buildSessionResponse(
  sessionManager: SessionManagerLike,
  projectId: string,
  sessionId: string,
): Response {
  const metadata = sessionManager.getSessionMetadata(projectId, sessionId);
  if (!metadata) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  return Response.json(metadata);
}

function errorResponse(error: unknown): Response {
  if (isSessionManagerError(error)) {
    return Response.json(
      {
        error: error.message,
        code: error.code,
        ...(error.details ?? {}),
      },
      { status: error.statusCode },
    );
  }

  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

function pickProjectDirectory(): Response {
  if (process.platform !== "darwin") {
    return Response.json(
      { error: "Native directory picker is currently supported on macOS only", code: "PROJECT_PICK_UNSUPPORTED" },
      { status: 501 },
    );
  }

  const result = Bun.spawnSync(
    [
      "osascript",
      "-e",
      'POSIX path of (choose folder with prompt "Select Command Center Project")',
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();

  if (result.exitCode !== 0) {
    const lowered = stderr.toLowerCase();
    if (lowered.includes("user canceled")) {
      return Response.json({ error: "Project picker cancelled", code: "PROJECT_PICK_CANCELLED" }, { status: 400 });
    }

    return Response.json(
      { error: stderr || "Unable to open native project picker", code: "PROJECT_PICK_FAILED" },
      { status: 500 },
    );
  }

  if (!stdout) {
    return Response.json({ error: "No project path returned from picker", code: "PROJECT_PICK_EMPTY" }, { status: 500 });
  }

  return Response.json({ path: stdout });
}

function runCommandSync(args: string[], cwd: string): { exitCode: number; stdout: string; stderr: string } {
  try {
    const result = Bun.spawnSync(args, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    return {
      exitCode: result.exitCode,
      stdout: textDecoder.decode(result.stdout).trim(),
      stderr: textDecoder.decode(result.stderr).trim(),
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveSessionBranchName(session: SessionMetadata): string | null {
  if (session.branchName && session.branchName.trim().length > 0) {
    return session.branchName.trim();
  }

  const branchResult = runCommandSync(["git", "-C", session.workspacePath, "rev-parse", "--abbrev-ref", "HEAD"], session.workspacePath);
  if (branchResult.exitCode !== 0 || !branchResult.stdout || branchResult.stdout === "HEAD") {
    return null;
  }

  return branchResult.stdout;
}

function summarizeStatusChecks(statusCheckRollup: unknown): GitHubSessionCiInfo | null {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) {
    return null;
  }

  let passing = 0;
  let failing = 0;
  let pending = 0;

  for (const check of statusCheckRollup) {
    if (!check || typeof check !== "object") {
      pending += 1;
      continue;
    }

    const record = check as { status?: unknown; conclusion?: unknown };
    const status = typeof record.status === "string" ? record.status.toUpperCase() : "";
    const conclusion = typeof record.conclusion === "string" ? record.conclusion.toUpperCase() : "";

    if (status && status !== "COMPLETED") {
      pending += 1;
      continue;
    }

    if (!conclusion) {
      pending += 1;
      continue;
    }

    if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") {
      passing += 1;
      continue;
    }

    failing += 1;
  }

  const total = statusCheckRollup.length;
  const summaryParts: string[] = [];
  if (passing > 0) {
    summaryParts.push(`${passing} passing`);
  }
  if (failing > 0) {
    summaryParts.push(`${failing} failing`);
  }
  if (pending > 0) {
    summaryParts.push(`${pending} pending`);
  }

  return {
    state: failing > 0 ? "failure" : pending > 0 ? "pending" : passing > 0 ? "success" : "none",
    summary: summaryParts.length > 0 ? summaryParts.join(", ") : "No checks",
    total,
    passing,
    failing,
    pending,
  };
}

function buildGitHubSyncForSession(session: SessionMetadata): GitHubSessionSyncItem {
  const branchName = resolveSessionBranchName(session);
  if (!branchName) {
    return {
      sessionId: session.id,
      branchName: null,
      pr: null,
      ci: null,
      source: "none",
    };
  }

  const ghResult = runCommandSync(
    [
      "gh",
      "pr",
      "list",
      "--head",
      branchName,
      "--state",
      "all",
      "--json",
      "number,title,url,state,isDraft,statusCheckRollup",
      "--limit",
      "1",
    ],
    session.workspacePath,
  );

  if (ghResult.exitCode !== 0) {
    return {
      sessionId: session.id,
      branchName,
      pr: null,
      ci: null,
      source: "error",
      error: ghResult.stderr || "Unable to sync PR/CI status from GitHub",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(ghResult.stdout);
  } catch {
    return {
      sessionId: session.id,
      branchName,
      pr: null,
      ci: null,
      source: "error",
      error: "GitHub CLI returned invalid JSON",
    };
  }

  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed[0] || typeof parsed[0] !== "object") {
    return {
      sessionId: session.id,
      branchName,
      pr: null,
      ci: null,
      source: "none",
    };
  }

  const item = parsed[0] as {
    number?: unknown;
    title?: unknown;
    url?: unknown;
    state?: unknown;
    isDraft?: unknown;
    statusCheckRollup?: unknown;
  };

  const state = typeof item.state === "string" ? item.state.toUpperCase() : "";
  const prState: GitHubPullRequestState =
    state === "OPEN" || state === "CLOSED" || state === "MERGED" ? state : "OPEN";

  return {
    sessionId: session.id,
    branchName,
    pr: {
      number: typeof item.number === "number" ? item.number : 0,
      title: typeof item.title === "string" ? item.title : "",
      url: typeof item.url === "string" ? item.url : "",
      state: prState,
      isDraft: item.isDraft === true,
    },
    ci: summarizeStatusChecks(item.statusCheckRollup),
    source: "github",
  };
}

function buildGitHubSyncResponse(manager: SessionManagerLike, projectId: string): GitHubSyncResponse {
  const nowMs = Date.now();
  const cached = githubSyncCache.get(projectId);
  if (cached && cached.expiresAtMs > nowMs) {
    return { ...cached.payload, cached: true };
  }

  const sessions = manager.listSessions(projectId);
  const payload: GitHubSyncResponse = {
    sessions: sessions.map((session) => buildGitHubSyncForSession(session)),
    syncedAt: new Date(nowMs).toISOString(),
    cached: false,
  };

  githubSyncCache.set(projectId, {
    expiresAtMs: nowMs + GITHUB_SYNC_CACHE_TTL_MS,
    payload,
  });

  return payload;
}

export function createServerConfig(
  manager: SessionManagerLike,
  openProjectPicker: () => Response = pickProjectDirectory,
): ServerConfig {
  return {
    routes: {
      "/": app,
      "/api/health": () => buildHealthResponse(),
      "/api/projects": {
        GET: () => {
          return Response.json({ projects: manager.listProjects() });
        },
      },
      "/api/projects/select": {
        POST: async (req: Request) => {
          try {
            const body = (await req.json().catch(() => ({}))) as { path?: string };
            const path = typeof body.path === "string" ? body.path : "";
            const project = manager.selectProject(path);
            return Response.json(project, { status: 201 });
          } catch (error) {
            return errorResponse(error);
          }
        },
      },
      "/api/projects/:id": {
        PATCH: async (req: Bun.BunRequest<"/api/projects/:id">) => {
          try {
            const body = (await req.json().catch(() => ({}))) as UpdateProjectRequest;
            const project = manager.updateProject(req.params.id, body);
            return Response.json(project);
          } catch (error) {
            return errorResponse(error);
          }
        },
        DELETE: (req: Bun.BunRequest<"/api/projects/:id">) => {
          try {
            const deleted = manager.deleteProject(req.params.id);
            if (!deleted) {
              return Response.json({ error: "Project not found" }, { status: 404 });
            }

            return Response.json({ ok: true });
          } catch (error) {
            return errorResponse(error);
          }
        },
      },
      "/api/projects/pick": {
        POST: () => {
          return openProjectPicker();
        },
      },
      "/api/projects/:projectId/sessions": {
        GET: (req: Bun.BunRequest<"/api/projects/:projectId/sessions">) => {
          const project = manager.getProject(req.params.projectId);
          if (!project) {
            return Response.json({ error: "Project not found" }, { status: 404 });
          }

          return Response.json({ sessions: manager.listSessions(req.params.projectId) });
        },
        POST: async (req: Bun.BunRequest<"/api/projects/:projectId/sessions">) => {
          try {
            const body = (await req.json().catch(() => ({}))) as {
              mode?: unknown;
              name?: unknown;
              branchName?: unknown;
            };

            let request: CreateSessionRequest | undefined;
            if (body.mode === "worktree") {
              request = {
                mode: "worktree",
                branchName: typeof body.branchName === "string" ? body.branchName : "",
              };
            } else if (typeof body.mode === "undefined" || body.mode === "main") {
              request = {
                mode: "main",
                name: typeof body.name === "string" ? body.name : undefined,
              };
            } else {
              request = body as CreateSessionRequest;
            }

            const created = manager.createSession(req.params.projectId, request);
            return Response.json(created, { status: 201 });
          } catch (error) {
            return errorResponse(error);
          }
        },
      },
      "/api/projects/:projectId/sessions/github-sync": {
        GET: (req: Bun.BunRequest<"/api/projects/:projectId/sessions/github-sync">) => {
          const project = manager.getProject(req.params.projectId);
          if (!project) {
            return Response.json({ error: "Project not found" }, { status: 404 });
          }

          return Response.json(buildGitHubSyncResponse(manager, req.params.projectId));
        },
      },
      "/api/projects/:projectId/sessions/worktree-hook-decision": {
        POST: async (req: Bun.BunRequest<"/api/projects/:projectId/sessions/worktree-hook-decision">) => {
          try {
            const body = (await req.json().catch(() => ({}))) as {
              decisionToken?: unknown;
              decision?: unknown;
            };

            const result = manager.resolveWorktreeHookDecision(req.params.projectId, {
              decisionToken: typeof body.decisionToken === "string" ? body.decisionToken : "",
              decision: body.decision as ResolveWorktreeHookDecisionRequest["decision"],
            });

            if (result.action === "continue") {
              return Response.json(result, { status: 201 });
            }

            return Response.json(result);
          } catch (error) {
            return errorResponse(error);
          }
        },
      },
      "/api/projects/:projectId/sessions/:id": {
        GET: (req: Bun.BunRequest<"/api/projects/:projectId/sessions/:id">) =>
          buildSessionResponse(manager, req.params.projectId, req.params.id),
        PATCH: async (req: Bun.BunRequest<"/api/projects/:projectId/sessions/:id">) => {
          try {
            const body = (await req.json().catch(() => ({}))) as {
              lifecycleState?: unknown;
            };
            const session = manager.updateSessionLifecycleState(req.params.projectId, req.params.id, {
              lifecycleState: body.lifecycleState as UpdateSessionLifecycleRequest["lifecycleState"],
            });
            return Response.json(session);
          } catch (error) {
            return errorResponse(error);
          }
        },
        DELETE: (req: Bun.BunRequest<"/api/projects/:projectId/sessions/:id">) => {
          try {
            const deleted = manager.deleteSession(req.params.projectId, req.params.id);
            if (!deleted) {
              return Response.json({ error: "Session not found" }, { status: 404 });
            }

            return Response.json({ ok: true });
          } catch (error) {
            return errorResponse(error);
          }
        },
      },
      "/ws/terminal": (req: Request, serverRef: Pick<Bun.Server<WebSocketData>, "upgrade">) => {
        const url = new URL(req.url);
        const projectId = url.searchParams.get("projectId")?.trim();
        if (!projectId) {
          return Response.json({ error: "projectId query parameter is required" }, { status: 400 });
        }

        const sessionId = url.searchParams.get("sessionId")?.trim();
        if (!sessionId) {
          return Response.json({ error: "sessionId query parameter is required" }, { status: 400 });
        }

        if (!manager.hasSession(projectId, sessionId)) {
          return Response.json({ error: "Session not found" }, { status: 404 });
        }

        const upgraded = serverRef.upgrade(req, {
          data: {
            projectId,
            sessionId,
            clientId: crypto.randomUUID(),
          },
        });

        if (!upgraded) {
          return Response.json({ error: "WebSocket upgrade failed" }, { status: 400 });
        }

        return undefined;
      },
    },
    websocket: {
      data: {} as WebSocketData,
      open(ws: Bun.ServerWebSocket<WebSocketData>) {
        const client: SessionClient = {
          id: ws.data.clientId,
          send(message: ServerMessage) {
            ws.send(serializeMessage(message));
          },
          close(code, reason) {
            ws.close(code, reason);
          },
        };

        const attached = manager.attachClient(ws.data.projectId, ws.data.sessionId, client);
        if (!attached) {
          ws.send(serializeMessage({ type: "session_not_found", sessionId: ws.data.sessionId }));
          ws.close(4004, "Session not found");
        }
      },
      message(ws: Bun.ServerWebSocket<WebSocketData>, message: string | Buffer<ArrayBuffer>) {
        manager.handleClientMessage(ws.data.projectId, ws.data.sessionId, ws.data.clientId, message);
      },
      close(ws: Bun.ServerWebSocket<WebSocketData>) {
        manager.detachClient(ws.data.projectId, ws.data.sessionId, ws.data.clientId);
      },
    },
  };
}

export function createServer(options: number | CreateServerOptions = {}) {
  const normalized: CreateServerOptions = typeof options === "number" ? { port: options } : options;
  const port = normalized.port ?? Number(Bun.env.COMMAND_CENTER_PORT ?? 3000);
  const manager = normalized.manager ?? createDefaultManager();
  const openProjectPicker = normalized.pickProjectDirectory ?? pickProjectDirectory;
  const config = createServerConfig(manager, openProjectPicker);

  const serverOptions = {
    port,
    routes: config.routes,
    websocket: {
      data: config.websocket.data,
      open(ws) {
        config.websocket.open(ws);
      },
      message(ws, message) {
        config.websocket.message(ws, message);
      },
      close(ws) {
        config.websocket.close(ws);
      },
    },
  } as Bun.Serve.Options<WebSocketData, string>;

  const server = Bun.serve<WebSocketData, string>(serverOptions);

  return {
    server,
    manager,
    async stop(force = false) {
      await manager.shutdown();
      await server.stop(force);
    },
  };
}

if (import.meta.main) {
  const { server } = createServer();
  console.log(`Command Center listening at ${server.url}`);
}
