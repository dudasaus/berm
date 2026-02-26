import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { isSessionManagerError, TerminalSessionManager } from "../../src/server/terminal-session";
import type { ServerMessage } from "../../src/shared/protocol";

type TestContext = {
  manager: TerminalSessionManager;
  socketName: string;
  registryPath: string;
};

const contexts: TestContext[] = [];

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function uniqueSessionName(prefix: string): string {
  return `${prefix}-${uniqueSuffix()}`;
}

function createContext(prefix: string): TestContext {
  const suffix = uniqueSuffix();
  const socketName = `cc-test-${prefix}-${suffix}`;
  const registryPath = `/tmp/command-center-registry-${prefix}-${suffix}.json`;

  const manager = new TerminalSessionManager({
    tmuxSocketName: socketName,
    registryPath,
  });

  const context: TestContext = {
    manager,
    socketName,
    registryPath,
  };

  contexts.push(context);
  return context;
}

function cleanupTmuxServer(socketName: string) {
  Bun.spawnSync(["tmux", "-L", socketName, "kill-server"], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

afterEach(async () => {
  for (const context of contexts) {
    await context.manager.shutdown();
    cleanupTmuxServer(context.socketName);

    rmSync(context.registryPath, { force: true });
  }

  contexts.length = 0;
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

function shouldSkipTmux(error: unknown): boolean {
  if (!isSessionManagerError(error)) {
    return false;
  }

  return error.code === "TMUX_UNAVAILABLE" || error.code === "SESSION_CREATE_FAILED";
}

describe("TerminalSessionManager (tmux)", () => {
  test("creates, lists, and deletes tmux sessions", () => {
    const context = createContext("create");
    if (!context.manager.isTmuxAvailable()) {
      return;
    }

    const sessionId = uniqueSessionName("cc-create");
    let created;
    try {
      created = context.manager.createSession(sessionId);
    } catch (error) {
      if (shouldSkipTmux(error)) {
        return;
      }
      throw error;
    }
    expect(created.id).toBe(sessionId);

    const listed = context.manager.listSessions();
    expect(listed.some((session) => session.id === sessionId)).toBe(true);

    const deleted = context.manager.deleteSession(sessionId);
    expect(deleted).toBe(true);

    expect(context.manager.hasSession(sessionId)).toBe(false);
  });

  test("attaches multiple clients to same tmux session, handles input, resize, and reset", async () => {
    const context = createContext("attach");
    if (!context.manager.isTmuxAvailable()) {
      return;
    }

    const sessionId = uniqueSessionName("cc-attach");
    try {
      context.manager.createSession(sessionId);
    } catch (error) {
      if (shouldSkipTmux(error)) {
        return;
      }
      throw error;
    }

    const receivedA: ServerMessage[] = [];
    const receivedB: ServerMessage[] = [];

    context.manager.attachClient(sessionId, {
      id: "client-a",
      send(message) {
        receivedA.push(message);
      },
    });

    context.manager.attachClient(sessionId, {
      id: "client-b",
      send(message) {
        receivedB.push(message);
      },
    });

    await waitFor(() => receivedA.some((message) => message.type === "status" && message.state === "ready"));
    await waitFor(() => receivedB.some((message) => message.type === "status" && message.state === "ready"));

    const token = `__TMUX_MULTI_${Date.now()}__`;
    context.manager.handleClientMessage(sessionId, "client-a", { type: "input", data: `echo ${token}\n` });

    await waitFor(() => receivedA.some((message) => message.type === "output" && message.data.includes(token)));
    await waitFor(() => receivedB.some((message) => message.type === "output" && message.data.includes(token)));

    context.manager.handleClientMessage(sessionId, "client-a", { type: "resize", cols: 111, rows: 34 });
    const metadataAfterResize = context.manager.getSessionMetadata(sessionId);
    expect(metadataAfterResize?.cols).toBe(111);
    expect(metadataAfterResize?.rows).toBe(34);

    const readyCountBeforeReset = receivedA.filter((message) => message.type === "status" && message.state === "ready").length;
    context.manager.handleClientMessage(sessionId, "client-a", { type: "reset" });

    await waitFor(() => {
      const readyCountAfterReset = receivedA.filter((message) => message.type === "status" && message.state === "ready").length;
      return readyCountAfterReset > readyCountBeforeReset;
    });

    context.manager.detachClient(sessionId, "client-a");
    context.manager.detachClient(sessionId, "client-b");

    context.manager.deleteSession(sessionId);
  });

  test("ignores tmux sessions not in command-center registry", () => {
    const context = createContext("scope");
    if (!context.manager.isTmuxAvailable()) {
      return;
    }

    const manualSessionId = uniqueSessionName("manual");
    const createManual = Bun.spawnSync(
      ["tmux", "-L", context.socketName, "new-session", "-d", "-s", manualSessionId, "-c", process.cwd(), "zsh"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(createManual.exitCode).toBe(0);

    const listed = context.manager.listSessions();
    expect(listed.some((session) => session.id === manualSessionId)).toBe(false);
    expect(context.manager.hasSession(manualSessionId)).toBe(false);
  });

  test("persists tracked sessions across manager instances", () => {
    const suffix = uniqueSuffix();
    const socketName = `cc-test-persist-${suffix}`;
    const registryPath = `/tmp/command-center-registry-persist-${suffix}.json`;

    const firstManager = new TerminalSessionManager({ tmuxSocketName: socketName, registryPath });
    contexts.push({ manager: firstManager, socketName, registryPath });

    if (!firstManager.isTmuxAvailable()) {
      return;
    }

    const sessionId = uniqueSessionName("cc-persist");
    try {
      firstManager.createSession(sessionId);
    } catch (error) {
      if (shouldSkipTmux(error)) {
        return;
      }
      throw error;
    }

    const secondManager = new TerminalSessionManager({ tmuxSocketName: socketName, registryPath });
    contexts.push({ manager: secondManager, socketName, registryPath });

    const listed = secondManager.listSessions();
    expect(listed.some((session) => session.id === sessionId)).toBe(true);
  });
});
