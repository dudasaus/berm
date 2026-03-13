import { describe, expect, test } from "bun:test";

import { parseCliArgs } from "../../src/cli";

describe("parseCliArgs", () => {
  test("parses help flag", () => {
    expect(parseCliArgs(["--help"])).toEqual({ help: true });
  });

  test("parses port flags", () => {
    expect(parseCliArgs(["--port", "4321"])).toEqual({ help: false, port: 4321 });
    expect(parseCliArgs(["-p", "9876"])).toEqual({ help: false, port: 9876 });
  });

  test("rejects invalid input", () => {
    expect(() => parseCliArgs(["--port"])).toThrow("Missing value for --port");
    expect(() => parseCliArgs(["--port", "0"])).toThrow("Invalid port: 0");
    expect(() => parseCliArgs(["--wat"])).toThrow("Unknown argument: --wat");
  });
});
