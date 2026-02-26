import { describe, expect, test } from "bun:test";

import { buildHealthResponse, buildSessionResponse } from "../../src/server/index";
import { TerminalSessionManager } from "../../src/server/terminal-session";

describe("HTTP response builders", () => {
  test("health response returns ok payload", async () => {
    const response = buildHealthResponse();
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { ok: boolean; now: string };
    expect(payload.ok).toBe(true);
    expect(typeof payload.now).toBe("string");
  });

  test("session response returns 404 for unknown session", async () => {
    const manager = new TerminalSessionManager();
    const response = buildSessionResponse(manager, "unknown");

    expect(response.status).toBe(404);
    await manager.shutdown();
  });
});
