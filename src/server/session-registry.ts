import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface SessionRegistryEntry {
  id: string;
  createdAt: string;
  lastActiveAt: string;
}

interface SessionRegistryFile {
  version: number;
  sessions: SessionRegistryEntry[];
}

const REGISTRY_VERSION = 1;

export function defaultSessionRegistryPath(): string {
  return join(homedir(), ".command-center", "sessions.json");
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

export function loadSessionRegistry(path: string): Map<string, SessionRegistryEntry> {
  const directory = dirname(path);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }

  if (!existsSync(path)) {
    const empty = new Map<string, SessionRegistryEntry>();
    saveSessionRegistry(path, empty);
    return empty;
  }

  const raw = readFileSync(path, "utf8");
  let parsed: SessionRegistryFile;

  try {
    parsed = JSON.parse(raw) as SessionRegistryFile;
  } catch {
    const backupPath = `${path}.bak-${Date.now()}`;
    renameSync(path, backupPath);
    const empty = new Map<string, SessionRegistryEntry>();
    saveSessionRegistry(path, empty);
    return empty;
  }

  const map = new Map<string, SessionRegistryEntry>();
  const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];

  for (const session of sessions) {
    if (!session || typeof session.id !== "string" || !session.id.trim()) {
      continue;
    }

    const now = Date.now();
    map.set(session.id, {
      id: session.id,
      createdAt: normalizeDate(session.createdAt, now),
      lastActiveAt: normalizeDate(session.lastActiveAt, now),
    });
  }

  return map;
}

export function saveSessionRegistry(path: string, sessions: Map<string, SessionRegistryEntry>): void {
  const directory = dirname(path);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }

  const payload: SessionRegistryFile = {
    version: REGISTRY_VERSION,
    sessions: [...sessions.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };

  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, JSON.stringify(payload, null, 2));
  renameSync(tempPath, path);
}
