import { describe, expect, test } from "bun:test";

import { parseCliArgs, runCli } from "../../src/cli";

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

  test("parses notification commands", () => {
    expect(parseCliArgs(["notify", "Build finished"])).toEqual({
      kind: "notify",
      help: false,
      host: "127.0.0.1",
      json: false,
      level: undefined,
      message: undefined,
      port: undefined,
      projectId: undefined,
      sessionId: undefined,
      title: "Build finished",
    });

    expect(
      parseCliArgs([
        "notify",
        "--title",
        "Build finished",
        "--message",
        "bun test passed",
        "--level",
        "success",
        "--project",
        "p1",
        "--session",
        "s1",
        "--json",
      ]),
    ).toEqual({
      kind: "notify",
      help: false,
      host: "127.0.0.1",
      json: true,
      level: "success",
      message: "bun test passed",
      port: undefined,
      projectId: "p1",
      sessionId: "s1",
      title: "Build finished",
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

  test("parses session input sends", () => {
    expect(
      parseCliArgs([
        "sessions",
        "send",
        "--project",
        "p1",
        "--session",
        "s1",
        "--command",
        "codex",
        "--json",
      ]),
    ).toEqual({
      kind: "sessions-send",
      commandText: "codex",
      force: false,
      help: false,
      host: "127.0.0.1",
      json: true,
      port: undefined,
      projectId: "p1",
      sessionId: "s1",
      text: undefined,
    });

    expect(
      parseCliArgs(["sessions", "send", "--project", "p1", "--session", "s1", "--text", "echo hi", "--force"]),
    ).toEqual({
      kind: "sessions-send",
      commandText: undefined,
      force: true,
      help: false,
      host: "127.0.0.1",
      json: false,
      port: undefined,
      projectId: "p1",
      sessionId: "s1",
      text: "echo hi",
    });
  });

  test("rejects invalid input", () => {
    expect(() => parseCliArgs(["--port"])).toThrow("Missing value for --port");
    expect(() => parseCliArgs(["--port", "0"])).toThrow("Invalid port for --port: 0");
    expect(() => parseCliArgs(["wat"])).toThrow("Unknown command: wat");
    expect(() => parseCliArgs(["sessions", "lifecycle", "set", "--state", "nope"])).toThrow(
      "Invalid lifecycle state: nope",
    );
    expect(() => parseCliArgs(["notify", "--title", "Hello", "--level", "critical"])).toThrow(
      "Invalid notification level: critical",
    );
    expect(() => parseCliArgs(["sessions", "send", "--project", "p1", "--session", "s1", "--flag"])).toThrow(
      "Unknown argument: --flag",
    );
  });

  test("validates session send input before making a request", async () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      expect(
        await runCli([
          "sessions",
          "send",
          "--project",
          "p1",
          "--session",
          "s1",
          "--command",
          "codex",
          "--text",
          "claude",
        ]),
      ).toBe(1);
      expect(errors.at(-1)).toBe("Provide exactly one of --command or --text");

      expect(await runCli(["sessions", "send", "--project", "p1", "--session", "s1"])).toBe(1);
      expect(errors.at(-1)).toBe("Provide exactly one of --command or --text");
    } finally {
      console.error = originalError;
    }
  });
});
