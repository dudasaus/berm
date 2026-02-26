import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { createServerConfig, type SessionManagerLike } from "../../src/server/index";
import {
  TerminalSessionManager,
  type CreateSessionRequest,
  type ProjectMetadata,
  type SessionClient,
  type SessionMetadata,
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

  constructor() {
    const project: ProjectMetadata = {
      id: "p1",
      name: "project-one",
      path: "/tmp/project-one",
      createdAt: nowIso(),
      lastUsedAt: nowIso(),
      worktreeEnabled: false,
      worktreeParentPath: null,
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
    };
    this.projects.set(project.id, project);
    return project;
  }

  updateProject(projectId: string, input: { worktreeEnabled?: boolean; worktreeParentPath?: string | null }): ProjectMetadata {
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

  createSession(projectId: string, request?: CreateSessionRequest): SessionMetadata {
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
    };
    this.sessions.set(sessionKey(projectId, sessionId), metadata);
    return metadata;
  }

  deleteSession(projectId: string, sessionId: string): boolean {
    return this.sessions.delete(sessionKey(projectId, sessionId));
  }

  hasSession(projectId: string, sessionId: string): boolean {
    return this.sessions.has(sessionKey(projectId, sessionId));
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

    const createWorktreeResponse = await (routes["/api/projects/:projectId/sessions"] as {
      POST: (req: Bun.BunRequest<"/api/projects/:projectId/sessions">) => Promise<Response>;
    }).POST(
      makeRequest<"/api/projects/:projectId/sessions">(
        { projectId: "p1" },
        { mode: "worktree", branchName: "feature/testing" },
      ),
    );
    expect(createWorktreeResponse.status).toBe(201);

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

    const noParamsResponse = config.fetch(new Request("http://localhost/ws/terminal"), {
      upgrade: () => true,
    });
    if (!noParamsResponse) {
      throw new Error("expected a response for missing params");
    }
    expect(noParamsResponse.status).toBe(400);

    const missingSessionResponse = config.fetch(
      new Request("http://localhost/ws/terminal?projectId=p1"),
      {
        upgrade: () => true,
      },
    );
    if (!missingSessionResponse) {
      throw new Error("expected a response for missing sessionId");
    }
    expect(missingSessionResponse.status).toBe(400);

    const unknownSessionResponse = config.fetch(
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
    const upgradedResponse = config.fetch(
      new Request("http://localhost/ws/terminal?projectId=p1&sessionId=live"),
      {
        upgrade: (_req: Request, data: { data: unknown }) => {
          upgradedData = data;
          return true;
        },
      },
    );
    expect(upgradedResponse).toBeUndefined();
    expect(upgradedData).not.toBeNull();

    const upgradeFailedResponse = config.fetch(
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
    const registryPath = `/tmp/command-center-index-routes-${suffix}.json`;
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
