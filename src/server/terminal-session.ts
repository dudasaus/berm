import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import {
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
  type TerminalStatusState,
} from "../shared/protocol";
import {
  DEFAULT_SESSION_LIFECYCLE_STATE,
  isSessionLifecycleState,
  type SessionLifecycleState,
} from "../shared/session-lifecycle";
import {
  defaultSessionRegistryPath,
  loadSessionRegistry,
  saveSessionRegistry,
  sessionRegistryKey,
  type ProjectRegistryEntry,
  type SessionWorkspaceType,
  type SessionRegistryEntry,
} from "./session-registry";

export interface SessionClient {
  id: string;
  send: (message: ServerMessage) => void;
  close?: (code?: number, reason?: string) => void;
}

export interface ProjectMetadata {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  lastUsedAt: string;
  worktreeEnabled: boolean;
  worktreeParentPath: string | null;
  worktreeHookCommand: string | null;
  worktreeHookTimeoutMs: number;
}

export interface SessionMetadata {
  id: string;
  projectId: string;
  state: TerminalStatusState;
  connected: boolean;
  cols: number;
  rows: number;
  pid: number | null;
  createdAt: string;
  lastActiveAt: string;
  attachedClients: number;
  workspaceType: SessionWorkspaceType;
  workspacePath: string;
  branchName: string | null;
  lifecycleState: SessionLifecycleState;
  lifecycleUpdatedAt: string;
}

export type CreateSessionRequest =
  | { mode?: "main"; name?: string }
  | { mode: "worktree"; branchName: string };

export interface UpdateProjectRequest {
  worktreeEnabled?: boolean;
  worktreeParentPath?: string | null;
  worktreeHookCommand?: string | null;
  worktreeHookTimeoutMs?: number;
}

export interface UpdateSessionLifecycleRequest {
  lifecycleState: SessionLifecycleState;
}

export interface WorktreeHookExecutionDetails {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  succeeded: boolean;
}

export interface WorktreeHookFailureDetails {
  decisionToken: string;
  projectId: string;
  branchName: string;
  workspacePath: string;
  hook: WorktreeHookExecutionDetails;
}

export interface ResolveWorktreeHookDecisionRequest {
  decisionToken: string;
  decision: "abort" | "continue";
}

export type ResolveWorktreeHookDecisionResult =
  | { action: "abort"; ok: true; cleaned: true }
  | { action: "continue"; session: SessionMetadata };

export interface CreateSessionResult {
  session: SessionMetadata;
  hook: WorktreeHookExecutionDetails | null;
}

interface SessionAttachment {
  client: SessionClient;
  proc: Bun.Subprocess;
  spawnVersion: number;
}

interface TerminalSession {
  key: string;
  projectId: string;
  id: string;
  tmuxSessionName: string;
  cols: number;
  rows: number;
  state: TerminalStatusState;
  createdAtMs: number;
  lastActiveAtMs: number;
  attachments: Map<string, SessionAttachment>;
  nextSpawnVersion: number;
  workspaceType: SessionWorkspaceType;
  workspacePath: string;
  branchName: string | null;
  lifecycleState: SessionLifecycleState;
  lifecycleUpdatedAtMs: number;
}

interface TmuxSessionRef {
  tmuxSessionName: string;
  createdAtMs: number;
}

interface TerminalSessionManagerOptions {
  defaultCols?: number;
  defaultRows?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  tmuxSocketName?: string;
  registryPath?: string;
}

interface PendingWorktreeHookDecision {
  projectId: string;
  branchName: string;
  workspacePath: string;
  hook: WorktreeHookExecutionDetails;
  createdAtMs: number;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 34;
const DEFAULT_TMUX_SOCKET_NAME = "berm";
const DEFAULT_WORKTREE_HOOK_TIMEOUT_MS = 15_000;
const MIN_WORKTREE_HOOK_TIMEOUT_MS = 1_000;
const MAX_WORKTREE_HOOK_TIMEOUT_MS = 120_000;
const WORKTREE_HOOK_DECISION_TTL_MS = 60 * 60 * 1_000;
const textDecoder = new TextDecoder();

class SessionManagerError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, statusCode = 500, code = "SESSION_ERROR", details?: Record<string, unknown>) {
    super(message);
    this.name = "SessionManagerError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function isNotRunningTmuxError(stderr: string): boolean {
  const lowered = stderr.toLowerCase();
  if (lowered.includes("no server running") || lowered.includes("failed to connect to server")) {
    return true;
  }

  return lowered.includes("error connecting to") && lowered.includes("no such file or directory");
}

function loweredIncludesAny(value: string, patterns: string[]): boolean {
  const lowered = value.toLowerCase();
  return patterns.some((pattern) => lowered.includes(pattern));
}

function isMissingSessionError(stderr: string): boolean {
  return loweredIncludesAny(stderr, ["can't find session", "can't find pane"]);
}

function isTmuxUnavailableError(stderr: string): boolean {
  return loweredIncludesAny(stderr, ["operation not permitted", "permission denied", "access denied"]);
}

function parseSessionCreatedAt(value: string): number {
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  return Date.now();
}

function parseSessionLine(line: string): TmuxSessionRef | null {
  if (!line.trim()) {
    return null;
  }

  const [tmuxSessionName, created] = line.split("\t");
  if (!tmuxSessionName?.trim()) {
    return null;
  }

  return {
    tmuxSessionName: tmuxSessionName.trim(),
    createdAtMs: parseSessionCreatedAt(created ?? ""),
  };
}

function entryToTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return Date.now();
  }
  return parsed;
}

function projectIdForPath(path: string): string {
  const hash = createHash("sha1").update(path).digest("hex");
  return `proj_${hash.slice(0, 12)}`;
}

function sessionTmuxName(projectId: string, sessionId: string): string {
  const cleanedSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
  if (cleanedSessionId === sessionId && cleanedSessionId.length <= 64) {
    return `${projectId}__${sessionId}`;
  }

  const prefix = cleanedSessionId.slice(0, 32) || "session";
  const suffix = createHash("sha1").update(sessionId).digest("hex").slice(0, 10);
  return `${projectId}__${prefix}__${suffix}`;
}

