import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { createServerConfig, type SessionManagerLike } from "../../src/server/index";
import {
  type CreateSessionResult,
  TerminalSessionManager,
  type CreateSessionRequest,
  type ImportWorktreeSessionsRequest,
  type ListImportWorktreeCandidatesResult,
  type ImportWorktreeSessionsResult,
  type ProjectMetadata,
  type ResolveWorktreeHookDecisionRequest,
  type ResolveWorktreeHookDecisionResult,
  type SessionClient,
  type SessionMetadata,
  type UpdateProjectRequest,
  type UpdateSessionLifecycleRequest,
} from "../../src/server/terminal-session";
import { parseServerMessage } from "../../src/shared/protocol";

function nowIso(): string {
  return new Date().toISOString();
}

function sessionKey(projectId: string, sessionId: string): string {
  return `${projectId}::${sessionId}`;
}

function makeRequest<T extends string>(params: Record<string, string>, body?: unknown): Bun.BunRequest<T> {
  return {
    params,
    json: async () => body ?? {},
  } as unknown as Bun.BunRequest<T>;
}

class FakeSessionManager implements SessionManagerLike {
  projects = new Map<string, ProjectMetadata>();
  sessions = new Map<string, SessionMetadata>();
  handledMessages: Array<{ projectId: string; sessionId: string; clientId: string; rawMessage: unknown }> = [];
  detachEvents: Array<{ projectId: string; sessionId: string; clientId: string }> = [];
  attachShouldFail = false;
  pendingHookFailures = new Map<string, { projectId: string; branchName: string; workspacePath: string }>();

  constructor() {
    const project: ProjectMetadata = {
      id: "p1",
      name: "project-one",
      path: "/tmp/project-one",
      createdAt: nowIso(),
      lastUsedAt: nowIso(),
      worktreeEnabled: false,
      worktreeParentPath: null,
      worktreeHookCommand: null,
      worktreeHookTimeoutMs: 15_000,
    };
    this.projects.set(project.id, project);
  }

  listProjects(): ProjectMetadata[] {
    return [...this.projects.values()];
  }

  selectProject(path: string): ProjectMetadata {
    const project: ProjectMetadata = {
      id: `p-${this.projects.size + 1}`,
      name: path.split("/").filter(Boolean).at(-1) ?? "project",
      path,
      createdAt: nowIso(),
      lastUsedAt: nowIso(),
      worktreeEnabled: false,
      worktreeParentPath: null,
      worktreeHookCommand: null,
      worktreeHookTimeoutMs: 15_000,
    };
    this.projects.set(project.id, project);
    return project;
  }

  updateProject(projectId: string, input: UpdateProjectRequest): ProjectMetadata {
    if (projectId === "explode") {
      throw new Error("synthetic failure");
    }

    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error("project missing");
    }

