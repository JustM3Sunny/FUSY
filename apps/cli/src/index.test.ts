import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SqliteMemoryStore } from "@fusy/memory";
import { afterEach, describe, expect, it } from "vitest";

import { executeCli } from "./index.js";

const cwdStack: string[] = [];
const tempDirs: string[] = [];

const useTempProject = async (): Promise<string> => {
  const prev = process.cwd();
  cwdStack.push(prev);
  const temp = await mkdtemp(path.join(os.tmpdir(), "fusy-cli-"));
  tempDirs.push(temp);
  process.chdir(temp);
  return temp;
};

afterEach(async () => {
  const prev = cwdStack.pop();
  if (prev) {
    process.chdir(prev);
  }

  while (tempDirs.length > 0) {
    const temp = tempDirs.pop();
    if (temp) {
      await rm(temp, { recursive: true, force: true });
    }
  }
});

describe("cli integration", () => {
  it("parses pair session flag and keeps only positional intent", async () => {
    const temp = await useTempProject();

    await expect(executeCli(["pair", "--session", "s1", "fix", "auth", "flow"]))
      .resolves
      .toBe(0);

    const memory = new SqliteMemoryStore({ dbPath: path.join(temp, ".fusy", "memory.sqlite") });
    const session = memory.getSession("s1");
    memory.close();

    expect(session?.intent).toBe("fix auth flow");
  });

  it("parses run session flag and keeps only positional command", async () => {
    const temp = await useTempProject();

    await expect(executeCli(["run", "--session", "s1", "pnpm", "test"]))
      .resolves
      .toBe(0);

    const memory = new SqliteMemoryStore({ dbPath: path.join(temp, ".fusy", "memory.sqlite") });
    const session = memory.getSession("s1");
    memory.close();

    expect(session?.plan).toBe("run pnpm test");
  });

  it("reports missing run session value with a user-friendly error", async () => {
    await useTempProject();

    await expect(executeCli(["run", "--session"]))
      .rejects
      .toThrow("Missing value for --session. Example: --session <value>");
  });

  it("supports help output flow", async () => {
    await expect(executeCli(["--help"])).resolves.toBe(0);
  });
});
