import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";

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
    const projectPath = `/tmp/command-center-http-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    mkdirSync(projectPath, { recursive: true });

    const manager = new TerminalSessionManager({
      tmuxSocketName: `cc-http-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      registryPath: `/tmp/command-center-http-registry-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`,
    });

    const project = manager.selectProject(projectPath);
    const response = buildSessionResponse(manager, project.id, "unknown");

    expect(response.status).toBe(404);
    await manager.shutdown();

    rmSync(projectPath, { recursive: true, force: true });
  });
});
