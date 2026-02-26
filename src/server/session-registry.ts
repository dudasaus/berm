import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ProjectRegistryEntry {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface SessionRegistryEntry {
  projectId: string;
  sessionId: string;
  tmuxSessionName: string;
  createdAt: string;
  lastActiveAt: string;
}

interface SessionRegistryFile {
  version: number;
  projects: ProjectRegistryEntry[];
  sessions: SessionRegistryEntry[];
}

interface LegacySessionRegistryEntryV1 {
  id: string;
  createdAt: string;
  lastActiveAt: string;
}

interface LegacySessionRegistryFileV1 {
  version: 1;
  sessions: LegacySessionRegistryEntryV1[];
}

export interface SessionRegistryData {
  projects: Map<string, ProjectRegistryEntry>;
  sessions: Map<string, SessionRegistryEntry>;
}

const REGISTRY_VERSION = 2;

export function defaultSessionRegistryPath(): string {
  return join(homedir(), ".command-center", "sessions.json");
}

export function sessionRegistryKey(projectId: string, sessionId: string): string {
  return `${projectId}::${sessionId}`;
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
  let parsed: SessionRegistryFile | LegacySessionRegistryFileV1;

  try {
    parsed = JSON.parse(raw) as SessionRegistryFile | LegacySessionRegistryFileV1;
  } catch {
    const backupPath = `${path}.bak-${Date.now()}`;
    renameSync(path, backupPath);
    const empty = emptyRegistryData();
    saveSessionRegistry(path, empty);
    return empty;
  }

  if (parsed.version !== REGISTRY_VERSION) {
    const empty = emptyRegistryData();
    saveSessionRegistry(path, empty);
    return empty;
  }

  const projects = new Map<string, ProjectRegistryEntry>();
  const projectEntries = Array.isArray(parsed.projects) ? parsed.projects : [];
  for (const project of projectEntries) {
    if (
      !project ||
      typeof project.id !== "string" ||
      !project.id.trim() ||
      typeof project.name !== "string" ||
      !project.name.trim() ||
      typeof project.path !== "string" ||
      !project.path.trim()
    ) {
      continue;
    }

    const now = Date.now();
    projects.set(project.id, {
      id: project.id,
      name: project.name,
      path: project.path,
      createdAt: normalizeDate(project.createdAt, now),
      lastUsedAt: normalizeDate(project.lastUsedAt, now),
    });
  }

  const sessions = new Map<string, SessionRegistryEntry>();
  const sessionEntries = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  for (const session of sessionEntries) {
    if (
      !session ||
      typeof session.projectId !== "string" ||
      !session.projectId.trim() ||
      typeof session.sessionId !== "string" ||
      !session.sessionId.trim() ||
      typeof session.tmuxSessionName !== "string" ||
      !session.tmuxSessionName.trim()
    ) {
      continue;
    }

    if (!projects.has(session.projectId)) {
      continue;
    }

    const now = Date.now();
    sessions.set(sessionRegistryKey(session.projectId, session.sessionId), {
      projectId: session.projectId,
      sessionId: session.sessionId,
      tmuxSessionName: session.tmuxSessionName,
      createdAt: normalizeDate(session.createdAt, now),
      lastActiveAt: normalizeDate(session.lastActiveAt, now),
    });
  }

  return { projects, sessions };
}

export function saveSessionRegistry(path: string, data: SessionRegistryData): void {
  const directory = dirname(path);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }

  const payload: SessionRegistryFile = {
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
