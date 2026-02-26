import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SessionWorkspaceType = "main" | "worktree";

export interface ProjectRegistryEntry {
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

export interface SessionRegistryEntry {
  projectId: string;
  sessionId: string;
  tmuxSessionName: string;
  createdAt: string;
  lastActiveAt: string;
  workspaceType: SessionWorkspaceType;
  workspacePath: string;
  branchName: string | null;
}

interface SessionRegistryFileV4 {
  version: 4;
  projects: ProjectRegistryEntry[];
  sessions: SessionRegistryEntry[];
}

interface SessionRegistryFileV3 {
  version: 3;
  projects: Array<{
    id: string;
    name: string;
    path: string;
    createdAt: string;
    lastUsedAt: string;
    worktreeEnabled: boolean;
    worktreeParentPath: string | null;
  }>;
  sessions: Array<{
    projectId: string;
    sessionId: string;
    tmuxSessionName: string;
    createdAt: string;
    lastActiveAt: string;
    workspaceType: SessionWorkspaceType;
    workspacePath: string;
    branchName: string | null;
  }>;
}

interface SessionRegistryFileV2 {
  version: 2;
  projects: Array<{
    id: string;
    name: string;
    path: string;
    createdAt: string;
    lastUsedAt: string;
  }>;
  sessions: Array<{
    projectId: string;
    sessionId: string;
    tmuxSessionName: string;
    createdAt: string;
    lastActiveAt: string;
  }>;
}

export interface SessionRegistryData {
  projects: Map<string, ProjectRegistryEntry>;
  sessions: Map<string, SessionRegistryEntry>;
}

const REGISTRY_VERSION = 4;
const DEFAULT_WORKTREE_HOOK_TIMEOUT_MS = 15_000;

export function defaultSessionRegistryPath(): string {
  return join(homedir(), ".command-center", "sessions.json");
}

export function sessionRegistryKey(projectId: string, sessionId: string): string {
  return `${projectId}::${sessionId}`;
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeDate(value: string | undefined, fallbackMs: number): string {
  if (typeof value !== "string") {
    return new Date(fallbackMs).toISOString();
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return new Date(fallbackMs).toISOString();
  }

  return new Date(parsed).toISOString();
}

function emptyRegistryData(): SessionRegistryData {
  return {
    projects: new Map<string, ProjectRegistryEntry>(),
    sessions: new Map<string, SessionRegistryEntry>(),
  };
}

export function loadSessionRegistry(path: string): SessionRegistryData {
  const directory = dirname(path);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }

  if (!existsSync(path)) {
    const empty = emptyRegistryData();
    saveSessionRegistry(path, empty);
    return empty;
  }

  const raw = readFileSync(path, "utf8");
  let parsed: SessionRegistryFileV4 | SessionRegistryFileV3 | SessionRegistryFileV2;

  try {
    parsed = JSON.parse(raw) as SessionRegistryFileV4 | SessionRegistryFileV3 | SessionRegistryFileV2;
  } catch {
    const backupPath = `${path}.bak-${Date.now()}`;
    renameSync(path, backupPath);
    const empty = emptyRegistryData();
    saveSessionRegistry(path, empty);
    return empty;
  }

  if (parsed.version !== 2 && parsed.version !== 3 && parsed.version !== REGISTRY_VERSION) {
    const empty = emptyRegistryData();
    saveSessionRegistry(path, empty);
    return empty;
  }

  const projects = new Map<string, ProjectRegistryEntry>();
  const projectEntries = Array.isArray(parsed.projects) ? parsed.projects : [];
  for (const project of projectEntries) {
    const projectRecord = project as Record<string, unknown>;
    const projectId = normalizeNonEmptyString(projectRecord?.id);
    const projectName = normalizeNonEmptyString(projectRecord?.name);
    const projectPath = normalizeNonEmptyString(projectRecord?.path);
    if (
      !project ||
      !projectId ||
      !projectName ||
      !projectPath
    ) {
      continue;
    }

    const now = Date.now();
    projects.set(projectId, {
      id: projectId,
      name: projectName,
      path: projectPath,
      createdAt: normalizeDate(project.createdAt, now),
      lastUsedAt: normalizeDate(project.lastUsedAt, now),
      worktreeEnabled: projectRecord.worktreeEnabled === true,
      worktreeParentPath: normalizeNonEmptyString(projectRecord.worktreeParentPath),
      worktreeHookCommand: normalizeNonEmptyString(projectRecord.worktreeHookCommand),
      worktreeHookTimeoutMs:
        typeof projectRecord.worktreeHookTimeoutMs === "number" &&
        Number.isFinite(projectRecord.worktreeHookTimeoutMs) &&
        projectRecord.worktreeHookTimeoutMs >= 1_000 &&
        projectRecord.worktreeHookTimeoutMs <= 120_000
          ? Math.floor(projectRecord.worktreeHookTimeoutMs)
          : DEFAULT_WORKTREE_HOOK_TIMEOUT_MS,
    });
  }

  const sessions = new Map<string, SessionRegistryEntry>();
  const sessionEntries = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  for (const session of sessionEntries) {
    const sessionRecord = session as Record<string, unknown>;
    const projectId = normalizeNonEmptyString(sessionRecord?.projectId);
    const sessionId = normalizeNonEmptyString(sessionRecord?.sessionId);
    const tmuxSessionName = normalizeNonEmptyString(sessionRecord?.tmuxSessionName);
    if (
      !session ||
      !projectId ||
      !sessionId ||
      !tmuxSessionName
    ) {
      continue;
    }

    const owningProject = projects.get(projectId);
    if (!owningProject) {
      continue;
    }

    const workspaceType: SessionWorkspaceType = sessionRecord.workspaceType === "worktree" ? "worktree" : "main";
    const workspacePath = normalizeNonEmptyString(sessionRecord.workspacePath) ?? owningProject.path;
    const branchName = normalizeNonEmptyString(sessionRecord.branchName);

    const now = Date.now();
    sessions.set(sessionRegistryKey(projectId, sessionId), {
      projectId,
      sessionId,
      tmuxSessionName,
      createdAt: normalizeDate(session.createdAt, now),
      lastActiveAt: normalizeDate(session.lastActiveAt, now),
      workspaceType,
      workspacePath,
      branchName: workspaceType === "worktree" ? branchName : null,
    });
  }

  const loaded: SessionRegistryData = { projects, sessions };
  if (parsed.version !== REGISTRY_VERSION) {
    saveSessionRegistry(path, loaded);
  }

  return loaded;
}

export function saveSessionRegistry(path: string, data: SessionRegistryData): void {
  const directory = dirname(path);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }

  const payload: SessionRegistryFileV4 = {
    version: REGISTRY_VERSION,
    projects: [...data.projects.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    sessions: [...data.sessions.values()].sort((a, b) => {
      if (a.projectId !== b.projectId) {
        return a.projectId.localeCompare(b.projectId);
      }

      if (a.sessionId !== b.sessionId) {
        return a.sessionId.localeCompare(b.sessionId);
      }

      return a.tmuxSessionName.localeCompare(b.tmuxSessionName);
    }),
  };

  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, JSON.stringify(payload, null, 2));
  renameSync(tempPath, path);
}
