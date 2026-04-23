import { describe, expect, test } from "bun:test";

import { parseCliArgs } from "../../src/cli";

describe("parseCliArgs", () => {
  test("defaults to starting the server", () => {
    expect(parseCliArgs([])).toEqual({
      kind: "serve",
      help: false,
      host: "127.0.0.1",
      json: false,
      port: undefined,
    });
  });

  test("parses explicit help commands", () => {
    expect(parseCliArgs(["help"])).toEqual({
      kind: "serve",
      help: true,
      host: "127.0.0.1",
      json: false,
      port: undefined,
    });

    expect(parseCliArgs(["daemon", "help"])).toEqual({
      kind: "serve",
      help: true,
      host: "127.0.0.1",
      json: false,
      port: undefined,
    });

    expect(parseCliArgs(["projects", "help"])).toEqual({
      kind: "serve",
      help: true,
      host: "127.0.0.1",
      json: false,
      port: undefined,
    });

    expect(parseCliArgs(["sessions", "help"])).toEqual({
      kind: "serve",
      help: true,
      host: "127.0.0.1",
      json: false,
      port: undefined,
    });
  });

  test("parses daemon status flags", () => {
    expect(parseCliArgs(["daemon", "status", "--json", "--port", "4321"])).toEqual({
      kind: "daemon-status",
      help: false,
      host: "127.0.0.1",
      json: true,
      port: 4321,
    });
  });

  test("parses project selection", () => {
    expect(parseCliArgs(["projects", "select", "/tmp/alpha"])).toEqual({
      kind: "projects-select",
      help: false,
      host: "127.0.0.1",
      json: false,
      path: "/tmp/alpha",
      port: undefined,
    });
  });

  test("parses worktree session creation", () => {
    expect(parseCliArgs(["sessions", "create", "--project", "p1", "--worktree", "--branch", "feature/test"])).toEqual({
      kind: "sessions-create",
      branchName: "feature/test",
      help: false,
      host: "127.0.0.1",
      json: false,
      name: undefined,
      projectId: "p1",
      port: undefined,
      worktree: true,
    });
  });

  test("parses lifecycle updates", () => {
    expect(
      parseCliArgs([
        "sessions",
        "lifecycle",
        "set",
        "--project",
        "p1",
        "--session",
        "s1",
        "--state",
        "in_review",
      ]),
    ).toEqual({
      kind: "sessions-lifecycle-set",
      help: false,
      host: "127.0.0.1",
      json: false,
      lifecycleState: "in_review",
      port: undefined,
      projectId: "p1",
      sessionId: "s1",
    });
  });

  test("rejects invalid input", () => {
    expect(() => parseCliArgs(["--port"])).toThrow("Missing value for --port");
    expect(() => parseCliArgs(["--port", "0"])).toThrow("Invalid port for --port: 0");
    expect(() => parseCliArgs(["wat"])).toThrow("Unknown command: wat");
    expect(() => parseCliArgs(["sessions", "lifecycle", "set", "--state", "nope"])).toThrow(
      "Invalid lifecycle state: nope",
    );
  });
});
