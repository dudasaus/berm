import { describe, expect, test } from "bun:test";

import { parseClientMessage, parseServerMessage } from "../../src/shared/protocol";

describe("protocol parsing", () => {
  test("parses valid client messages", () => {
    const input = parseClientMessage('{"type":"input","data":"ls\\n"}');
    expect(input.ok).toBe(true);

    const resize = parseClientMessage({ type: "resize", cols: 120, rows: 44 });
    expect(resize.ok).toBe(true);
    if (resize.ok && resize.value.type === "resize") {
      expect(resize.value.cols).toBe(120);
      expect(resize.value.rows).toBe(44);
    }
  });

  test("rejects malformed client messages", () => {
    const invalidType = parseClientMessage('{"type":"nope"}');
    expect(invalidType.ok).toBe(false);

    const badResize = parseClientMessage({ type: "resize", cols: "120", rows: 44 });
    expect(badResize.ok).toBe(false);
  });

  test("parses server output message", () => {
    const output = parseServerMessage('{"type":"output","data":"hello"}');
    expect(output.ok).toBe(true);
  });
});
