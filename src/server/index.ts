import { join, basename } from "path";
import { readdirSync } from "fs";
import app from "../web/index.html";
import { version, commitHash } from "../build-info";

/**
 * When running from a pre-built bundle (bun build --target=bun), the HTML
 * import becomes a manifest with relative file paths. Bun.serve() resolves
 * those paths relative to CWD, which breaks when the CLI is run from a
 * different directory (e.g. via bunx). This helper detects the pre-built
 * case and creates explicit routes using absolute paths derived from
 * import.meta.dir (the directory containing the bundled cli.js).
 */
function resolveAppRoutes(): Record<string, any> {
  if (!app.files) {
    // Dev mode — Bun.serve() handles bundling at runtime
    return { "/": app };
  }

  // Pre-built: resolve each file relative to the bundle's directory
  const baseDir = import.meta.dir;
  const routes: Record<string, any> = {};

  for (const file of app.files) {
    const absPath = join(baseDir, file.path);
    if (file.loader === "html") {
      routes["/"] = Bun.file(absPath);
    } else {
      const urlPath = "/" + file.path.replace(/^\.\//, "");
      routes[urlPath] = Bun.file(absPath);
    }
  }

  // Serve additional static assets (e.g. favicon) not listed in the manifest
  const manifestPaths = new Set(app.files.map((f) => basename(f.path)));
  const assetExts = new Set([".png", ".ico", ".svg", ".jpg", ".jpeg", ".gif", ".webp", ".woff", ".woff2"]);
  for (const entry of readdirSync(baseDir)) {
    const ext = entry.slice(entry.lastIndexOf("."));
    if (assetExts.has(ext) && !manifestPaths.has(entry)) {
      routes["/" + entry] = Bun.file(join(baseDir, entry));
    }
  }

  return routes;
}
import { serializeMessage, type ServerMessage } from "../shared/protocol";
import {
  type CreateSessionResult,
  type CreateSessionRequest,
  type ImportWorktreeSessionsRequest,
  type ListImportWorktreeCandidatesResult,
  type ImportWorktreeSessionsResult,
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

type GitHubSyncPayload = {
  sessions: GitHubSessionSyncItem[];
  syncedAt: string;
};

type GitHubSyncResponse = GitHubSyncPayload & {
  cached: boolean;
  refreshing: boolean;
};

const GITHUB_SYNC_CACHE_TTL_MS = 15_000;
const GITHUB_SYNC_FAILURE_RETRY_MS = 5_000;
const EMPTY_GITHUB_SYNC_AT = new Date(0).toISOString();
const githubSyncCache = new Map<
  string,
  {
    expiresAtMs: number;
    hasValue: boolean;
    payload: GitHubSyncPayload;
    refreshPromise: Promise<void> | null;
  }
>();
const textDecoder = new TextDecoder();

export interface SessionManagerLike {
  listProjects(): ProjectMetadata[];
  selectProject(path: string): ProjectMetadata;
  updateProject(projectId: string, input: UpdateProjectRequest): ProjectMetadata;
  deleteProject(projectId: string): boolean;
  getProject(projectId: string): ProjectMetadata | null;
  listSessions(projectId: string): SessionMetadata[];
  listAllSessions(): SessionMetadata[];
  listImportWorktreeCandidates(projectId: string): ListImportWorktreeCandidatesResult;
  importWorktreeSessions(projectId: string, request?: ImportWorktreeSessionsRequest): ImportWorktreeSessionsResult;
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
    tmuxSocketName: envWithLegacy("BERM_TMUX_SOCKET", "COMMAND_CENTER_TMUX_SOCKET"),
    registryPath: envWithLegacy("BERM_REGISTRY_PATH", "COMMAND_CENTER_REGISTRY_PATH"),
  });
}

function envWithLegacy(currentName: string, legacyName: string): string | undefined {
  return Bun.env[currentName] ?? Bun.env[legacyName] ?? undefined;
}

export function buildHealthResponse(): Response {
  return Response.json({
    ok: true,
    now: new Date().toISOString(),
  });
}