function sanitizePathToken(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
}

function isMissingBranchError(stderr: string): boolean {
  return loweredIncludesAny(stderr, ["not found", "unknown revision", "does not exist"]);
}

export class TerminalSessionManager {
  private readonly options: Required<TerminalSessionManagerOptions>;
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly projects = new Map<string, ProjectRegistryEntry>();
  private readonly registrySessions = new Map<string, SessionRegistryEntry>();
  private readonly pendingWorktreeHookDecisions = new Map<string, PendingWorktreeHookDecision>();
  private unavailableReason: string | null = null;

  constructor(options: TerminalSessionManagerOptions = {}) {
    this.options = {
      defaultCols: options.defaultCols ?? DEFAULT_COLS,
      defaultRows: options.defaultRows ?? DEFAULT_ROWS,
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      tmuxSocketName: options.tmuxSocketName ?? DEFAULT_TMUX_SOCKET_NAME,
      registryPath: options.registryPath ?? defaultSessionRegistryPath(),
    };

    try {
      const loaded = loadSessionRegistry(this.options.registryPath);
      for (const [id, entry] of loaded.projects.entries()) {
        this.projects.set(id, entry);
      }

      for (const [key, entry] of loaded.sessions.entries()) {
        this.registrySessions.set(key, entry);
      }
    } catch (error) {
      this.unavailableReason = `Session registry is not accessible: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }

    this.syncSessionsFromTmux();
  }

  isTmuxAvailable(): boolean {
    return this.unavailableReason === null;
  }

  listProjects(): ProjectMetadata[] {
    return [...this.projects.values()]
      .sort((a, b) => {
        const lastUsedDiff = entryToTimestamp(b.lastUsedAt) - entryToTimestamp(a.lastUsedAt);
        if (lastUsedDiff !== 0) {
          return lastUsedDiff;
        }

        return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
      })
      .map((project) => ({ ...project }));
  }

  selectProject(inputPath: string): ProjectMetadata {
    const selectedPath = this.normalizeProjectPath(inputPath);
    const now = new Date().toISOString();

    for (const [id, project] of this.projects.entries()) {
      if (project.path !== selectedPath) {
        continue;
      }

      const updated: ProjectRegistryEntry = {
        ...project,
        lastUsedAt: now,
      };
      this.projects.set(id, updated);
      this.saveRegistry();
      return { ...updated };
    }

    const id = projectIdForPath(selectedPath);
    const derivedName = basename(selectedPath) || selectedPath;
    const project: ProjectRegistryEntry = {
      id,
      name: derivedName,
      path: selectedPath,
      createdAt: now,
      lastUsedAt: now,
      worktreeEnabled: false,
      worktreeParentPath: null,
      worktreeHookCommand: null,
      worktreeHookTimeoutMs: DEFAULT_WORKTREE_HOOK_TIMEOUT_MS,
    };

    this.projects.set(id, project);
    this.saveRegistry();
    return { ...project };
  }

  getProject(projectId: string): ProjectMetadata | null {
    const project = this.projects.get(projectId);
    if (!project) {
      return null;
    }

    return { ...project };
  }

  updateProject(projectId: string, input: UpdateProjectRequest): ProjectMetadata {
    this.syncSessionsFromTmux();
    this.assertAvailable();

    const existing = this.requireProject(projectId);

    let worktreeEnabled = existing.worktreeEnabled;
    let worktreeParentPath = existing.worktreeParentPath;
    let worktreeHookCommand = existing.worktreeHookCommand;
    let worktreeHookTimeoutMs = existing.worktreeHookTimeoutMs;

    if (typeof input.worktreeEnabled !== "undefined") {
      if (typeof input.worktreeEnabled !== "boolean") {
        throw new SessionManagerError("worktreeEnabled must be a boolean", 400, "PROJECT_UPDATE_INVALID");
      }
      worktreeEnabled = input.worktreeEnabled;
    }

    if (typeof input.worktreeParentPath !== "undefined") {
      if (input.worktreeParentPath === null) {
        worktreeParentPath = null;
      } else if (typeof input.worktreeParentPath === "string") {
        worktreeParentPath = this.normalizeProjectPath(input.worktreeParentPath);
      } else {
        throw new SessionManagerError(
          "worktreeParentPath must be a string or null",
          400,
          "PROJECT_UPDATE_INVALID",
        );
      }
    }

    if (typeof input.worktreeHookCommand !== "undefined") {
      if (input.worktreeHookCommand === null) {
        worktreeHookCommand = null;
      } else if (typeof input.worktreeHookCommand === "string") {
        const normalized = input.worktreeHookCommand.trim();
        worktreeHookCommand = normalized.length > 0 ? normalized : null;
      } else {
        throw new SessionManagerError(
          "worktreeHookCommand must be a string or null",
          400,
          "PROJECT_UPDATE_INVALID",
        );
      }
    }

    if (typeof input.worktreeHookTimeoutMs !== "undefined") {
      if (
        typeof input.worktreeHookTimeoutMs !== "number" ||
        !Number.isFinite(input.worktreeHookTimeoutMs) ||
        Math.floor(input.worktreeHookTimeoutMs) !== input.worktreeHookTimeoutMs ||
        input.worktreeHookTimeoutMs < MIN_WORKTREE_HOOK_TIMEOUT_MS ||
        input.worktreeHookTimeoutMs > MAX_WORKTREE_HOOK_TIMEOUT_MS
      ) {
        throw new SessionManagerError(
          `worktreeHookTimeoutMs must be an integer between ${MIN_WORKTREE_HOOK_TIMEOUT_MS} and ${MAX_WORKTREE_HOOK_TIMEOUT_MS}`,
          400,
          "PROJECT_UPDATE_INVALID",
        );
      }

      worktreeHookTimeoutMs = input.worktreeHookTimeoutMs;
    }

    const updated: ProjectRegistryEntry = {
      ...existing,
      worktreeEnabled,
      worktreeParentPath,
      worktreeHookCommand,
      worktreeHookTimeoutMs,
      lastUsedAt: new Date().toISOString(),
    };

    this.projects.set(projectId, updated);
    this.saveRegistry();
    return { ...updated };
  }

  deleteProject(projectId: string): boolean {
    this.syncSessionsFromTmux();
    this.assertAvailable();

    if (!this.projects.has(projectId)) {
      return false;
    }

    const sessionKeys = new Set<string>();
    for (const [key, entry] of this.registrySessions.entries()) {
      if (entry.projectId === projectId) {
        sessionKeys.add(key);
      }
    }

    for (const [key, session] of this.sessions.entries()) {
      if (session.projectId === projectId) {
        sessionKeys.add(key);
      }
    }

    for (const key of sessionKeys) {
      const registryEntry = this.registrySessions.get(key);
      const liveSession = this.sessions.get(key);

      if (liveSession) {
        this.broadcastToSession(liveSession, { type: "session_deleted", sessionId: liveSession.id });
        this.stopAllAttachments(liveSession, true);
        this.sessions.delete(key);
      }

      const tmuxName = registryEntry?.tmuxSessionName ?? liveSession?.tmuxSessionName;
      if (tmuxName) {
        const killResult = this.runTmux(["kill-session", "-t", tmuxName]);
        if (killResult.exitCode !== 0 && !isMissingSessionError(killResult.stderr)) {
          throw new SessionManagerError(
            `Failed to delete project '${projectId}': ${killResult.stderr || "unknown error"}`,
            500,
            "PROJECT_DELETE_FAILED",
          );
        }
      }

      const workspaceType = registryEntry?.workspaceType ?? liveSession?.workspaceType ?? "main";
      const workspacePath = registryEntry?.workspacePath ?? liveSession?.workspacePath;
      const branchName = registryEntry?.branchName ?? liveSession?.branchName;
      const projectRoot = this.projects.get(projectId)?.path;

      if (workspaceType === "worktree" && workspacePath && branchName && projectRoot) {
        this.cleanupWorktreeResources(projectRoot, workspacePath, branchName);
      }

      this.registrySessions.delete(key);
    }

    for (const [decisionToken, pending] of this.pendingWorktreeHookDecisions.entries()) {
      if (pending.projectId === projectId) {
        this.pendingWorktreeHookDecisions.delete(decisionToken);
      }
    }

    this.projects.delete(projectId);
    this.saveRegistry();
    return true;
  }

  listSessions(projectId: string): SessionMetadata[] {
    this.syncSessionsFromTmux();
    if (!this.isTmuxAvailable()) {
      return [];
    }

    if (!this.projects.has(projectId)) {
      return [];
    }

    return [...this.sessions.values()]
      .filter((session) => session.projectId === projectId)
      .sort((a, b) => b.lastActiveAtMs - a.lastActiveAtMs)
      .map((session) => this.toMetadata(session));
  }

  hasSession(projectId: string, sessionId: string): boolean {
    this.syncSessionsFromTmux();
    if (!this.isTmuxAvailable()) {
      return false;
    }

    return this.sessions.has(this.sessionKey(projectId, sessionId));
  }

  createSession(projectId: string, name?: string): CreateSessionResult;
  createSession(projectId: string, request?: CreateSessionRequest): CreateSessionResult;
  createSession(projectId: string, nameOrRequest?: string | CreateSessionRequest): CreateSessionResult {
    this.syncSessionsFromTmux();
    this.assertAvailable();
    this.pruneExpiredWorktreeHookDecisions();

    const project = this.requireProject(projectId);
    const request = this.normalizeCreateSessionRequest(nameOrRequest);

    if (request.mode === "worktree") {
      if (!project.worktreeEnabled) {
        throw new SessionManagerError(
          `Project '${project.name}' is not configured for worktrees`,
          400,
          "WORKTREE_DISABLED",
        );
      }

      if (!project.worktreeParentPath) {
        throw new SessionManagerError(
          `Project '${project.name}' has no worktree parent path configured`,
          400,
          "WORKTREE_PARENT_REQUIRED",
        );
      }

      const branchName = request.branchName.trim();
      this.validateBranchName(branchName);
      this.assertSessionAvailable(project, branchName);

      const workspacePath = this.resolveWorktreePath(project, branchName);
      if (existsSync(workspacePath)) {
        throw new SessionManagerError(
          `Target worktree path already exists: ${workspacePath}`,
          409,
          "WORKTREE_PATH_EXISTS",
        );
      }

      const createWorktreeResult = this.runGit(project.path, ["worktree", "add", "-b", branchName, workspacePath]);
      if (createWorktreeResult.exitCode !== 0) {
        const details = createWorktreeResult.stderr || "unknown error";
        if (loweredIncludesAny(details, ["already exists", "not a valid object name"])) {
          throw new SessionManagerError(
            `Branch '${branchName}' already exists or is invalid: ${details}`,
            409,
            "WORKTREE_BRANCH_EXISTS",
          );
        }

        throw new SessionManagerError(
          `Failed to create worktree '${branchName}': ${details}`,
          500,
          "WORKTREE_CREATE_FAILED",
        );
      }

      const hookExecution = this.runWorktreeHook(project, branchName, workspacePath);
      if (hookExecution && !hookExecution.succeeded) {
        const decisionToken = crypto.randomUUID();
        this.pendingWorktreeHookDecisions.set(decisionToken, {
          projectId: project.id,
          branchName,
          workspacePath,
          hook: hookExecution,
          createdAtMs: Date.now(),
        });

        throw new SessionManagerError(
          `Worktree setup hook failed for branch '${branchName}'`,
          409,
          "WORKTREE_HOOK_FAILED",
          {
            decisionToken,
            projectId: project.id,
            branchName,
            workspacePath,
            hook: hookExecution,
          },
        );
      }

      try {
        return {
          session: this.createTrackedSession(project, {
            sessionId: branchName,
            workspaceType: "worktree",
            workspacePath,
            branchName,
          }),
          hook: hookExecution,
        };
      } catch (error) {
        try {
          this.cleanupWorktreeResources(project.path, workspacePath, branchName);
        } catch {
          // Keep the original creation error as the primary failure.
        }
        throw error;
      }
    }

    const targetName = request.name?.trim() ? request.name.trim() : this.nextAutoName(project.id);
    this.validateMainSessionName(targetName);
    this.assertSessionAvailable(project, targetName);

    return {
      session: this.createTrackedSession(project, {
        sessionId: targetName,
        workspaceType: "main",
        workspacePath: project.path,
        branchName: null,
      }),
      hook: null,
    };
  }

  resolveWorktreeHookDecision(
    projectId: string,
    request: ResolveWorktreeHookDecisionRequest,
  ): ResolveWorktreeHookDecisionResult {
    this.syncSessionsFromTmux();
    this.assertAvailable();
    this.pruneExpiredWorktreeHookDecisions();

    const project = this.requireProject(projectId);

    if (
      !request ||
      typeof request.decisionToken !== "string" ||
      !request.decisionToken.trim() ||
      (request.decision !== "abort" && request.decision !== "continue")
    ) {
      throw new SessionManagerError(
        "decisionToken and decision ('abort'|'continue') are required",
        400,
        "WORKTREE_HOOK_DECISION_INVALID",
      );
    }

    const decisionToken = request.decisionToken.trim();
    const pending = this.pendingWorktreeHookDecisions.get(decisionToken);
    if (!pending || pending.projectId !== project.id) {
      throw new SessionManagerError(
        "Worktree hook decision token was not found or has expired",
        404,
        "WORKTREE_HOOK_DECISION_NOT_FOUND",
      );
    }

    if (request.decision === "abort") {
      this.cleanupWorktreeResources(project.path, pending.workspacePath, pending.branchName);
      this.pendingWorktreeHookDecisions.delete(decisionToken);
      return { action: "abort", ok: true, cleaned: true };
    }

    this.assertSessionAvailable(project, pending.branchName);
    const session = this.createTrackedSession(project, {
      sessionId: pending.branchName,
      workspaceType: "worktree",
      workspacePath: pending.workspacePath,
      branchName: pending.branchName,
    });
    this.pendingWorktreeHookDecisions.delete(decisionToken);
    return { action: "continue", session };
  }

  deleteSession(projectId: string, sessionId: string): boolean {
    this.syncSessionsFromTmux();
    this.assertAvailable();

    if (!this.projects.has(projectId)) {
      return false;
    }

    const key = this.sessionKey(projectId, sessionId);
    const registryEntry = this.registrySessions.get(key);
    const session = this.sessions.get(key);
    if (!registryEntry && !session) {
      return false;
    }

    if (session) {
      this.broadcastToSession(session, { type: "session_deleted", sessionId });
      this.stopAllAttachments(session, false);
      this.sessions.delete(key);
    }

    const tmuxName = registryEntry?.tmuxSessionName ?? sessionTmuxName(projectId, sessionId);
    const killResult = this.runTmux(["kill-session", "-t", tmuxName]);
    if (killResult.exitCode !== 0 && !isMissingSessionError(killResult.stderr)) {
      throw new SessionManagerError(
        `Failed to delete tmux session '${sessionId}': ${killResult.stderr || "unknown error"}`,
        500,
        "SESSION_DELETE_FAILED",
      );
    }

    const workspaceType = registryEntry?.workspaceType ?? session?.workspaceType ?? "main";
    const workspacePath = registryEntry?.workspacePath ?? session?.workspacePath;
    const branchName = registryEntry?.branchName ?? session?.branchName;

    if (workspaceType === "worktree" && workspacePath && branchName) {
      const project = this.requireProject(projectId);
      this.cleanupWorktreeResources(project.path, workspacePath, branchName);
    }

    this.registrySessions.delete(key);
    this.saveRegistry();

    return true;
  }

  updateSessionLifecycleState(projectId: string, sessionId: string, input: UpdateSessionLifecycleRequest): SessionMetadata {
    this.syncSessionsFromTmux();
    this.assertAvailable();
    this.requireProject(projectId);

    if (!input || !isSessionLifecycleState(input.lifecycleState)) {
      throw new SessionManagerError(
        "lifecycleState is invalid",
        400,
        "SESSION_LIFECYCLE_INVALID",
      );
    }

    const key = this.sessionKey(projectId, sessionId);
    const session = this.sessions.get(key);
    if (!session) {
      throw new SessionManagerError("Session not found", 404, "SESSION_NOT_FOUND");
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    session.lifecycleState = input.lifecycleState;
    session.lifecycleUpdatedAtMs = nowMs;

    const existingRegistryEntry = this.registrySessions.get(key);
    if (existingRegistryEntry) {
      this.registrySessions.set(key, {
        ...existingRegistryEntry,
        lifecycleState: input.lifecycleState,
        lifecycleUpdatedAt: nowIso,
      });
    } else {
      this.registrySessions.set(key, {
        projectId: session.projectId,
        sessionId: session.id,
        tmuxSessionName: session.tmuxSessionName,
        createdAt: new Date(session.createdAtMs).toISOString(),
        lastActiveAt: new Date(session.lastActiveAtMs).toISOString(),
        workspaceType: session.workspaceType,
        workspacePath: session.workspacePath,
        branchName: session.branchName,
        lifecycleState: input.lifecycleState,
        lifecycleUpdatedAt: nowIso,
      });
    }

    this.saveRegistry();
    return this.toMetadata(session);
  }

  attachClient(projectId: string, sessionId: string, client: SessionClient): SessionMetadata | null {
    this.syncSessionsFromTmux();
    if (!this.isTmuxAvailable()) {
      this.sendToClient(client, {
        type: "error",
        message: this.unavailableReason ?? "tmux is not available in this environment",
      });
      return null;
    }

    const session = this.sessions.get(this.sessionKey(projectId, sessionId));
    if (!session) {
      return null;
    }

    this.detachClient(projectId, sessionId, client.id);

    session.lastActiveAtMs = Date.now();
    this.sendToClient(client, { type: "status", state: "starting" });
    this.spawnAttachment(session, client);

    return this.toMetadata(session);
  }

  detachClient(projectId: string, sessionId: string, clientId: string): void {
    const session = this.sessions.get(this.sessionKey(projectId, sessionId));
    if (!session) {
      return;
    }

    this.stopAttachment(session, clientId, false);
    session.lastActiveAtMs = Date.now();
  }

  handleClientMessage(projectId: string, sessionId: string, clientId: string, rawMessage: unknown): void {
    const session = this.sessions.get(this.sessionKey(projectId, sessionId));
    if (!session) {
      return;
    }

    const parsed = parseClientMessage(rawMessage);
    if (!parsed.ok) {
      const attachment = session.attachments.get(clientId);
      if (attachment) {
        this.sendToClient(attachment.client, { type: "error", message: parsed.error });
      }
      return;
    }

    session.lastActiveAtMs = Date.now();
    this.applyClientMessage(session, clientId, parsed.value);
  }

  getSessionMetadata(projectId: string, sessionId: string): SessionMetadata | null {
    this.syncSessionsFromTmux();
    if (!this.isTmuxAvailable()) {
      return null;
    }

    const session = this.sessions.get(this.sessionKey(projectId, sessionId));
    if (!session) {
      return null;
    }

    return this.toMetadata(session);
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      this.stopAllAttachments(session, false);
    }
    this.pendingWorktreeHookDecisions.clear();
  }

  private applyClientMessage(session: TerminalSession, clientId: string, message: ClientMessage): void {
    const attachment = session.attachments.get(clientId);

    switch (message.type) {
      case "input": {
        attachment?.proc.terminal?.write(message.data);
        return;
      }

      case "resize": {
        session.cols = message.cols;
        session.rows = message.rows;
        attachment?.proc.terminal?.resize(message.cols, message.rows);
        return;
      }

      case "reset": {
        this.resetSession(session.key);
        return;
      }

      case "ping": {
        if (attachment) {
          this.sendToClient(attachment.client, { type: "pong", ts: message.ts });
        }
        return;
      }

      default: {
        const neverMessage: never = message;
        throw new Error(`Unhandled message ${(neverMessage as { type: string }).type}`);
      }
    }
  }

  private resetSession(sessionKeyValue: string): void {
    this.syncSessionsFromTmux();
    if (!this.isTmuxAvailable()) {
      const session = this.sessions.get(sessionKeyValue);
      if (!session) {
        return;
      }
      this.broadcastToSession(session, {
        type: "error",
        message: this.unavailableReason ?? "tmux is not available",
      });
      return;
    }

    const session = this.sessions.get(sessionKeyValue);
    if (!session) {
      return;
    }

    const clients = [...session.attachments.values()].map((attachment) => attachment.client);
    this.stopAllAttachments(session, false);

    const killResult = this.runTmux(["kill-session", "-t", session.tmuxSessionName]);
    if (killResult.exitCode !== 0 && !isMissingSessionError(killResult.stderr)) {
      for (const client of clients) {
        this.sendToClient(client, {
          type: "error",
          message: `Failed to reset session '${session.id}': ${killResult.stderr || "unknown error"}`,
        });
      }
      return;
    }

    const createResult = this.runTmux([
      "new-session",
      "-d",
      "-s",
      session.tmuxSessionName,
      "-c",
      session.workspacePath,
      "zsh",
    ]);
    if (createResult.exitCode !== 0) {
      for (const client of clients) {
        this.sendToClient(client, {
          type: "error",
          message: `Failed to recreate session '${session.id}': ${createResult.stderr || "unknown error"}`,
        });
      }
      return;
    }

    session.state = "starting";
    session.lastActiveAtMs = Date.now();

    for (const client of clients) {
      this.sendToClient(client, { type: "status", state: "starting" });
      this.spawnAttachment(session, client);
    }
  }

  private spawnAttachment(session: TerminalSession, client: SessionClient): void {
    const spawnVersion = session.nextSpawnVersion++;
    const cwd = session.workspacePath;

    const proc = Bun.spawn(["tmux", "-L", this.options.tmuxSocketName, "attach-session", "-t", session.tmuxSessionName], {
      cwd,
      env: this.options.env,
      terminal: {
        cols: session.cols,
        rows: session.rows,
        data: (_terminal, data) => {
          const activeSession = this.sessions.get(session.key);
          if (!activeSession) {
            return;
          }

          const activeAttachment = activeSession.attachments.get(client.id);
          if (!activeAttachment || activeAttachment.spawnVersion !== spawnVersion) {
            return;
          }

          activeSession.lastActiveAtMs = Date.now();
          this.sendToClient(client, {
            type: "output",
            data: typeof data === "string" ? data : textDecoder.decode(data),
          });
        },
      },
    });

    session.attachments.set(client.id, { client, proc, spawnVersion });
    session.state = "ready";
    this.sendToClient(client, { type: "status", state: "ready" });

    void proc.exited
      .then((code) => {
        const activeSession = this.sessions.get(session.key);
        if (!activeSession) {
          return;
        }

        const activeAttachment = activeSession.attachments.get(client.id);
        if (!activeAttachment || activeAttachment.spawnVersion !== spawnVersion) {
          return;
        }

        activeSession.attachments.delete(client.id);
        activeSession.lastActiveAtMs = Date.now();

        if (!this.tmuxSessionExists(session.tmuxSessionName)) {
          this.sendToClient(client, { type: "session_not_found", sessionId: session.id });
        }

        this.sendToClient(client, { type: "exit", code, signal: null });
      })
      .catch((error) => {
        const activeSession = this.sessions.get(session.key);
        if (!activeSession) {
          return;
        }

        const activeAttachment = activeSession.attachments.get(client.id);
        if (!activeAttachment || activeAttachment.spawnVersion !== spawnVersion) {
          return;
        }

        activeSession.attachments.delete(client.id);
        this.sendToClient(client, {
          type: "error",
          message: `Attach process failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
  }

  private stopAttachment(session: TerminalSession, clientId: string, closeClient: boolean): void {
    const attachment = session.attachments.get(clientId);
    if (!attachment) {
      return;
    }

    session.attachments.delete(clientId);

    try {
      attachment.proc.kill();
    } catch {
      // Process may already be gone.
    }

    try {
      attachment.proc.terminal?.close();
    } catch {
      // PTY may already be closed.
    }

    if (closeClient) {
      attachment.client.close?.(4004, "Session closed");
    }
  }

  private stopAllAttachments(session: TerminalSession, closeClient: boolean): void {
    for (const clientId of [...session.attachments.keys()]) {
      this.stopAttachment(session, clientId, closeClient);
    }
  }

  private toMetadata(session: TerminalSession): SessionMetadata {
    const firstAttachment = session.attachments.values().next().value as SessionAttachment | undefined;

    return {
      id: session.id,
      projectId: session.projectId,
      state: session.state,
      connected: session.attachments.size > 0,
      cols: session.cols,
      rows: session.rows,
      pid: firstAttachment?.proc.pid ?? null,
      createdAt: new Date(session.createdAtMs).toISOString(),
      lastActiveAt: new Date(session.lastActiveAtMs).toISOString(),
      attachedClients: session.attachments.size,
      workspaceType: session.workspaceType,
      workspacePath: session.workspacePath,
      branchName: session.branchName,
      lifecycleState: session.lifecycleState,
      lifecycleUpdatedAt: new Date(session.lifecycleUpdatedAtMs).toISOString(),
    };
  }

  private sendToClient(client: SessionClient, message: ServerMessage): void {
    try {
      client.send(message);
    } catch {
      // Ignore send failures on disconnected sockets.
    }
  }

  private broadcastToSession(session: TerminalSession, message: ServerMessage): void {
    for (const attachment of session.attachments.values()) {
      this.sendToClient(attachment.client, message);
    }
  }

  private normalizeCreateSessionRequest(
    input?: string | CreateSessionRequest,
  ): { mode: "main"; name?: string } | { mode: "worktree"; branchName: string } {
    if (typeof input === "undefined") {
      return { mode: "main" };
    }

    if (typeof input === "string") {
      return { mode: "main", name: input };
    }

    if (!input || typeof input !== "object") {
      throw new SessionManagerError("Session create payload is invalid", 400, "SESSION_CREATE_INVALID");
    }

    if (input.mode === "worktree") {
      if (typeof input.branchName !== "string") {
        throw new SessionManagerError("branchName must be a string", 400, "SESSION_CREATE_INVALID");
      }

      return {
        mode: "worktree",
        branchName: input.branchName,
      };
    }

    if (typeof input.mode !== "undefined" && input.mode !== "main") {
      throw new SessionManagerError("mode must be 'main' or 'worktree'", 400, "SESSION_CREATE_INVALID");
    }

    if (typeof input.name !== "undefined" && typeof input.name !== "string") {
      throw new SessionManagerError("name must be a string", 400, "SESSION_CREATE_INVALID");
    }

    return { mode: "main", name: input.name };
  }

  private createTrackedSession(
    project: ProjectRegistryEntry,
    input: {
      sessionId: string;
      workspaceType: SessionWorkspaceType;
      workspacePath: string;
      branchName: string | null;
    },
  ): SessionMetadata {
    const key = this.sessionKey(project.id, input.sessionId);
    const tmuxSessionName = sessionTmuxName(project.id, input.sessionId);

    const createResult = this.runTmux(["new-session", "-d", "-s", tmuxSessionName, "-c", input.workspacePath, "zsh"]);
    if (createResult.exitCode !== 0) {
      throw new SessionManagerError(
        `Failed to create tmux session '${input.sessionId}': ${createResult.stderr || "unknown error"}`,
        500,
        "SESSION_CREATE_FAILED",
      );
    }

    if (!this.tmuxSessionExists(tmuxSessionName)) {
      const details = createResult.stderr || "tmux did not report an active session";
      if (isTmuxUnavailableError(details)) {
        throw new SessionManagerError(
          `tmux is not accessible in this environment: ${details}`,
          503,
          "TMUX_UNAVAILABLE",
        );
      }

      throw new SessionManagerError(
        `Failed to create tmux session '${input.sessionId}': ${details}`,
        500,
        "SESSION_CREATE_FAILED",
      );
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    this.registrySessions.set(key, {
      projectId: project.id,
      sessionId: input.sessionId,
      tmuxSessionName,
      createdAt: nowIso,
      lastActiveAt: nowIso,
      workspaceType: input.workspaceType,
      workspacePath: input.workspacePath,
      branchName: input.branchName,
      lifecycleState: DEFAULT_SESSION_LIFECYCLE_STATE,
      lifecycleUpdatedAt: nowIso,
    });
    this.saveRegistry();

    const session: TerminalSession = {
      key,
      projectId: project.id,
      id: input.sessionId,
      tmuxSessionName,
      cols: this.options.defaultCols,
      rows: this.options.defaultRows,
      state: "ready",
      createdAtMs: now,
      lastActiveAtMs: now,
      attachments: new Map(),
      nextSpawnVersion: 1,
      workspaceType: input.workspaceType,
      workspacePath: input.workspacePath,
      branchName: input.branchName,
      lifecycleState: DEFAULT_SESSION_LIFECYCLE_STATE,
      lifecycleUpdatedAtMs: now,
    };

    this.sessions.set(key, session);
    return this.toMetadata(session);
  }

  private assertSessionAvailable(project: ProjectRegistryEntry, sessionId: string): void {
    const key = this.sessionKey(project.id, sessionId);
    const tmuxSessionName = sessionTmuxName(project.id, sessionId);
    if (this.sessions.has(key) || this.registrySessions.has(key) || this.tmuxSessionExists(tmuxSessionName)) {
      throw new SessionManagerError(
        `Session '${sessionId}' already exists in project '${project.name}'`,
        409,
        "SESSION_EXISTS",
      );
    }
  }

  private resolveWorktreePath(project: ProjectRegistryEntry, branchName: string): string {
    if (!project.worktreeParentPath) {
      throw new SessionManagerError(
        `Project '${project.name}' has no worktree parent path configured`,
        400,
        "WORKTREE_PARENT_REQUIRED",
      );
    }

    const projectToken = sanitizePathToken(basename(project.path) || project.name || "project") || "project";
    const branchToken = sanitizePathToken(branchName) || "branch";
    const branchSuffix = createHash("sha1").update(branchName).digest("hex").slice(0, 8);
    return join(project.worktreeParentPath, `${projectToken}-${branchToken}-${branchSuffix}`);
  }

  private runWorktreeHook(
    project: ProjectRegistryEntry,
    branchName: string,
    workspacePath: string,
  ): WorktreeHookExecutionDetails | null {
    const command = project.worktreeHookCommand?.trim();
    if (!command) {
      return null;
    }

    const timeoutMs =
      typeof project.worktreeHookTimeoutMs === "number" &&
      project.worktreeHookTimeoutMs >= MIN_WORKTREE_HOOK_TIMEOUT_MS &&
      project.worktreeHookTimeoutMs <= MAX_WORKTREE_HOOK_TIMEOUT_MS
        ? project.worktreeHookTimeoutMs
        : DEFAULT_WORKTREE_HOOK_TIMEOUT_MS;

    const result = Bun.spawnSync(["zsh", "-lc", command], {
      cwd: workspacePath,
      env: {
        ...this.options.env,
        BERM_PROJECT_ID: project.id,
        BERM_PROJECT_NAME: project.name,
        BERM_PROJECT_PATH: project.path,
        BERM_WORKTREE_BRANCH: branchName,
        BERM_WORKTREE_PATH: workspacePath,
        COMMAND_CENTER_PROJECT_ID: project.id,
        COMMAND_CENTER_PROJECT_NAME: project.name,
        COMMAND_CENTER_PROJECT_PATH: project.path,
        COMMAND_CENTER_WORKTREE_BRANCH: branchName,
        COMMAND_CENTER_WORKTREE_PATH: workspacePath,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
      killSignal: "SIGTERM",
    });

    const timedOut = result.exitedDueToTimeout === true;
    const succeeded = result.exitCode === 0 && !timedOut;

    return {
      command,
      stdout: textDecoder.decode(result.stdout),
      stderr: textDecoder.decode(result.stderr),
      exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
      timedOut,
      succeeded,
    };
  }

  private pruneExpiredWorktreeHookDecisions(nowMs = Date.now()): void {
    for (const [decisionToken, pending] of this.pendingWorktreeHookDecisions.entries()) {
      if (nowMs - pending.createdAtMs > WORKTREE_HOOK_DECISION_TTL_MS) {
        this.pendingWorktreeHookDecisions.delete(decisionToken);
      }
    }
  }

  private cleanupWorktreeResources(projectPath: string, workspacePath: string, branchName: string): void {
    const removeResult = this.runGit(projectPath, ["worktree", "remove", workspacePath]);
    if (removeResult.exitCode !== 0) {
      throw new SessionManagerError(
        `Failed to remove worktree '${workspacePath}': ${removeResult.stderr || "unknown error"}. Ensure the worktree is clean and not in use.`,
        409,
        "WORKTREE_REMOVE_FAILED",
      );
    }

    const deleteBranchResult = this.runGit(projectPath, ["branch", "-d", branchName]);
    if (deleteBranchResult.exitCode !== 0 && !isMissingBranchError(deleteBranchResult.stderr)) {
      throw new SessionManagerError(
        `Failed to delete branch '${branchName}': ${deleteBranchResult.stderr || "unknown error"}. Commit or merge the branch, then retry.`,
        409,
        "WORKTREE_BRANCH_DELETE_FAILED",
      );
    }
  }

  private validateMainSessionName(name: string): void {
    if (!name) {
      throw new SessionManagerError("Session name cannot be empty", 400, "SESSION_NAME_INVALID");
    }

    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
      throw new SessionManagerError(
        "Session name may only include letters, numbers, underscores, and hyphens",
        400,
        "SESSION_NAME_INVALID",
      );
    }
  }

  private validateBranchName(name: string): void {
    if (!name) {
      throw new SessionManagerError("Branch name cannot be empty", 400, "BRANCH_NAME_INVALID");
    }

    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(name)) {
      throw new SessionManagerError(
        "Branch name may only include letters, numbers, dots, underscores, hyphens, and slashes",
        400,
        "BRANCH_NAME_INVALID",
      );
    }

    if (
      name.includes("..") ||
      name.includes("//") ||
      name.endsWith("/") ||
      name.endsWith(".lock") ||
      name.includes("@{")
    ) {
      throw new SessionManagerError("Branch name is not valid", 400, "BRANCH_NAME_INVALID");
    }
  }

  private nextAutoName(projectId: string): string {
    let index = 1;
    while (true) {
      const candidate = `session-${index.toString().padStart(3, "0")}`;
      const key = this.sessionKey(projectId, candidate);
      if (!this.sessions.has(key) && !this.registrySessions.has(key) && !this.tmuxSessionExists(sessionTmuxName(projectId, candidate))) {
        return candidate;
      }
      index += 1;
    }
  }

  private tmuxSessionExists(tmuxSessionName: string): boolean {
    if (!this.isTmuxAvailable()) {
      return false;
    }

    const result = this.runTmux(["has-session", "-t", tmuxSessionName]);
    return result.exitCode === 0;
  }

  private syncSessionsFromTmux(): void {
    if (this.unavailableReason?.startsWith("Session registry")) {
      return;
    }

    const listResult = this.runTmux(["list-sessions", "-F", "#{session_name}\t#{session_created}"]);

    if (listResult.exitCode !== 0) {
      if (isNotRunningTmuxError(listResult.stderr)) {
        this.unavailableReason = null;
        this.reconcileFromListed([]);
        return;
      }

      if (isTmuxUnavailableError(listResult.stderr)) {
        this.unavailableReason = `tmux is not accessible in this environment: ${listResult.stderr}`;
        for (const session of this.sessions.values()) {
          this.stopAllAttachments(session, false);
        }
        this.sessions.clear();
        return;
      }

      this.unavailableReason = `Unable to use tmux: ${listResult.stderr || "unknown error"}`;
      for (const session of this.sessions.values()) {
        this.stopAllAttachments(session, false);
      }
      this.sessions.clear();
      return;
    }

    this.unavailableReason = null;

    const listed = listResult.stdout
      .split("\n")
      .map((line) => parseSessionLine(line))
      .filter((session): session is TmuxSessionRef => session !== null);

    this.reconcileFromListed(listed);
  }

  private reconcileFromListed(listed: TmuxSessionRef[]): void {
    const listedMap = new Map(listed.map((session) => [session.tmuxSessionName, session]));
    let registryChanged = false;

    for (const [key, entry] of [...this.registrySessions.entries()]) {
      if (!this.projects.has(entry.projectId) || !listedMap.has(entry.tmuxSessionName)) {
        this.registrySessions.delete(key);
        registryChanged = true;
      }
    }

    for (const [key, session] of this.sessions.entries()) {
      if (!this.registrySessions.has(key)) {
        this.stopAllAttachments(session, false);
        this.sessions.delete(key);
      }
    }

    for (const [key, registryEntry] of this.registrySessions.entries()) {
      const listedSession = listedMap.get(registryEntry.tmuxSessionName);
      if (!listedSession) {
        continue;
      }

      const createdAtMs = entryToTimestamp(registryEntry.createdAt);
      const registryLastActiveMs = entryToTimestamp(registryEntry.lastActiveAt);
      const lifecycleUpdatedAtMs = entryToTimestamp(registryEntry.lifecycleUpdatedAt);

      const existing = this.sessions.get(key);
      if (!existing) {
        this.sessions.set(key, {
          key,
          projectId: registryEntry.projectId,
          id: registryEntry.sessionId,
          tmuxSessionName: registryEntry.tmuxSessionName,
          cols: this.options.defaultCols,
          rows: this.options.defaultRows,
          state: "ready",
          createdAtMs,
          lastActiveAtMs: registryLastActiveMs,
          attachments: new Map(),
          nextSpawnVersion: 1,
          workspaceType: registryEntry.workspaceType,
          workspacePath: registryEntry.workspacePath,
          branchName: registryEntry.branchName,
          lifecycleState: registryEntry.lifecycleState,
          lifecycleUpdatedAtMs,
        });
        continue;
      }

      existing.createdAtMs = createdAtMs;
      existing.state = "ready";
      existing.workspaceType = registryEntry.workspaceType;
      existing.workspacePath = registryEntry.workspacePath;
      existing.branchName = registryEntry.branchName;
      existing.lifecycleState = registryEntry.lifecycleState;
      existing.lifecycleUpdatedAtMs = lifecycleUpdatedAtMs;
      if (existing.lastActiveAtMs < registryLastActiveMs) {
        existing.lastActiveAtMs = registryLastActiveMs;
      }

      const normalizedLastActive = new Date(existing.lastActiveAtMs).toISOString();
      const normalizedCreatedAt = new Date(existing.createdAtMs).toISOString();
      const normalizedLifecycleUpdatedAt = new Date(existing.lifecycleUpdatedAtMs).toISOString();
      if (
        registryEntry.createdAt !== normalizedCreatedAt ||
        registryEntry.lastActiveAt !== normalizedLastActive ||
        registryEntry.lifecycleUpdatedAt !== normalizedLifecycleUpdatedAt ||
        registryEntry.lifecycleState !== existing.lifecycleState
      ) {
        this.registrySessions.set(key, {
          ...registryEntry,
          createdAt: normalizedCreatedAt,
          lastActiveAt: normalizedLastActive,
          lifecycleState: existing.lifecycleState,
          lifecycleUpdatedAt: normalizedLifecycleUpdatedAt,
        });
        registryChanged = true;
      }

    }

    if (registryChanged) {
      this.saveRegistry();
    }
  }

  private saveRegistry(): void {
    try {
      saveSessionRegistry(this.options.registryPath, {
        projects: this.projects,
        sessions: this.registrySessions,
      });
    } catch (error) {
      this.unavailableReason = `Session registry is not writable: ${error instanceof Error ? error.message : String(error)}`;
      throw new SessionManagerError(this.unavailableReason, 500, "REGISTRY_WRITE_FAILED");
    }
  }

  private assertAvailable(): void {
    if (!this.unavailableReason) {
      return;
    }

    const code = this.unavailableReason.startsWith("Session registry") ? "REGISTRY_UNAVAILABLE" : "TMUX_UNAVAILABLE";
    throw new SessionManagerError(this.unavailableReason, 503, code);
  }

  private normalizeProjectPath(inputPath: string): string {
    const path = inputPath.trim();
    if (!path) {
      throw new SessionManagerError("Project path cannot be empty", 400, "PROJECT_PATH_INVALID");
    }

    if (!isAbsolute(path)) {
      throw new SessionManagerError("Project path must be absolute", 400, "PROJECT_PATH_INVALID");
    }

    let normalized: string;
    try {
      normalized = realpathSync(path);
    } catch {
      throw new SessionManagerError("Project path does not exist", 400, "PROJECT_PATH_INVALID");
    }

    try {
      const stat = statSync(normalized);
      if (!stat.isDirectory()) {
        throw new SessionManagerError("Project path must be a directory", 400, "PROJECT_PATH_INVALID");
      }
    } catch (error) {
      if (isSessionManagerError(error)) {
        throw error;
      }
      throw new SessionManagerError("Project path must be a directory", 400, "PROJECT_PATH_INVALID");
    }

    return normalized;
  }

  private requireProject(projectId: string): ProjectRegistryEntry {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new SessionManagerError("Project not found", 404, "PROJECT_NOT_FOUND");
    }

    return project;
  }

  private sessionKey(projectId: string, sessionId: string): string {
    return sessionRegistryKey(projectId, sessionId);
  }

  private runGit(cwd: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    return {
      exitCode: result.exitCode,
      stdout: textDecoder.decode(result.stdout).trim(),
      stderr: textDecoder.decode(result.stderr).trim(),
    };
  }

  private runTmux(args: string[]): { exitCode: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync(["tmux", "-L", this.options.tmuxSocketName, ...args], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    return {
      exitCode: result.exitCode,
      stdout: textDecoder.decode(result.stdout).trim(),
      stderr: textDecoder.decode(result.stderr).trim(),
    };
  }
}

export function isSessionManagerError(error: unknown): error is SessionManagerError {
  return error instanceof SessionManagerError;
}
