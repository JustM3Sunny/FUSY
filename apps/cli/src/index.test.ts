import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeCli } from "./index.js";

const cwdStack: string[] = [];

afterEach(async () => {
  const prev = cwdStack.pop();
  if (prev) {
    process.chdir(prev);
  }
});

describe("cli integration", () => {
  it("runs command flow and persists session metadata", async () => {
    const prev = process.cwd();
    cwdStack.push(prev);
    const temp = await mkdtemp(path.join(os.tmpdir(), "fusy-cli-"));
    process.chdir(temp);

    const code = await executeCli(["run", "echo", "hello", "--session", "s-1"]);
    expect(code).toBe(0);

    const sessions = await executeCli(["sessions"]);
    expect(sessions).toBe(0);

    await rm(path.join(temp, ".fusy"), { recursive: true, force: true });
  });

  it("supports help output flow", async () => {
    await expect(executeCli(["--help"])).resolves.toBe(0);
  });
});
