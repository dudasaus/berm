import app from "../web/index.html";
import { serializeMessage, type ServerMessage } from "../shared/protocol";
import {
  TerminalSessionManager,
  isSessionManagerError,
  type SessionClient,
} from "./terminal-session";

type WebSocketData = {
  projectId: string;
  sessionId: string;
  clientId: string;
};

const manager = new TerminalSessionManager({
  tmuxSocketName: Bun.env.COMMAND_CENTER_TMUX_SOCKET ?? undefined,
  registryPath: Bun.env.COMMAND_CENTER_REGISTRY_PATH ?? undefined,
});

export function buildHealthResponse(): Response {
  return Response.json({
    ok: true,
    now: new Date().toISOString(),
  });
}

export function buildSessionResponse(
  sessionManager: TerminalSessionManager,
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
    return Response.json({ error: error.message, code: error.code }, { status: error.statusCode });
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

export function createServer(port = Number(Bun.env.PORT ?? 3000)) {
  const server = Bun.serve<WebSocketData>({
    port,
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
          return pickProjectDirectory();
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
            const body = (await req.json().catch(() => ({}))) as { name?: string };
            const name = typeof body.name === "string" ? body.name : undefined;
            const session = manager.createSession(req.params.projectId, name);
            return Response.json(session, { status: 201 });
          } catch (error) {
            return errorResponse(error);
          }
        },
      },
      "/api/projects/:projectId/sessions/:id": {
        GET: (req: Bun.BunRequest<"/api/projects/:projectId/sessions/:id">) =>
          buildSessionResponse(manager, req.params.projectId, req.params.id),
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
    },
    fetch(req, serverRef) {
      const url = new URL(req.url);
      if (url.pathname !== "/ws/terminal") {
        return new Response("Not Found", { status: 404 });
      }

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
    websocket: {
      data: {} as WebSocketData,
      open(ws) {
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
      message(ws, message) {
        manager.handleClientMessage(ws.data.projectId, ws.data.sessionId, ws.data.clientId, message);
      },
      close(ws) {
        manager.detachClient(ws.data.projectId, ws.data.sessionId, ws.data.clientId);
      },
    },
  });

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