export function buildVersionResponse(): Response {
  return Response.json({ version, commitHash });
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
      'POSIX path of (choose folder with prompt "Select Berm Project")',
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

async function runCommand(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(args, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
      proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
    ]);

    return {
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
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

async function resolveSessionBranchNameAsync(session: SessionMetadata): Promise<string | null> {
  if (session.branchName && session.branchName.trim().length > 0) {
    return session.branchName.trim();
  }

  const branchResult = await runCommand(
    ["git", "-C", session.workspacePath, "rev-parse", "--abbrev-ref", "HEAD"],
    session.workspacePath,
  );
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

async function buildGitHubSyncForSessionAsync(session: SessionMetadata): Promise<GitHubSessionSyncItem> {
  const branchName = await resolveSessionBranchNameAsync(session);
  if (!branchName) {
    return {
      sessionId: session.id,
      branchName: null,
      pr: null,
      ci: null,
      source: "none",
    };
  }

  const ghResult = await runCommand(
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

function getGitHubSyncCacheEntry(projectId: string) {
  const existing = githubSyncCache.get(projectId);
  if (existing) {
    return existing;
  }

  const created = {
    expiresAtMs: 0,
    hasValue: false,
    payload: {
      sessions: [],
      syncedAt: EMPTY_GITHUB_SYNC_AT,
    },
    refreshPromise: null as Promise<void> | null,
  };
  githubSyncCache.set(projectId, created);
  return created;
}

async function refreshGitHubSyncCache(manager: SessionManagerLike, projectId: string): Promise<void> {
  const entry = getGitHubSyncCacheEntry(projectId);
  if (entry.refreshPromise) {
    return entry.refreshPromise;
  }

  const refreshPromise = (async () => {
    try {
      const sessions = manager.listSessions(projectId);
      const items: GitHubSessionSyncItem[] = [];
      for (const session of sessions) {
        items.push(await buildGitHubSyncForSessionAsync(session));
      }

      const activeEntry = githubSyncCache.get(projectId);
      if (!activeEntry) {
        return;
      }

      activeEntry.hasValue = true;
      activeEntry.expiresAtMs = Date.now() + GITHUB_SYNC_CACHE_TTL_MS;
      activeEntry.payload = {
        sessions: items,
        syncedAt: new Date().toISOString(),
      };
    } catch {
      const activeEntry = githubSyncCache.get(projectId);
      if (!activeEntry) {
        return;
      }

      activeEntry.expiresAtMs = Date.now() + GITHUB_SYNC_FAILURE_RETRY_MS;
    }
  })().finally(() => {
    const activeEntry = githubSyncCache.get(projectId);
    if (activeEntry?.refreshPromise === refreshPromise) {
      activeEntry.refreshPromise = null;
    }
  });

  entry.refreshPromise = refreshPromise;
  return refreshPromise;
}

function buildGitHubSyncResponse(manager: SessionManagerLike, projectId: string): GitHubSyncResponse {
  const nowMs = Date.now();
  const entry = getGitHubSyncCacheEntry(projectId);
  const isFresh = entry.hasValue && entry.expiresAtMs > nowMs;

  if (!isFresh && !entry.refreshPromise) {
    void refreshGitHubSyncCache(manager, projectId);
  }

  return {
    ...entry.payload,
    cached: entry.hasValue,
    refreshing: entry.refreshPromise !== null,
  };
}

export function createServerConfig(
  manager: SessionManagerLike,
  openProjectPicker: () => Response = pickProjectDirectory,
): ServerConfig {
  return {
    routes: {
      ...resolveAppRoutes(),
      "/api/health": () => buildHealthResponse(),
      "/api/version": () => buildVersionResponse(),
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
      "/api/sessions": {
        GET: () => {
          return Response.json({ sessions: manager.listAllSessions() });
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
      "/api/projects/:projectId/sessions/import-worktrees": {
        GET: (req: Bun.BunRequest<"/api/projects/:projectId/sessions/import-worktrees">) => {
          try {
            return Response.json(manager.listImportWorktreeCandidates(req.params.projectId));
          } catch (error) {
            return errorResponse(error);
          }
        },
        POST: async (req: Bun.BunRequest<"/api/projects/:projectId/sessions/import-worktrees">) => {
          try {
            const body = (await req.json().catch(() => ({}))) as {
              workspacePaths?: unknown;
            };

            const request: ImportWorktreeSessionsRequest = {
              workspacePaths: Array.isArray(body.workspacePaths)
                ? body.workspacePaths.filter((value): value is string => typeof value === "string")
                : undefined,
            };
            return Response.json(manager.importWorktreeSessions(req.params.projectId, request));
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
  const port = normalized.port ?? Number(envWithLegacy("BERM_PORT", "COMMAND_CENTER_PORT") ?? 3000);
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
  console.log(`Berm listening at ${server.url}`);
}