    const updated: ProjectMetadata = {
      ...project,
      worktreeEnabled: input.worktreeEnabled ?? project.worktreeEnabled,
      worktreeParentPath:
        typeof input.worktreeParentPath === "undefined" ? project.worktreeParentPath : input.worktreeParentPath,
      worktreeHookCommand:
        typeof input.worktreeHookCommand === "undefined"
          ? project.worktreeHookCommand
          : input.worktreeHookCommand,
      worktreeHookTimeoutMs:
        typeof input.worktreeHookTimeoutMs === "number" ? input.worktreeHookTimeoutMs : project.worktreeHookTimeoutMs,
      lastUsedAt: nowIso(),
    };
    this.projects.set(projectId, updated);
    return updated;
  }

  deleteProject(projectId: string): boolean {
    const deleted = this.projects.delete(projectId);
    for (const [key, session] of this.sessions.entries()) {
      if (session.projectId === projectId) {
        this.sessions.delete(key);
      }
    }
    return deleted;
  }

  getProject(projectId: string): ProjectMetadata | null {
    return this.projects.get(projectId) ?? null;
  }

  listSessions(projectId: string): SessionMetadata[] {
    return [...this.sessions.values()].filter((session) => session.projectId === projectId);
  }

  listImportWorktreeCandidates(projectId: string): ListImportWorktreeCandidatesResult {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error("project missing");
    }

    return {
      candidates: [
        {
          workspacePath: `/tmp/worktree/importable-1`,
          branchName: "importable-1",
          status: "importable",
        },
        {
          workspacePath: `${project.path}-main`,
          branchName: "main",
          status: "main_worktree",
        },
      ],
    };
  }

  importWorktreeSessions(projectId: string, request?: ImportWorktreeSessionsRequest): ImportWorktreeSessionsResult {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error("project missing");
    }

    const requested = new Set((request?.workspacePaths ?? []).map((value) => value.trim()).filter(Boolean));
    const shouldImport = requested.size === 0 || requested.has("/tmp/worktree/importable-1");
    if (!shouldImport) {
      return {
        imported: [],
        skipped: [],
        failed: [],
      };
    }

    const importedSession = this.createSession(projectId, {
      mode: "worktree",
      branchName: `imported-${this.sessions.size + 1}`,
    }).session;

    return {
      imported: [importedSession],
      skipped: [
        {
          workspacePath: `${project.path}-main`,
          branchName: "main",
          reason: "main_worktree",
        },
      ],
      failed: [],
    };
  }

  createSession(projectId: string, request?: CreateSessionRequest): CreateSessionResult {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error("project missing");
    }

    const mode = request?.mode === "worktree" ? "worktree" : "main";
    const sessionId =
      mode === "worktree"
        ? request && request.mode === "worktree"
          ? request.branchName
          : `auto-${this.sessions.size + 1}`
        : request && request.mode !== "worktree" && request.name?.trim()
          ? request.name.trim()
          : `auto-${this.sessions.size + 1}`;

    const metadata: SessionMetadata = {
      id: sessionId,
      projectId,
      state: "ready",
      connected: false,
      cols: 120,
      rows: 34,
      pid: null,
      createdAt: nowIso(),
      lastActiveAt: nowIso(),
      attachedClients: 0,
      workspaceType: mode,
      workspacePath: mode === "worktree" ? `/tmp/worktree/${sessionId}` : project.path,
      branchName: mode === "worktree" ? sessionId : null,
      lifecycleState: "planning",
      lifecycleUpdatedAt: nowIso(),
    };
    this.sessions.set(sessionKey(projectId, sessionId), metadata);
    const hook =
      mode === "worktree"
        ? {
            command: "echo fake-hook",
            stdout: "",
            stderr: "",
            exitCode: 0,
            timedOut: false,
            succeeded: true,
          }
        : null;
    return { session: metadata, hook };
  }

  deleteSession(projectId: string, sessionId: string): boolean {
    return this.sessions.delete(sessionKey(projectId, sessionId));
  }

  hasSession(projectId: string, sessionId: string): boolean {
    return this.sessions.has(sessionKey(projectId, sessionId));
  }

  resolveWorktreeHookDecision(
    projectId: string,
    request: ResolveWorktreeHookDecisionRequest,
  ): ResolveWorktreeHookDecisionResult {
    const pending = this.pendingHookFailures.get(request.decisionToken);
    if (!pending || pending.projectId !== projectId) {
      throw new Error("pending decision not found");
    }

    if (request.decision === "abort") {
      this.pendingHookFailures.delete(request.decisionToken);
      return { action: "abort", ok: true, cleaned: true };
    }

    const session = this.createSession(projectId, { mode: "worktree", branchName: pending.branchName }).session;
    this.pendingHookFailures.delete(request.decisionToken);
    return { action: "continue", session };
  }

  updateSessionLifecycleState(projectId: string, sessionId: string, input: UpdateSessionLifecycleRequest): SessionMetadata {
    const key = sessionKey(projectId, sessionId);
    const session = this.sessions.get(key);
    if (!session) {
      throw new Error("session missing");
    }

    const updated: SessionMetadata = {
      ...session,
      lifecycleState: input.lifecycleState,
      lifecycleUpdatedAt: nowIso(),
    };
    this.sessions.set(key, updated);
    return updated;
  }

  attachClient(projectId: string, sessionId: string, _client: SessionClient): SessionMetadata | null {
    if (this.attachShouldFail) {
      return null;
    }

    return this.sessions.get(sessionKey(projectId, sessionId)) ?? null;
  }

  handleClientMessage(projectId: string, sessionId: string, clientId: string, rawMessage: unknown): void {
    this.handledMessages.push({ projectId, sessionId, clientId, rawMessage });
  }

  detachClient(projectId: string, sessionId: string, clientId: string): void {
    this.detachEvents.push({ projectId, sessionId, clientId });
  }

  getSessionMetadata(projectId: string, sessionId: string): SessionMetadata | null {
    return this.sessions.get(sessionKey(projectId, sessionId)) ?? null;
  }

  async shutdown(): Promise<void> {}
}

