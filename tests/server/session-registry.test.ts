import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  loadSessionRegistry,
  saveSessionRegistry,
  sessionRegistryKey,
  type ProjectRegistryEntry,
  type SessionRegistryData,
  type SessionRegistryEntry,
} from "../../src/server/session-registry";

function uniqueRegistryPath(prefix: string): string {
  const suffix = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  return `/tmp/command-center-registry-unit/${suffix}/sessions.json`;
}

function makeProject(id: string, path: string): ProjectRegistryEntry {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    path,
    createdAt: now,
    lastUsedAt: now,
    worktreeEnabled: false,
    worktreeParentPath: null,
  };
}

function makeSession(projectId: string, sessionId: string): SessionRegistryEntry {
  const now = new Date().toISOString();
  return {
    projectId,
    sessionId,
    tmuxSessionName: `${projectId}__${sessionId}`,
    createdAt: now,
    lastActiveAt: now,
    workspaceType: "main",
    workspacePath: `/tmp/${projectId}`,
    branchName: null,
  };
}

describe("session registry", () => {
  test("creates missing registry file and returns empty maps", () => {
    const path = uniqueRegistryPath("missing");
    const directory = dirname(path);
    rmSync(directory, { recursive: true, force: true });

    try {
      const loaded = loadSessionRegistry(path);
      expect(loaded.projects.size).toBe(0);
      expect(loaded.sessions.size).toBe(0);
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("saves and reloads registry data", () => {
    const path = uniqueRegistryPath("roundtrip");
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true });

    try {
      const project = makeProject("proj_a", "/tmp/proj_a");
      const session = makeSession(project.id, "session-1");

      const data: SessionRegistryData = {
        projects: new Map([[project.id, project]]),
        sessions: new Map([[sessionRegistryKey(project.id, session.sessionId), session]]),
      };

      saveSessionRegistry(path, data);
      const loaded = loadSessionRegistry(path);

      expect(loaded.projects.get(project.id)?.path).toBe(project.path);
      expect(loaded.sessions.get(sessionRegistryKey(project.id, session.sessionId))?.tmuxSessionName).toBe(
        session.tmuxSessionName,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("migrates v2 registry records to v3 defaults", async () => {
    const path = uniqueRegistryPath("migrate");
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true });

    try {
      const payload = {
        version: 2,
        projects: [
          {
            id: "proj_v2",
            name: "legacy",
            path: "/tmp/legacy",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastUsedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
        sessions: [
          {
            projectId: "proj_v2",
            sessionId: "legacy-session",
            tmuxSessionName: "proj_v2__legacy-session",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastActiveAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      };
      writeFileSync(path, JSON.stringify(payload, null, 2));

      const loaded = loadSessionRegistry(path);
      const project = loaded.projects.get("proj_v2");
      const session = loaded.sessions.get(sessionRegistryKey("proj_v2", "legacy-session"));

      expect(project?.worktreeEnabled).toBe(false);
      expect(project?.worktreeParentPath).toBeNull();
      expect(session?.workspaceType).toBe("main");
      expect(session?.workspacePath).toBe("/tmp/legacy");
      expect(session?.branchName).toBeNull();

      const persisted = JSON.parse(await Bun.file(path).text()) as { version: number };
      expect(persisted.version).toBe(3);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("backs up invalid JSON registry file and recreates empty registry", () => {
    const path = uniqueRegistryPath("invalid-json");
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true });

    try {
      writeFileSync(path, "{ invalid-json ");
      const loaded = loadSessionRegistry(path);
      expect(loaded.projects.size).toBe(0);
      expect(loaded.sessions.size).toBe(0);

      const files = readdirSync(directory);
      const backupFile = files.find((file) => file.includes(".bak-"));
      expect(Boolean(backupFile)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
