import app from "../web/index.html";
import { serializeMessage, type ServerMessage } from "../shared/protocol";
import { TerminalSessionManager, type SessionClient } from "./terminal-session";

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

export function createServer(port = Number(Bun.env.PORT ?? 3000)) {
  const clients = new Map<string, SessionClient>();

  const server = Bun.serve<WebSocketData>({
    port,
    routes: {
      "/": app,
      "/api/health": () => buildHealthResponse(),
      "/api/session/:id": (req: Bun.BunRequest<"/api/session/:id">) => buildSessionResponse(manager, req.params.id),
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

        clients.set(ws.data.clientId, client);
        manager.attachClient(ws.data.sessionId, client);
      },
      message(ws, message) {
        manager.handleClientMessage(ws.data.sessionId, message);
      },
      close(ws) {
        clients.delete(ws.data.clientId);
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
