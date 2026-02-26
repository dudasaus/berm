import { afterEach, describe, expect, test } from "bun:test";

import { TerminalSessionManager } from "../../src/server/terminal-session";
import type { ServerMessage } from "../../src/shared/protocol";

const managers: TerminalSessionManager[] = [];
const createdSessions = new Set<string>();

function uniqueSessionName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function cleanupTmuxSession(sessionId: string) {
  Bun.spawnSync(["tmux", "kill-session", "-t", sessionId], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

afterEach(async () => {
  await Promise.all(managers.map((manager) => manager.shutdown()));
  managers.length = 0;

  for (const sessionId of createdSessions) {
    cleanupTmuxSession(sessionId);
  }
  createdSessions.clear();
});

async function waitFor(predicate: () => boolean, timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(50);
  }

  throw new Error(`Timed out after ${timeoutMs}ms`);
}

describe("TerminalSessionManager (tmux)", () => {
  test("creates, lists, and deletes tmux sessions", () => {
    const manager = new TerminalSessionManager();
    managers.push(manager);
    if (!manager.isTmuxAvailable()) {
      return;
    }

    const sessionId = uniqueSessionName("cc-create");
    createdSessions.add(sessionId);

    const created = manager.createSession(sessionId);
    expect(created.id).toBe(sessionId);

    const listed = manager.listSessions();
    expect(listed.some((session) => session.id === sessionId)).toBe(true);

    const deleted = manager.deleteSession(sessionId);
    expect(deleted).toBe(true);
    createdSessions.delete(sessionId);

    expect(manager.hasSession(sessionId)).toBe(false);
  });

  test("attaches multiple clients to same tmux session, handles input, resize, and reset", async () => {
    const manager = new TerminalSessionManager();
    managers.push(manager);
    if (!manager.isTmuxAvailable()) {
      return;
    }

    const sessionId = uniqueSessionName("cc-attach");
    createdSessions.add(sessionId);
    manager.createSession(sessionId);

    const receivedA: ServerMessage[] = [];
    const receivedB: ServerMessage[] = [];

    manager.attachClient(sessionId, {
      id: "client-a",
      send(message) {
        receivedA.push(message);
      },
    });

    manager.attachClient(sessionId, {
      id: "client-b",
      send(message) {
        receivedB.push(message);
      },
    });

    await waitFor(() => receivedA.some((message) => message.type === "status" && message.state === "ready"));
    await waitFor(() => receivedB.some((message) => message.type === "status" && message.state === "ready"));

    const token = `__TMUX_MULTI_${Date.now()}__`;
    manager.handleClientMessage(sessionId, "client-a", { type: "input", data: `echo ${token}\n` });

    await waitFor(() => receivedA.some((message) => message.type === "output" && message.data.includes(token)));
    await waitFor(() => receivedB.some((message) => message.type === "output" && message.data.includes(token)));

    manager.handleClientMessage(sessionId, "client-a", { type: "resize", cols: 111, rows: 34 });
    const metadataAfterResize = manager.getSessionMetadata(sessionId);
    expect(metadataAfterResize?.cols).toBe(111);
    expect(metadataAfterResize?.rows).toBe(34);

    const readyCountBeforeReset = receivedA.filter((message) => message.type === "status" && message.state === "ready").length;
    manager.handleClientMessage(sessionId, "client-a", { type: "reset" });

    await waitFor(() => {
      const readyCountAfterReset = receivedA.filter((message) => message.type === "status" && message.state === "ready").length;
      return readyCountAfterReset > readyCountBeforeReset;
    });

    manager.detachClient(sessionId, "client-a");
    manager.detachClient(sessionId, "client-b");

    manager.deleteSession(sessionId);
    createdSessions.delete(sessionId);
  });
});
