import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";

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
  const path = `/tmp/berm-project-${prefix}-${uniqueSuffix()}`;
  mkdirSync(path, { recursive: true });
  return path;
}

function runGit(cwd: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
}

function isGitAvailable(): boolean {
  const result = Bun.spawnSync(["git", "--version"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return result.exitCode === 0;
}

function createGitProjectPath(prefix: string): string {
  const path = createProjectPath(prefix);
  const initResult = runGit(path, ["init"]);
  if (initResult.exitCode !== 0) {
    throw new Error(`git init failed: ${initResult.stderr || "unknown error"}`);
  }

  const nameResult = runGit(path, ["config", "user.name", "Command Center Test"]);
  if (nameResult.exitCode !== 0) {
    throw new Error(`git config user.name failed: ${nameResult.stderr || "unknown error"}`);
  }

  const emailResult = runGit(path, ["config", "user.email", "berm@example.com"]);
  if (emailResult.exitCode !== 0) {
    throw new Error(`git config user.email failed: ${emailResult.stderr || "unknown error"}`);
  }

  const commitResult = runGit(path, ["commit", "--allow-empty", "-m", "init"]);
  if (commitResult.exitCode !== 0) {
    throw new Error(`git commit failed: ${commitResult.stderr || "unknown error"}`);
  }

  return path;
}

function createContext(prefix: string): TestContext {
  const suffix = uniqueSuffix();
  const socketName = `cc-test-${prefix}-${suffix}`;
  const registryPath = `/tmp/berm-registry-${prefix}-${suffix}.json`;

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

    expect(created.session.id).toBe(sessionId);
    expect(created.session.projectId).toBe(project.id);
    expect(created.hook).toBeNull();

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

  test("ignores tmux sessions not in berm registry", () => {
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
    const registryPath = `/tmp/berm-registry-persist-${suffix}.json`;

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

  test("creates and deletes worktree sessions for configured projects", () => {
    const context = createContext("worktree");
    if (!context.manager.isTmuxAvailable() || !isGitAvailable()) {
      return;
    }

    const repoPath = createGitProjectPath("worktree-repo");
    const worktreeParentPath = createProjectPath("worktree-parent");
    context.projectPaths.push(repoPath, worktreeParentPath);

    const project = context.manager.selectProject(repoPath);
    context.manager.updateProject(project.id, {
      worktreeEnabled: true,
      worktreeParentPath,
    });

    const branchName = `feature-${uniqueSuffix()}`;
    let created;
    try {
      created = context.manager.createSession(project.id, {
        mode: "worktree",
        branchName,
      });
    } catch (error) {
      if (shouldSkipTmux(error)) {
        return;
      }
      throw error;
    }

    expect(created.session.id).toBe(branchName);
    expect(created.session.workspaceType).toBe("worktree");
    expect(created.session.branchName).toBe(branchName);
    expect(existsSync(created.session.workspacePath)).toBe(true);
    expect(created.hook).toBeNull();

    const deleted = context.manager.deleteSession(project.id, branchName);
    expect(deleted).toBe(true);
    expect(existsSync(created.session.workspacePath)).toBe(false);

    const branchLookup = runGit(repoPath, ["branch", "--list", branchName]);
    expect(branchLookup.exitCode).toBe(0);
    expect(branchLookup.stdout).toBe("");
  });

  test("supports continue decision after worktree hook failure", () => {
    const context = createContext("worktree-hook-continue");
    if (!context.manager.isTmuxAvailable() || !isGitAvailable()) {
      return;
    }

    const repoPath = createGitProjectPath("worktree-hook-continue-repo");
    const worktreeParentPath = createProjectPath("worktree-hook-continue-parent");
    context.projectPaths.push(repoPath, worktreeParentPath);

    const project = context.manager.selectProject(repoPath);
    context.manager.updateProject(project.id, {
      worktreeEnabled: true,
      worktreeParentPath,
      worktreeHookCommand: "echo hook-stdout; echo hook-stderr >&2; exit 13",
      worktreeHookTimeoutMs: 15_000,
    });

    const branchName = `hook-continue-${uniqueSuffix()}`;
    let thrown: unknown = null;
    try {
      context.manager.createSession(project.id, { mode: "worktree", branchName });
    } catch (error) {
      thrown = error;
    }

    expect(isSessionManagerError(thrown)).toBe(true);
    if (!isSessionManagerError(thrown)) {
      return;
    }
    expect(thrown.code).toBe("WORKTREE_HOOK_FAILED");

    const details = (thrown.details ?? {}) as Record<string, unknown>;
    const decisionToken = typeof details.decisionToken === "string" ? details.decisionToken : "";
    const workspacePath = typeof details.workspacePath === "string" ? details.workspacePath : "";
    const hook = (details.hook ?? {}) as Record<string, unknown>;

    expect(decisionToken.length).toBeGreaterThan(0);
    expect(workspacePath.length).toBeGreaterThan(0);
    expect(existsSync(workspacePath)).toBe(true);
    expect(typeof hook.command === "string" && hook.command.length > 0).toBe(true);
    expect(typeof hook.stdout === "string" && hook.stdout.includes("hook-stdout")).toBe(true);
    expect(typeof hook.stderr === "string" && hook.stderr.includes("hook-stderr")).toBe(true);

    let continueResult: ReturnType<TerminalSessionManager["resolveWorktreeHookDecision"]>;
    try {
      continueResult = context.manager.resolveWorktreeHookDecision(project.id, {
        decisionToken,
        decision: "continue",
      });
    } catch (error) {
      if (shouldSkipTmux(error)) {
        return;
      }
      throw error;
    }
    expect(continueResult.action).toBe("continue");
    if (continueResult.action === "continue") {
      expect(continueResult.session.id).toBe(branchName);
      expect(continueResult.session.workspaceType).toBe("worktree");
      expect(continueResult.session.branchName).toBe(branchName);
      expect(continueResult.session.workspacePath).toBe(workspacePath);
    }

    const deleted = context.manager.deleteSession(project.id, branchName);
    expect(deleted).toBe(true);
    expect(existsSync(workspacePath)).toBe(false);
  });

  test("returns hook output on successful worktree hook execution", () => {
    const context = createContext("worktree-hook-success");
    if (!context.manager.isTmuxAvailable() || !isGitAvailable()) {
      return;
    }

    const repoPath = createGitProjectPath("worktree-hook-success-repo");
    const worktreeParentPath = createProjectPath("worktree-hook-success-parent");
    context.projectPaths.push(repoPath, worktreeParentPath);

    const project = context.manager.selectProject(repoPath);
    context.manager.updateProject(project.id, {
      worktreeEnabled: true,
      worktreeParentPath,
      worktreeHookCommand: "echo hook-success-stdout; echo hook-success-stderr >&2; exit 0",
      worktreeHookTimeoutMs: 15_000,
    });

    const branchName = `hook-success-${uniqueSuffix()}`;
    let created: ReturnType<TerminalSessionManager["createSession"]>;
    try {
      created = context.manager.createSession(project.id, { mode: "worktree", branchName });
    } catch (error) {
      if (shouldSkipTmux(error)) {
        return;
      }
      throw error;
    }

    expect(created.session.id).toBe(branchName);
    expect(created.hook).not.toBeNull();
    expect(created.hook?.succeeded).toBe(true);
    expect(created.hook?.stdout.includes("hook-success-stdout")).toBe(true);
    expect(created.hook?.stderr.includes("hook-success-stderr")).toBe(true);

    const deleted = context.manager.deleteSession(project.id, branchName);
    expect(deleted).toBe(true);
    expect(existsSync(created.session.workspacePath)).toBe(false);
  });

  test("supports abort decision after worktree hook failure", () => {
    const context = createContext("worktree-hook-abort");
    if (!context.manager.isTmuxAvailable() || !isGitAvailable()) {
      return;
    }

    const repoPath = createGitProjectPath("worktree-hook-abort-repo");
    const worktreeParentPath = createProjectPath("worktree-hook-abort-parent");
    context.projectPaths.push(repoPath, worktreeParentPath);

    const project = context.manager.selectProject(repoPath);
    context.manager.updateProject(project.id, {
      worktreeEnabled: true,
      worktreeParentPath,
      worktreeHookCommand: "echo hook-abort >&2; exit 7",
      worktreeHookTimeoutMs: 15_000,
    });

    const branchName = `hook-abort-${uniqueSuffix()}`;
    let thrown: unknown = null;
    try {
      context.manager.createSession(project.id, { mode: "worktree", branchName });
    } catch (error) {
      thrown = error;
    }

    expect(isSessionManagerError(thrown)).toBe(true);
    if (!isSessionManagerError(thrown)) {
      return;
    }
    expect(thrown.code).toBe("WORKTREE_HOOK_FAILED");

    const details = (thrown.details ?? {}) as Record<string, unknown>;
    const decisionToken = typeof details.decisionToken === "string" ? details.decisionToken : "";
    const workspacePath = typeof details.workspacePath === "string" ? details.workspacePath : "";
    expect(decisionToken.length).toBeGreaterThan(0);
    expect(workspacePath.length).toBeGreaterThan(0);
    expect(existsSync(workspacePath)).toBe(true);

    const abortResult = context.manager.resolveWorktreeHookDecision(project.id, {
      decisionToken,
      decision: "abort",
    });
    expect(abortResult).toEqual({ action: "abort", ok: true, cleaned: true });
    expect(existsSync(workspacePath)).toBe(false);

    const branchLookup = runGit(repoPath, ["branch", "--list", branchName]);
    expect(branchLookup.exitCode).toBe(0);
    expect(branchLookup.stdout).toBe("");
  });

  test("imports existing branch-backed worktrees as sessions", () => {
    const context = createContext("worktree-import-existing");
    if (!context.manager.isTmuxAvailable() || !isGitAvailable()) {
      return;
    }

    const repoPath = createGitProjectPath("worktree-import-existing-repo");
    context.projectPaths.push(repoPath);

    const externalWorktreePath = `/tmp/berm-existing-worktree-${uniqueSuffix()}`;
    context.projectPaths.push(externalWorktreePath);

    const project = context.manager.selectProject(repoPath);
    const branchName = `import-existing-${uniqueSuffix()}`;
    const addWorktreeResult = runGit(repoPath, ["worktree", "add", "-b", branchName, externalWorktreePath]);
    expect(addWorktreeResult.exitCode).toBe(0);

    const imported = context.manager.importWorktreeSessions(project.id);
    if (
      imported.failed.some(
        (entry) => entry.code === "TMUX_UNAVAILABLE" || entry.code === "SESSION_CREATE_FAILED",
      )
    ) {
      return;
    }
    expect(imported.imported).toHaveLength(1);
    expect(imported.imported[0]?.id).toBe(branchName);
    expect(imported.imported[0]?.workspaceType).toBe("worktree");
    expect(imported.imported[0]?.workspacePath).toBe(realpathSync(externalWorktreePath));
    expect(imported.skipped.some((entry) => entry.reason === "main_worktree")).toBe(true);

    const listed = context.manager.listSessions(project.id);
    expect(listed.some((session) => session.id === branchName)).toBe(true);

    const reimported = context.manager.importWorktreeSessions(project.id);
    expect(reimported.imported).toHaveLength(0);
    expect(reimported.skipped.some((entry) => entry.reason === "session_exists" && entry.branchName === branchName)).toBe(
      true,
    );

    const deleted = context.manager.deleteSession(project.id, branchName);
    expect(deleted).toBe(true);
    expect(existsSync(externalWorktreePath)).toBe(false);
  });

  test("skips detached worktrees during import", () => {
    const context = createContext("worktree-import-detached");
    if (!context.manager.isTmuxAvailable() || !isGitAvailable()) {
      return;
    }

    const repoPath = createGitProjectPath("worktree-import-detached-repo");
    context.projectPaths.push(repoPath);

    const detachedWorktreePath = `/tmp/berm-detached-worktree-${uniqueSuffix()}`;
    context.projectPaths.push(detachedWorktreePath);

    const project = context.manager.selectProject(repoPath);
    const addDetachedResult = runGit(repoPath, ["worktree", "add", "--detach", detachedWorktreePath, "HEAD"]);
    expect(addDetachedResult.exitCode).toBe(0);

    const imported = context.manager.importWorktreeSessions(project.id);
    expect(imported.imported).toHaveLength(0);
    expect(imported.skipped.some((entry) => entry.reason === "detached_head")).toBe(true);
    expect(imported.skipped.some((entry) => entry.reason === "main_worktree")).toBe(true);
  });

  test("imports only selected worktrees when workspacePaths are provided", () => {
    const context = createContext("worktree-import-selective");
    if (!context.manager.isTmuxAvailable() || !isGitAvailable()) {
      return;
    }

    const repoPath = createGitProjectPath("worktree-import-selective-repo");
    context.projectPaths.push(repoPath);

    const firstWorktreePath = `/tmp/berm-selective-worktree-a-${uniqueSuffix()}`;
    const secondWorktreePath = `/tmp/berm-selective-worktree-b-${uniqueSuffix()}`;
    context.projectPaths.push(firstWorktreePath, secondWorktreePath);

    const project = context.manager.selectProject(repoPath);
    const firstBranch = `selective-a-${uniqueSuffix()}`;
    const secondBranch = `selective-b-${uniqueSuffix()}`;
    const firstAdd = runGit(repoPath, ["worktree", "add", "-b", firstBranch, firstWorktreePath]);
    const secondAdd = runGit(repoPath, ["worktree", "add", "-b", secondBranch, secondWorktreePath]);
    expect(firstAdd.exitCode).toBe(0);
    expect(secondAdd.exitCode).toBe(0);

    const imported = context.manager.importWorktreeSessions(project.id, {
      workspacePaths: [firstWorktreePath],
    });
    if (
      imported.failed.some(
        (entry) => entry.code === "TMUX_UNAVAILABLE" || entry.code === "SESSION_CREATE_FAILED",
      )
    ) {
      return;
    }

    expect(imported.imported).toHaveLength(1);
    expect(imported.imported[0]?.id).toBe(firstBranch);
    expect(context.manager.hasSession(project.id, firstBranch)).toBe(true);
    expect(context.manager.hasSession(project.id, secondBranch)).toBe(false);

    context.manager.deleteSession(project.id, firstBranch);
    runGit(repoPath, ["worktree", "remove", secondWorktreePath]);
    runGit(repoPath, ["branch", "-d", secondBranch]);
  });

  test("adopts existing tmux session during import when registry entry is missing", () => {
    const context = createContext("worktree-import-adopt");
    if (!context.manager.isTmuxAvailable() || !isGitAvailable()) {
      return;
    }

    const repoPath = createGitProjectPath("worktree-import-adopt-repo");
    context.projectPaths.push(repoPath);

    const worktreePath = `/tmp/berm-adopt-worktree-${uniqueSuffix()}`;
    context.projectPaths.push(worktreePath);

    const project = context.manager.selectProject(repoPath);
    const branchName = `adopt-${uniqueSuffix()}`;
    const addWorktreeResult = runGit(repoPath, ["worktree", "add", "-b", branchName, worktreePath]);
    expect(addWorktreeResult.exitCode).toBe(0);

    const tmuxName = `${project.id}__${branchName}`;
    const manualTmuxCreate = Bun.spawnSync(
      ["tmux", "-L", context.socketName, "new-session", "-d", "-s", tmuxName, "-c", worktreePath, "zsh"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(manualTmuxCreate.exitCode).toBe(0);

    const candidates = context.manager.listImportWorktreeCandidates(project.id);
    const candidate = candidates.candidates.find((entry) => entry.workspacePath === realpathSync(worktreePath));
    expect(candidate?.status).toBe("importable");

    const imported = context.manager.importWorktreeSessions(project.id, { workspacePaths: [worktreePath] });
    if (
      imported.failed.some(
        (entry) => entry.code === "TMUX_UNAVAILABLE" || entry.code === "SESSION_CREATE_FAILED",
      )
    ) {
      return;
    }
    expect(imported.imported).toHaveLength(1);
    expect(imported.imported[0]?.id).toBe(branchName);
    expect(context.manager.hasSession(project.id, branchName)).toBe(true);

    const deleted = context.manager.deleteSession(project.id, branchName);
    expect(deleted).toBe(true);
  });

  test("rejects worktree session creation when branch already exists", () => {
    const context = createContext("worktree-existing-branch");
    if (!context.manager.isTmuxAvailable() || !isGitAvailable()) {
      return;
    }

    const repoPath = createGitProjectPath("worktree-repo-existing");
    const worktreeParentPath = createProjectPath("worktree-parent-existing");
    context.projectPaths.push(repoPath, worktreeParentPath);

    const project = context.manager.selectProject(repoPath);
    context.manager.updateProject(project.id, {
      worktreeEnabled: true,
      worktreeParentPath,
    });

    const branchName = `existing-${uniqueSuffix()}`;
    const createBranchResult = runGit(repoPath, ["branch", branchName]);
    expect(createBranchResult.exitCode).toBe(0);

    let thrown: unknown = null;
    try {
      context.manager.createSession(project.id, { mode: "worktree", branchName });
    } catch (error) {
      thrown = error;
    }

    expect(isSessionManagerError(thrown)).toBe(true);
    if (!isSessionManagerError(thrown)) {
      return;
    }
    expect(thrown.code).toBe("WORKTREE_BRANCH_EXISTS");
  });
});
