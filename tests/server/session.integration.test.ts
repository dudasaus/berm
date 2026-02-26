import { afterEach, describe, expect, test } from "bun:test";

import { TerminalSessionManager } from "../../src/server/terminal-session";
import type { ServerMessage } from "../../src/shared/protocol";

const managers: TerminalSessionManager[] = [];

afterEach(async () => {
  await Promise.all(managers.map((manager) => manager.shutdown()));
  managers.length = 0;
});

async function waitFor(predicate: () => boolean, timeoutMs = 6_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(50);
  }

  throw new Error(`Timed out after ${timeoutMs}ms`);
}

describe("TerminalSessionManager", () => {
  test("spawns shell, forwards output, supports resize and reset", async () => {
    const manager = new TerminalSessionManager({ reconnectGraceMs: 100 });
    managers.push(manager);

    const received: ServerMessage[] = [];
    manager.attachClient("session-1", {
      id: "client-1",
      send(message) {
        received.push(message);
      },
    });

    await waitFor(() => received.some((message) => message.type === "status" && message.state === "ready"));

    manager.handleClientMessage("session-1", { type: "input", data: "echo __BUN_SESSION_TEST__\n" });

    await waitFor(() =>
      received.some((message) => message.type === "output" && message.data.includes("__BUN_SESSION_TEST__")),
    );

    manager.handleClientMessage("session-1", { type: "resize", cols: 110, rows: 33 });
    const resized = manager.getSessionMetadata("session-1");
    expect(resized?.cols).toBe(110);
    expect(resized?.rows).toBe(33);

    const readyCountBeforeReset = received.filter((message) => message.type === "status" && message.state === "ready").length;
    manager.handleClientMessage("session-1", { type: "reset" });

    await waitFor(() => {
      const readyCountAfterReset = received.filter((message) => message.type === "status" && message.state === "ready").length;
      return readyCountAfterReset > readyCountBeforeReset;
    });

    manager.detachClient("session-1", "client-1");
  });
});
