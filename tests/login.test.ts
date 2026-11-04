import { expect, test } from "bun:test";
import { parseDeviceCode } from "../src/login";

test("device login reads the CLI code even when stdout contains ANSI colors", () => {
  const ansiEscape = String.fromCharCode(27);
  const output = `Welcome to Codex\nEnter this one-time code\n${ansiEscape}[94mTEST-A12B3${ansiEscape}[0m\n`;
  expect(parseDeviceCode(output)).toBe("TEST-A12B3");
  expect(parseDeviceCode("one-time code\nTEST-A12B3\n")).toBe("TEST-A12B3");
  expect(
    parseDeviceCode("Welcome to Codex\nhttps://auth.openai.com/codex/device"),
  ).toBeNull();
});
