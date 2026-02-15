import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { gitApplyPatch, runCommand, searchFiles } from "./index.js";
import { execSync } from "node:child_process";

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

describe("searchFiles", () => {
  it("ignores common build directories by default", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "fusy-search-"));
    await writeFile(path.join(repo, "src.ts"), "needle\n", "utf8");
    await mkdir(path.join(repo, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(repo, "node_modules", "pkg", "index.ts"), "needle\n", "utf8");

    const matches = await searchFiles(repo, "needle", [".ts"]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.file).toBe(path.join(repo, "src.ts"));
  });

  it("respects max file size, file limit and match limit", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "fusy-search-limits-"));
    await writeFile(path.join(repo, "a.ts"), "needle\nneedle\n", "utf8");
    await writeFile(path.join(repo, "b.ts"), "needle\n", "utf8");
    await writeFile(path.join(repo, "large.ts"), `${"x".repeat(64)}needle`, "utf8");

    const matches = await searchFiles(repo, "needle", [".ts"], {
      maxFileSizeBytes: 20,
      maxFiles: 1,
      maxMatches: 1
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.text).toContain("needle");
  });

  it("stops immediately when timeout budget is exhausted", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "fusy-search-timeout-"));
    await writeFile(path.join(repo, "one.ts"), "needle\n", "utf8");

    const matches = await searchFiles(repo, "needle", [".ts"], { timeoutMs: 0 });
    expect(matches).toEqual([]);
  });
});
