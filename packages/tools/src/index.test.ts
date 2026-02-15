import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { execSync } from "node:child_process";

import { gitApplyPatch, runCommand } from "./index.js";

describe("policy engine", () => {
  it("blocks denied commands", async () => {
    await expect(runCommand("rm -rf /tmp/nope", { denyList: ["rm"] })).rejects.toThrow(
      "Command denied by policy"
    );
  });

  it("requires approval when configured", async () => {
    await expect(runCommand("echo hi", { requireApproval: true, approved: false })).rejects.toThrow(
      "Command requires approval"
    );
  });

  it("blocks shell chaining operators by default", async () => {
    await expect(runCommand("echo hi && echo bye")).rejects.toThrow("blocked shell meta operators");
  });

  it("blocks command substitution bypasses by default", async () => {
    await expect(runCommand("echo $(rm -rf /tmp/nope)", { denyList: ["rm"] })).rejects.toThrow(
      "blocked shell meta operators"
    );
  });

  it("applies deny policy to all segments when strict policy enables shell operators", async () => {
    await expect(
      runCommand("echo hi && rm -rf /tmp/nope", {
        denyList: ["rm"],
        strictPolicy: { allowMetaOperators: true }
      })
    ).rejects.toThrow("Command denied by policy: rm");
  });

  it("allows denied commands when explicitly approved", async () => {
    await expect(runCommand("echo hi", { denyList: ["echo"], approved: true })).resolves.toEqual({
      stdout: "hi",
      stderr: ""
    });
  });

  it("supports allow-listed argv execution without shell", async () => {
    await expect(runCommand("echo hello", { allowList: ["echo"] })).resolves.toEqual({
      stdout: "hello",
      stderr: ""
    });
  });
});

describe("diff application", () => {
  it("applies unified diff to repo", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "fusy-tools-"));
    execSync("git init", { cwd: repo, stdio: "ignore" });
    const target = path.join(repo, "file.txt");
    await writeFile(target, "line-a\n", "utf8");

    const patch = `diff --git a/file.txt b/file.txt\nindex 6d5f9e3..9f5d5e9 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-line-a\n+line-b\n`;

    await gitApplyPatch(patch, repo);
    const content = await readFile(target, "utf8");
    expect(content).toBe("line-b\n");
  });
});
