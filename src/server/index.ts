import app from "../web/index.html";
import { serializeMessage, type ServerMessage } from "../shared/protocol";
import {
  TerminalSessionManager,
  isSessionManagerError,
  type SessionClient,
} from "./terminal-session";

type WebSocketData = {
  sessionId: string;
  clientId: string;
};

const manager = new TerminalSessionManager();

export function buildHealthResponse(): Response {
  return Response.json({
    ok: true,
    now: new Date().toISOString(),
  });
}

export function buildSessionResponse(sessionManager: TerminalSessionManager, sessionId: string): Response {
  const metadata = sessionManager.getSessionMetadata(sessionId);
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

export function createServer(port = Number(Bun.env.PORT ?? 3000)) {
  const server = Bun.serve<WebSocketData>({
    port,
    routes: {
      "/": app,
      "/api/health": () => buildHealthResponse(),
      "/api/session/:id": (req: Bun.BunRequest<"/api/session/:id">) => buildSessionResponse(manager, req.params.id),
      "/api/sessions": {
        GET: () => {
          return Response.json({ sessions: manager.listSessions() });
        },
        POST: async (req: Request) => {
          try {
            const body = (await req.json().catch(() => ({}))) as { name?: string };
            const name = typeof body.name === "string" ? body.name : undefined;
            const session = manager.createSession(name);
            return Response.json(session, { status: 201 });
          } catch (error) {
            return errorResponse(error);
          }
        },
      },
      "/api/sessions/:id": {
        GET: (req: Bun.BunRequest<"/api/sessions/:id">) => buildSessionResponse(manager, req.params.id),
        DELETE: (req: Bun.BunRequest<"/api/sessions/:id">) => {
          try {
            const deleted = manager.deleteSession(req.params.id);
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

      const sessionId = url.searchParams.get("sessionId")?.trim();
      if (!sessionId) {
        return Response.json({ error: "sessionId query parameter is required" }, { status: 400 });
      }

      if (!manager.hasSession(sessionId)) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      const upgraded = serverRef.upgrade(req, {
        data: {
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

        const attached = manager.attachClient(ws.data.sessionId, client);
        if (!attached) {
          ws.send(serializeMessage({ type: "session_not_found", sessionId: ws.data.sessionId }));
          ws.close(4004, "Session not found");
        }
      },
      message(ws, message) {
        manager.handleClientMessage(ws.data.sessionId, ws.data.clientId, message);
      },
      close(ws) {
        manager.detachClient(ws.data.sessionId, ws.data.clientId);
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
