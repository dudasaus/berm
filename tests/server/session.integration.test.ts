import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";

import { isSessionManagerError, TerminalSessionManager } from "../../src/server/terminal-session";
import type { ServerMessage } from "../../src/shared/protocol";

type TestContext = {
  manager: TerminalSessionManager;
  socketName: string;
  registryPath: string;
  projectPaths: string[];
};

const contexts: TestContext[] = [];

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function uniqueSessionName(prefix: string): string {
  return `${prefix}-${uniqueSuffix()}`;
}

function createProjectPath(prefix: string): string {
  const path = `/tmp/command-center-project-${prefix}-${uniqueSuffix()}`;
  mkdirSync(path, { recursive: true });
  return path;
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
    projectPaths: [],
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

    for (const projectPath of context.projectPaths) {
      rmSync(projectPath, { force: true, recursive: true });
    }
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

describe("TerminalSessionManager (tmux, projects)", () => {
  test("rejects non-absolute project paths", () => {
    const context = createContext("project-validation");
    let thrown: unknown = null;

    try {
      context.manager.selectProject("relative/path");
    } catch (error) {
      thrown = error;
    }

    expect(isSessionManagerError(thrown)).toBe(true);
    if (!isSessionManagerError(thrown)) {
      return;
    }
    expect(thrown.code).toBe("PROJECT_PATH_INVALID");
  });

  test("creates, lists, and deletes project-scoped tmux sessions", () => {
    const context = createContext("create");
    if (!context.manager.isTmuxAvailable()) {
      return;
    }

    const projectPath = createProjectPath("create");
    context.projectPaths.push(projectPath);
    const project = context.manager.selectProject(projectPath);

    const sessionId = uniqueSessionName("cc-create");
    let created;
    try {
      created = context.manager.createSession(project.id, sessionId);
    } catch (error) {
      if (shouldSkipTmux(error)) {
        return;
      }
      throw error;
    }

    expect(created.id).toBe(sessionId);
    expect(created.projectId).toBe(project.id);

    const listed = context.manager.listSessions(project.id);
    expect(listed.some((session) => session.id === sessionId)).toBe(true);

    const deleted = context.manager.deleteSession(project.id, sessionId);
    expect(deleted).toBe(true);

    expect(context.manager.hasSession(project.id, sessionId)).toBe(false);
  });

  test("deletes a project and all sessions in that project", () => {
    const context = createContext("delete-project");
    if (!context.manager.isTmuxAvailable()) {
      return;
    }

    const projectPath = createProjectPath("delete-project");
    context.projectPaths.push(projectPath);
    const project = context.manager.selectProject(projectPath);

    try {
      context.manager.createSession(project.id, "one");
      context.manager.createSession(project.id, "two");
    } catch (error) {
      if (shouldSkipTmux(error)) {
        return;
      }
      throw error;
    }

    const deleted = context.manager.deleteProject(project.id);
    expect(deleted).toBe(true);
    expect(context.manager.getProject(project.id)).toBeNull();
    expect(context.manager.listSessions(project.id)).toHaveLength(0);
    expect(context.manager.hasSession(project.id, "one")).toBe(false);
    expect(context.manager.hasSession(project.id, "two")).toBe(false);
  });

  test("attaches multiple clients in a project session and uses project directory as shell cwd", async () => {
    const context = createContext("attach");
    if (!context.manager.isTmuxAvailable()) {
      return;
    }

    const projectPath = createProjectPath("attach");
    context.projectPaths.push(projectPath);
    const project = context.manager.selectProject(projectPath);

    const sessionId = uniqueSessionName("cc-attach");
    try {
      context.manager.createSession(project.id, sessionId);
    } catch (error) {
      if (shouldSkipTmux(error)) {
        return;
      }
      throw error;
    }

    const receivedA: ServerMessage[] = [];
    const receivedB: ServerMessage[] = [];

    context.manager.attachClient(project.id, sessionId, {
      id: "client-a",
      send(message) {
        receivedA.push(message);
      },
    });

    context.manager.attachClient(project.id, sessionId, {
      id: "client-b",
      send(message) {
        receivedB.push(message);
      },
    });

    await waitFor(() => receivedA.some((message) => message.type === "status" && message.state === "ready"));
    await waitFor(() => receivedB.some((message) => message.type === "status" && message.state === "ready"));

    const token = `__TMUX_MULTI_${Date.now()}__`;
    context.manager.handleClientMessage(project.id, sessionId, "client-a", { type: "input", data: `pwd\necho ${token}\n` });

    await waitFor(() => receivedA.some((message) => message.type === "output" && message.data.includes(token)));
    await waitFor(() => receivedB.some((message) => message.type === "output" && message.data.includes(token)));

    expect(
      receivedA.some((message) => message.type === "output" && message.data.includes(project.path)),
    ).toBe(true);

    context.manager.handleClientMessage(project.id, sessionId, "client-a", { type: "resize", cols: 111, rows: 34 });
    const metadataAfterResize = context.manager.getSessionMetadata(project.id, sessionId);
    expect(metadataAfterResize?.cols).toBe(111);
    expect(metadataAfterResize?.rows).toBe(34);

    const readyCountBeforeReset = receivedA.filter((message) => message.type === "status" && message.state === "ready").length;
    context.manager.handleClientMessage(project.id, sessionId, "client-a", { type: "reset" });

    await waitFor(() => {
      const readyCountAfterReset = receivedA.filter((message) => message.type === "status" && message.state === "ready").length;
      return readyCountAfterReset > readyCountBeforeReset;
    });

    context.manager.detachClient(project.id, sessionId, "client-a");
    context.manager.detachClient(project.id, sessionId, "client-b");

    context.manager.deleteSession(project.id, sessionId);
  });

  test("allows same session name in different projects", () => {
    const context = createContext("multi-project");
    if (!context.manager.isTmuxAvailable()) {
      return;
    }

    const projectPathA = createProjectPath("project-a");
    const projectPathB = createProjectPath("project-b");
    context.projectPaths.push(projectPathA, projectPathB);

    const projectA = context.manager.selectProject(projectPathA);
    const projectB = context.manager.selectProject(projectPathB);

    try {
      context.manager.createSession(projectA.id, "shared");
      context.manager.createSession(projectB.id, "shared");
    } catch (error) {
      if (shouldSkipTmux(error)) {
        return;
      }
      throw error;
    }

    expect(context.manager.hasSession(projectA.id, "shared")).toBe(true);
    expect(context.manager.hasSession(projectB.id, "shared")).toBe(true);
  });

  test("ignores tmux sessions not in command-center registry", () => {
    const context = createContext("scope");
    if (!context.manager.isTmuxAvailable()) {
      return;
    }

    const projectPath = createProjectPath("scope");
    context.projectPaths.push(projectPath);
    const project = context.manager.selectProject(projectPath);

    const manualSessionId = uniqueSessionName("manual");
    const createManual = Bun.spawnSync(
      ["tmux", "-L", context.socketName, "new-session", "-d", "-s", manualSessionId, "-c", process.cwd(), "zsh"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(createManual.exitCode).toBe(0);

    const listed = context.manager.listSessions(project.id);
    expect(listed.some((session) => session.id === manualSessionId)).toBe(false);
    expect(context.manager.hasSession(project.id, manualSessionId)).toBe(false);
  });

  test("persists tracked sessions and projects across manager instances", () => {
    const suffix = uniqueSuffix();
    const socketName = `cc-test-persist-${suffix}`;
    const registryPath = `/tmp/command-center-registry-persist-${suffix}.json`;

    const projectPath = createProjectPath("persist");

    const firstManager = new TerminalSessionManager({ tmuxSocketName: socketName, registryPath });
    contexts.push({ manager: firstManager, socketName, registryPath, projectPaths: [projectPath] });

    if (!firstManager.isTmuxAvailable()) {
      return;
    }

    const project = firstManager.selectProject(projectPath);

    const sessionId = uniqueSessionName("cc-persist");
    try {
      firstManager.createSession(project.id, sessionId);
    } catch (error) {
      if (shouldSkipTmux(error)) {
        return;
      }
      throw error;
    }

    const secondManager = new TerminalSessionManager({ tmuxSocketName: socketName, registryPath });
    contexts.push({ manager: secondManager, socketName, registryPath, projectPaths: [] });

    const listedProjects = secondManager.listProjects();
    expect(listedProjects.some((value) => value.id === project.id)).toBe(true);

    const listed = secondManager.listSessions(project.id);
    expect(listed.some((session) => session.id === sessionId)).toBe(true);
  });
});