describe("server config routes and websocket", () => {
  test("handles project and session CRUD handlers", async () => {
    const manager = new FakeSessionManager();
    const config = createServerConfig(manager, () => Response.json({ path: "/tmp/picked-project" }));
    const routes = config.routes as Record<string, unknown>;

    const healthResponse = (routes["/api/health"] as () => Response)();
    expect(healthResponse.status).toBe(200);

    const projectsResponse = (routes["/api/projects"] as { GET: () => Response }).GET();
    expect(projectsResponse.status).toBe(200);

    const selectResponse = await (routes["/api/projects/select"] as { POST: (req: Request) => Promise<Response> }).POST(
      new Request("http://localhost/api/projects/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/tmp/alpha-project" }),
      }),
    );
    expect(selectResponse.status).toBe(201);

    const pickResponse = (routes["/api/projects/pick"] as { POST: () => Response }).POST();
    expect(pickResponse.status).toBe(200);

    const updateResponse = await (routes["/api/projects/:id"] as {
      PATCH: (req: Bun.BunRequest<"/api/projects/:id">) => Promise<Response>;
    }).PATCH(
      makeRequest<"/api/projects/:id">(
        { id: "p1" },
        { worktreeEnabled: true, worktreeParentPath: "/tmp/wt-parent" },
      ),
    );
    expect(updateResponse.status).toBe(200);

    const updateErrorResponse = await (routes["/api/projects/:id"] as {
      PATCH: (req: Bun.BunRequest<"/api/projects/:id">) => Promise<Response>;
    }).PATCH(makeRequest<"/api/projects/:id">({ id: "explode" }, { worktreeEnabled: true }));
    expect(updateErrorResponse.status).toBe(500);

    const missingSessionsResponse = (routes["/api/projects/:projectId/sessions"] as {
      GET: (req: Bun.BunRequest<"/api/projects/:projectId/sessions">) => Response;
    }).GET(makeRequest<"/api/projects/:projectId/sessions">({ projectId: "missing" }));
    expect(missingSessionsResponse.status).toBe(404);

    const createMainResponse = await (routes["/api/projects/:projectId/sessions"] as {
      POST: (req: Bun.BunRequest<"/api/projects/:projectId/sessions">) => Promise<Response>;
    }).POST(makeRequest<"/api/projects/:projectId/sessions">({ projectId: "p1" }, { mode: "main", name: "main-1" }));
    expect(createMainResponse.status).toBe(201);
    const createMainPayload = (await createMainResponse.json()) as {
      session?: { id?: string };
      hook?: unknown;
    };
    expect(createMainPayload.session?.id).toBe("main-1");
    expect(createMainPayload.hook ?? null).toBeNull();

    const createWorktreeResponse = await (routes["/api/projects/:projectId/sessions"] as {
      POST: (req: Bun.BunRequest<"/api/projects/:projectId/sessions">) => Promise<Response>;
    }).POST(
      makeRequest<"/api/projects/:projectId/sessions">(
        { projectId: "p1" },
        { mode: "worktree", branchName: "feature/testing" },
      ),
    );
    expect(createWorktreeResponse.status).toBe(201);
    const createWorktreePayload = (await createWorktreeResponse.json()) as {
      session?: { id?: string };
      hook?: { command?: string; succeeded?: boolean } | null;
    };
    expect(createWorktreePayload.session?.id).toBe("feature/testing");
    expect(createWorktreePayload.hook?.command).toBe("echo fake-hook");
    expect(createWorktreePayload.hook?.succeeded).toBe(true);

    const importWorktreeCandidatesResponse = (routes["/api/projects/:projectId/sessions/import-worktrees"] as {
      GET: (req: Bun.BunRequest<"/api/projects/:projectId/sessions/import-worktrees">) => Response;
    }).GET(makeRequest<"/api/projects/:projectId/sessions/import-worktrees">({ projectId: "p1" }));
    expect(importWorktreeCandidatesResponse.status).toBe(200);
    const importWorktreeCandidatesPayload = (await importWorktreeCandidatesResponse.json()) as ListImportWorktreeCandidatesResult;
    expect(importWorktreeCandidatesPayload.candidates).toHaveLength(2);

    const importWorktreesResponse = await (routes["/api/projects/:projectId/sessions/import-worktrees"] as {
      POST: (req: Bun.BunRequest<"/api/projects/:projectId/sessions/import-worktrees">) => Promise<Response>;
    }).POST(
      makeRequest<"/api/projects/:projectId/sessions/import-worktrees">(
        { projectId: "p1" },
        { workspacePaths: ["/tmp/worktree/importable-1"] },
      ),
    );
    expect(importWorktreesResponse.status).toBe(200);
    const importWorktreesPayload = (await importWorktreesResponse.json()) as ImportWorktreeSessionsResult;
    expect(importWorktreesPayload.imported).toHaveLength(1);
    expect(importWorktreesPayload.skipped).toHaveLength(1);
    expect(importWorktreesPayload.failed).toHaveLength(0);

    manager.pendingHookFailures.set("hook-token-abort", {
      projectId: "p1",
      branchName: "feature/hook-abort",
      workspacePath: "/tmp/worktree/feature-hook-abort",
    });
    const resolveAbortResponse = await (routes["/api/projects/:projectId/sessions/worktree-hook-decision"] as {
      POST: (req: Bun.BunRequest<"/api/projects/:projectId/sessions/worktree-hook-decision">) => Promise<Response>;
    }).POST(
      makeRequest<"/api/projects/:projectId/sessions/worktree-hook-decision">(
        { projectId: "p1" },
        { decisionToken: "hook-token-abort", decision: "abort" },
      ),
    );
    expect(resolveAbortResponse.status).toBe(200);
    const resolveAbortPayload = (await resolveAbortResponse.json()) as { action: string; ok?: boolean };
    expect(resolveAbortPayload.action).toBe("abort");
    expect(resolveAbortPayload.ok).toBe(true);

    manager.pendingHookFailures.set("hook-token-continue", {
      projectId: "p1",
      branchName: "feature/hook-continue",
      workspacePath: "/tmp/worktree/feature-hook-continue",
    });
    const resolveContinueResponse = await (routes["/api/projects/:projectId/sessions/worktree-hook-decision"] as {
      POST: (req: Bun.BunRequest<"/api/projects/:projectId/sessions/worktree-hook-decision">) => Promise<Response>;
    }).POST(
      makeRequest<"/api/projects/:projectId/sessions/worktree-hook-decision">(
        { projectId: "p1" },
        { decisionToken: "hook-token-continue", decision: "continue" },
      ),
    );
    expect(resolveContinueResponse.status).toBe(201);
    const resolveContinuePayload = (await resolveContinueResponse.json()) as {
      action: string;
      session?: { id: string };
    };
    expect(resolveContinuePayload.action).toBe("continue");
    expect(resolveContinuePayload.session?.id).toBe("feature/hook-continue");

    const listSessionsResponse = (routes["/api/projects/:projectId/sessions"] as {
      GET: (req: Bun.BunRequest<"/api/projects/:projectId/sessions">) => Response;
    }).GET(makeRequest<"/api/projects/:projectId/sessions">({ projectId: "p1" }));
    expect(listSessionsResponse.status).toBe(200);
    const sessionsPayload = (await listSessionsResponse.json()) as { sessions: SessionMetadata[] };
    expect(sessionsPayload.sessions.length).toBeGreaterThanOrEqual(2);

    const getSessionResponse = (routes["/api/projects/:projectId/sessions/:id"] as {
      GET: (req: Bun.BunRequest<"/api/projects/:projectId/sessions/:id">) => Response;
    }).GET(makeRequest<"/api/projects/:projectId/sessions/:id">({ projectId: "p1", id: "main-1" }));
    expect(getSessionResponse.status).toBe(200);

    const patchSessionResponse = await (routes["/api/projects/:projectId/sessions/:id"] as {
      PATCH: (req: Bun.BunRequest<"/api/projects/:projectId/sessions/:id">) => Promise<Response>;
    }).PATCH(
      makeRequest<"/api/projects/:projectId/sessions/:id">(
        { projectId: "p1", id: "main-1" },
        { lifecycleState: "in_review" },
      ),
    );
    expect(patchSessionResponse.status).toBe(200);
    const patchSessionPayload = (await patchSessionResponse.json()) as SessionMetadata;
    expect(patchSessionPayload.lifecycleState).toBe("in_review");

    const deleteSessionResponse = (routes["/api/projects/:projectId/sessions/:id"] as {
      DELETE: (req: Bun.BunRequest<"/api/projects/:projectId/sessions/:id">) => Response;
    }).DELETE(makeRequest<"/api/projects/:projectId/sessions/:id">({ projectId: "p1", id: "main-1" }));
    expect(deleteSessionResponse.status).toBe(200);

    const deleteMissingSessionResponse = (routes["/api/projects/:projectId/sessions/:id"] as {
      DELETE: (req: Bun.BunRequest<"/api/projects/:projectId/sessions/:id">) => Response;
    }).DELETE(makeRequest<"/api/projects/:projectId/sessions/:id">({ projectId: "p1", id: "missing" }));
    expect(deleteMissingSessionResponse.status).toBe(404);

    const deleteProjectResponse = (routes["/api/projects/:id"] as {
      DELETE: (req: Bun.BunRequest<"/api/projects/:id">) => Response;
    }).DELETE(makeRequest<"/api/projects/:id">({ id: "p1" }));
    expect(deleteProjectResponse.status).toBe(200);

    const deleteMissingProjectResponse = (routes["/api/projects/:id"] as {
      DELETE: (req: Bun.BunRequest<"/api/projects/:id">) => Response;
    }).DELETE(makeRequest<"/api/projects/:id">({ id: "p1" }));
    expect(deleteMissingProjectResponse.status).toBe(404);
  });

  test("handles websocket fetch validation and upgrade behavior", async () => {
    const manager = new FakeSessionManager();
    manager.createSession("p1", { mode: "main", name: "live" });
    const config = createServerConfig(manager);
    const routes = config.routes as Record<string, unknown>;
    const wsRoute = routes["/ws/terminal"] as (
      req: Request,
      server: { upgrade: (req: Request, data?: { data: unknown }) => boolean },
    ) => Response | undefined;

    const noParamsResponse = wsRoute(new Request("http://localhost/ws/terminal"), {
      upgrade: () => true,
    });
    if (!noParamsResponse) {
      throw new Error("expected a response for missing params");
    }
    expect(noParamsResponse.status).toBe(400);

    const missingSessionResponse = wsRoute(
      new Request("http://localhost/ws/terminal?projectId=p1"),
      {
        upgrade: () => true,
      },
    );
    if (!missingSessionResponse) {
      throw new Error("expected a response for missing sessionId");
    }
    expect(missingSessionResponse.status).toBe(400);

    const unknownSessionResponse = wsRoute(
      new Request("http://localhost/ws/terminal?projectId=p1&sessionId=missing"),
      {
        upgrade: () => true,
      },
    );
    if (!unknownSessionResponse) {
      throw new Error("expected a response for unknown session");
    }
    expect(unknownSessionResponse.status).toBe(404);

    let upgradedData: unknown = null;
    const upgradedResponse = wsRoute(
      new Request("http://localhost/ws/terminal?projectId=p1&sessionId=live"),
      {
        upgrade: (_req: Request, data?: { data: unknown }) => {
          if (!data) {
            return false;
          }
          upgradedData = data;
          return true;
        },
      },
    );
    expect(upgradedResponse).toBeUndefined();
    expect(upgradedData).not.toBeNull();

    const upgradeFailedResponse = wsRoute(
      new Request("http://localhost/ws/terminal?projectId=p1&sessionId=live"),
      {
        upgrade: () => false,
      },
    );
    expect(upgradeFailedResponse?.status).toBe(400);
  });

  test("handles websocket open/message/close lifecycle", () => {
    const manager = new FakeSessionManager();
    manager.createSession("p1", { mode: "main", name: "live" });
    const config = createServerConfig(manager);

    const sentPayloads: string[] = [];
    let closeCode: number | undefined;
    let closeReason: string | undefined;

    const ws = {
      data: {
        projectId: "p1",
        sessionId: "live",
        clientId: "client-1",
      },
      send(payload: string) {
        sentPayloads.push(payload);
      },
      close(code?: number, reason?: string) {
        closeCode = code;
        closeReason = reason;
      },
    };

    config.websocket.open(ws as never);
    expect(closeCode).toBeUndefined();
    expect(closeReason).toBeUndefined();

    config.websocket.message(ws as never, JSON.stringify({ type: "ping", ts: Date.now() }));
    expect(manager.handledMessages.length).toBe(1);
    expect(manager.handledMessages[0]?.clientId).toBe("client-1");

    config.websocket.close(ws as never);
    expect(manager.detachEvents.length).toBe(1);
    expect(manager.detachEvents[0]?.sessionId).toBe("live");

    expect(sentPayloads).toHaveLength(0);
  });

  test("sends session_not_found and closes websocket when attach fails", () => {
    const manager = new FakeSessionManager();
    manager.createSession("p1", { mode: "main", name: "live" });
    manager.attachShouldFail = true;
    const config = createServerConfig(manager);

    const sentPayloads: string[] = [];
    const closes: Array<{ code?: number; reason?: string }> = [];

    const ws = {
      data: {
        projectId: "p1",
        sessionId: "live",
        clientId: "client-2",
      },
      send(payload: string) {
        sentPayloads.push(payload);
      },
      close(code?: number, reason?: string) {
        closes.push({ code, reason });
      },
    };

    config.websocket.open(ws as never);
    expect(sentPayloads.length).toBe(1);
    expect(closes.length).toBe(1);

    const parsed = parseServerMessage(sentPayloads[0]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    expect(parsed.value.type).toBe("session_not_found");
    if (parsed.value.type === "session_not_found") {
      expect(parsed.value.sessionId).toBe("live");
    }
    expect(closes[0]?.code).toBe(4004);
  });

  test("returns session-manager errors from route handlers", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const registryPath = `/tmp/berm-index-routes-${suffix}.json`;
    const manager = new TerminalSessionManager({
      tmuxSocketName: `cc-index-routes-${suffix}`,
      registryPath,
    });
    const config = createServerConfig(manager, () => Response.json({ path: "/tmp/ignored" }));
    const routes = config.routes as Record<string, unknown>;

    try {
      const response = await (routes["/api/projects/select"] as { POST: (req: Request) => Promise<Response> }).POST(
        new Request("http://localhost/api/projects/select", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "relative/path" }),
        }),
      );

      expect(response.status).toBe(400);
      const payload = (await response.json()) as { code?: string; error?: string };
      expect(payload.code).toBe("PROJECT_PATH_INVALID");
      expect((payload.error ?? "").length).toBeGreaterThan(0);
    } finally {
      await manager.shutdown();
      rmSync(registryPath, { force: true });
    }
  });
});
