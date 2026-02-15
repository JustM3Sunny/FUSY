import { exec as execCallback, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCallback);

export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

export interface SearchFilesOptions {
  readonly ignoreDirs?: readonly string[];
  readonly maxFileSizeBytes?: number;
  readonly maxMatches?: number;
  readonly maxFiles?: number;
  readonly timeoutMs?: number;
}

export interface RunCommandPolicy {
  readonly allowList?: readonly string[];
  readonly denyList?: readonly string[];
  readonly requireApproval?: boolean;
  readonly approved?: boolean;
  readonly strictPolicy?: {
    readonly allowMetaOperators?: boolean;
  };
}

export interface ToolExecutionContext {
  cwd: string;
  policy?: RunCommandPolicy;
}

export interface ToolDefinition<TArgs = Record<string, unknown>, TResult = unknown> {
  name: string;
  description: string;
  execute: (args: TArgs, context: ToolExecutionContext) => Promise<TResult>;
}

const parseCommand = (command: string): string => {
  const [bin] = command.trim().split(/\s+/u);
  return bin ?? "";
};

const META_OPERATORS = ["&&", "||", ";", "|", "`", "$("] as const;

const splitByMetaOperators = (command: string): string[] => {
  const segments: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escapeNext = false;

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index] ?? "";
    const next = command[index + 1] ?? "";

    if (escapeNext) {
      current += ch;
      escapeNext = false;
      continue;
    }

    if (ch === "\\") {
      current += ch;
      escapeNext = true;
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      continue;
    }

    if (inSingleQuote || inDoubleQuote) {
      current += ch;
      continue;
    }

    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = "";
      index += 1;
      continue;
    }

    if (ch === ";" || ch === "|") {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments;
};

const parseArgv = (command: string): string[] => {
  const argv: string[] = [];
  let token = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escapeNext = false;

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index] ?? "";

    if (escapeNext) {
      token += ch;
      escapeNext = false;
      continue;
    }

    if (ch === "\\" && !inSingleQuote) {
      escapeNext = true;
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && /\s/u.test(ch)) {
      if (token.length > 0) {
        argv.push(token);
        token = "";
      }
      continue;
    }

    token += ch;
  }

  if (inSingleQuote || inDoubleQuote || escapeNext) {
    throw new Error(`Invalid command syntax: ${command}`);
  }

  if (token.length > 0) {
    argv.push(token);
  }

  return argv;
};

const parseSubcommands = (command: string): string[] => {
  const subcommands: string[] = [];
  const backtickPattern = /`([^`]+)`/gu;
  const dollarPattern = /\$\(([^)]+)\)/gu;

  for (const match of command.matchAll(backtickPattern)) {
    const content = match[1]?.trim();
    if (content) {
      subcommands.push(content);
    }
  }

  for (const match of command.matchAll(dollarPattern)) {
    const content = match[1]?.trim();
    if (content) {
      subcommands.push(content);
    }
  }

  return subcommands;
};

const extractExecutableBins = (command: string): string[] => {
  const bins = splitByMetaOperators(command)
    .map(parseCommand)
    .filter((bin): bin is string => bin.length > 0);

  for (const subcommand of parseSubcommands(command)) {
    bins.push(...extractExecutableBins(subcommand));
  }

  return bins;
};

const hasMetaOperators = (command: string): boolean => META_OPERATORS.some((operator) => command.includes(operator));

const spawnCommand = async (
  file: string,
  args: readonly string[],
  cwd: string
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd() });
        return;
      }

      reject(new Error(stderr.trim() || `Command failed with exit code ${code}`));
    });
  });

const isCommandAllowed = (bin: string, policy: RunCommandPolicy): boolean => {
  const denied = policy.denyList ?? ["rm", "shutdown", "reboot", "mkfs", "dd"];
  const allowed = policy.allowList;

  if (denied.includes(bin)) {
    return false;
  }

  if (!allowed || allowed.length === 0) {
    return true;
  }

  return allowed.includes(bin);
};

const runCommandInternal = async (
  command: string,
  policy: RunCommandPolicy = {},
  cwd: string = process.cwd()
): Promise<{ stdout: string; stderr: string }> => {
  const allowMetaOperators = policy.strictPolicy?.allowMetaOperators === true;

  if (hasMetaOperators(command) && !allowMetaOperators) {
    throw new Error(`Command contains blocked shell meta operators: ${command}`);
  }

  const bins = extractExecutableBins(command);
  for (const bin of bins) {
    if (!isCommandAllowed(bin, policy)) {
      throw new Error(`Command denied by policy: ${bin}`);
    }
  }

  if (policy.requireApproval && !policy.approved) {
    throw new Error(`Command requires approval: ${command}`);
  }

  if (!allowMetaOperators) {
    const argv = parseArgv(command);
    const [file, ...args] = argv;

    if (!file) {
      throw new Error("Command must not be empty");
    }

    return spawnCommand(file, args, cwd);
  }

  const { stdout, stderr } = await exec(command, { cwd, maxBuffer: 4 * 1024 * 1024 });

  return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
};

export const runCommand = runCommandInternal;

// Filesystem tools
export const readFile = async (filePath: string): Promise<string> => fs.readFile(filePath, "utf8");

export const writeFile = async (filePath: string, content: string): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
};

export const appendFile = async (filePath: string, content: string): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, content, "utf8");
};

export const updateFile = async (
  filePath: string,
  updater: (previous: string) => string | Promise<string>
): Promise<void> => {
  const previous = await readFile(filePath);
  const next = await updater(previous);
  await writeFile(filePath, next);
};

export const deleteFile = async (filePath: string): Promise<void> => {
  await fs.rm(filePath, { force: true });
};

export const touchFile = async (filePath: string): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "a");
  await handle.close();
};

export const makeDir = async (directory: string): Promise<void> => {
  await fs.mkdir(directory, { recursive: true });
};

export const deleteDir = async (directory: string): Promise<void> => {
  await fs.rm(directory, { recursive: true, force: true });
};

export const movePath = async (fromPath: string, toPath: string): Promise<void> => {
  await fs.mkdir(path.dirname(toPath), { recursive: true });
  await fs.rename(fromPath, toPath);
};

export const copyPath = async (fromPath: string, toPath: string): Promise<void> => {
  await fs.mkdir(path.dirname(toPath), { recursive: true });
  await fs.cp(fromPath, toPath, { recursive: true, force: true });
};

export const listDir = async (directory: string): Promise<string[]> => fs.readdir(directory);

export const listDirRecursive = async (directory: string): Promise<string[]> => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    results.push(fullPath);
    if (entry.isDirectory()) {
      results.push(...(await listDirRecursive(fullPath)));
    }
  }

  return results;
};

export const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

export const statPath = async (
  targetPath: string
): Promise<{ isFile: boolean; isDirectory: boolean; size: number; mtimeMs: number }> => {
  const stat = await fs.stat(targetPath);
  return {
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
};

export const readJson = async <T = unknown>(filePath: string): Promise<T> => {
  const data = await readFile(filePath);
  return JSON.parse(data) as T;
};

export const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const DEFAULT_SEARCH_EXTENSIONS = [".ts", ".tsx", ".js", ".json", ".md"];
// Keep aligned with DEFAULT_IGNORE_DIRS in packages/core/src/context.ts.
const DEFAULT_SEARCH_IGNORE_DIRS = [".git", "node_modules", "dist", "build", ".next", ".turbo"];
const DEFAULT_MAX_FILE_SIZE_BYTES = 256 * 1024;
const DEFAULT_MAX_MATCHES = 200;
const DEFAULT_MAX_FILES = 2_000;
const DEFAULT_TIMEOUT_MS = 5_000;

export const searchFiles = async (
  directory: string,
  query: string,
  extensions: readonly string[] = DEFAULT_SEARCH_EXTENSIONS,
  options: SearchFilesOptions = {}
): Promise<SearchMatch[]> => {
  const matches: SearchMatch[] = [];
  const ignoreDirs = new Set([...DEFAULT_SEARCH_IGNORE_DIRS, ...(options.ignoreDirs ?? [])]);
  const maxFileSizeBytes = Math.max(1, options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES);
  const maxMatches = Math.max(1, options.maxMatches ?? DEFAULT_MAX_MATCHES);
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  let scannedFiles = 0;

  const shouldStop = (): boolean => scannedFiles >= maxFiles || matches.length >= maxMatches || Date.now() >= deadline;

  const walk = async (dir: string): Promise<void> => {
    if (shouldStop()) {
      return;
    }

    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldStop()) {
        return;
      }

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) {
          continue;
        }

        await walk(fullPath);
        continue;
      }

      if (extensions.length > 0 && !extensions.includes(path.extname(entry.name))) {
        continue;
      }

      scannedFiles += 1;
      const stat = await fs.stat(fullPath);
      if (stat.size > maxFileSizeBytes) {
        continue;
      }

      const content = await fs.readFile(fullPath, "utf8");
      const lines = content.split(/\r?\n/u);
      lines.forEach((lineText, index) => {
        if (matches.length < maxMatches && lineText.includes(query)) {
          matches.push({ file: fullPath, line: index + 1, text: lineText.trim() });
        }
      });
    }
  };

  await walk(directory);
  return matches;
};

// String / regex tools
export const replaceString = (input: string, search: string, replacement: string): string =>
  input.split(search).join(replacement);

export const replaceRegex = (input: string, pattern: string, replacement: string, flags = "g"): string =>
  input.replace(new RegExp(pattern, flags), replacement);

export const replaceLine = (input: string, lineNumber: number, replacement: string): string => {
  const lines = input.split(/\r?\n/u);
  if (lineNumber < 1 || lineNumber > lines.length) {
    throw new Error(`lineNumber out of range: ${lineNumber}`);
  }

  lines[lineNumber - 1] = replacement;
  return lines.join("\n");
};

export const replaceLineRange = (
  input: string,
  startLine: number,
  endLine: number,
  replacementLines: readonly string[]
): string => {
  const lines = input.split(/\r?\n/u);
  if (startLine < 1 || endLine > lines.length || startLine > endLine) {
    throw new Error(`Invalid line range: ${startLine}-${endLine}`);
  }

  lines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
  return lines.join("\n");
};

export const insertLine = (input: string, lineNumber: number, content: string): string => {
  const lines = input.split(/\r?\n/u);
  if (lineNumber < 1 || lineNumber > lines.length + 1) {
    throw new Error(`lineNumber out of range: ${lineNumber}`);
  }

  lines.splice(lineNumber - 1, 0, content);
  return lines.join("\n");
};

export const removeLine = (input: string, lineNumber: number): string => {
  const lines = input.split(/\r?\n/u);
  if (lineNumber < 1 || lineNumber > lines.length) {
    throw new Error(`lineNumber out of range: ${lineNumber}`);
  }

  lines.splice(lineNumber - 1, 1);
  return lines.join("\n");
};

// Coding helpers
export const formatJson = (input: string): string => JSON.stringify(JSON.parse(input), null, 2);

export const extractImports = (input: string): string[] => {
  const matches = input.match(/^\s*import\s.+$/gmu) ?? [];
  return matches.map((line) => line.trim());
};

export const countLines = (input: string): number => input.split(/\r?\n/u).length;

export const runLint = async (cwd = process.cwd(), policy: RunCommandPolicy = {}): Promise<string> => {
  const result = await runCommand("pnpm lint", { ...policy, allowList: ["pnpm"] }, cwd);
  return result.stdout;
};

export const runTypecheck = async (cwd = process.cwd(), policy: RunCommandPolicy = {}): Promise<string> => {
  const result = await runCommand("pnpm typecheck", { ...policy, allowList: ["pnpm"] }, cwd);
  return result.stdout;
};

// Git tools
export const gitStatus = async (cwd: string = process.cwd()): Promise<string> => {
  const { stdout } = await exec("git status --short", { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
};

export const gitDiff = async (cwd: string = process.cwd()): Promise<string> => {
  const { stdout } = await exec("git diff", { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
};

export const gitApplyPatch = async (patch: string, cwd: string = process.cwd()): Promise<void> => {
  const tempPatchFile = path.join(cwd, `.fusy-patch-${Date.now()}.patch`);
  await fs.writeFile(tempPatchFile, patch, "utf8");

  try {
    await exec(`git apply --whitespace=nowarn "${tempPatchFile}"`, { cwd, maxBuffer: 4 * 1024 * 1024 });
  } finally {
    await fs.rm(tempPatchFile, { force: true });
  }
};

export const gitAdd = async (files: readonly string[] = ["."], cwd = process.cwd()): Promise<void> => {
  const args = files.map((item) => `"${item}"`).join(" ");
  await runCommand(`git add ${args}`, { allowList: ["git"] }, cwd);
};

export const gitCommit = async (message: string, cwd = process.cwd()): Promise<void> => {
  const safeMessage = message.replaceAll('"', '\\"');
  await runCommand(`git commit -m "${safeMessage}"`, { allowList: ["git"] }, cwd);
};

export const gitLog = async (limit = 20, cwd = process.cwd()): Promise<string> => {
  const safeLimit = Math.max(1, Math.min(200, limit));
  const result = await runCommand(`git log --oneline -n ${safeLimit}`, { allowList: ["git"] }, cwd);
  return result.stdout;
};

export const gitBranchList = async (cwd = process.cwd()): Promise<string> => {
  const result = await runCommand("git branch --all", { allowList: ["git"] }, cwd);
  return result.stdout;
};

export const gitCheckout = async (branch: string, cwd = process.cwd()): Promise<string> => {
  const result = await runCommand(`git checkout ${branch}`, { allowList: ["git"] }, cwd);
  return result.stdout;
};

// Package manager tools
export const packageInstall = async (
  manager: "pnpm" | "npm" | "yarn",
  deps: readonly string[],
  cwd = process.cwd(),
  policy: RunCommandPolicy = {}
): Promise<string> => {
  const command =
    manager === "pnpm"
      ? `pnpm add ${deps.join(" ")}`
      : manager === "yarn"
        ? `yarn add ${deps.join(" ")}`
        : `npm install ${deps.join(" ")}`;

  const result = await runCommand(command, { ...policy, allowList: [manager] }, cwd);
  return result.stdout;
};

export const packageRemove = async (
  manager: "pnpm" | "npm" | "yarn",
  deps: readonly string[],
  cwd = process.cwd(),
  policy: RunCommandPolicy = {}
): Promise<string> => {
  const command =
    manager === "pnpm"
      ? `pnpm remove ${deps.join(" ")}`
      : manager === "yarn"
        ? `yarn remove ${deps.join(" ")}`
        : `npm uninstall ${deps.join(" ")}`;

  const result = await runCommand(command, { ...policy, allowList: [manager] }, cwd);
  return result.stdout;
};

export const packageRunScript = async (
  manager: "pnpm" | "npm" | "yarn",
  script: string,
  cwd = process.cwd(),
  policy: RunCommandPolicy = {}
): Promise<string> => {
  const command = manager === "npm" ? `npm run ${script}` : `${manager} ${script}`;
  const result = await runCommand(command, { ...policy, allowList: [manager] }, cwd);
  return result.stdout;
};

// Web tools (no search APIs)
export const fetchUrl = async (url: string): Promise<{ url: string; status: number; body: string }> => {
  const response = await fetch(url);
  const body = await response.text();
  return { url, status: response.status, body };
};

export const downloadFile = async (url: string, outputPath: string): Promise<void> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buffer);
};

export const searchWeb = async (query: string, maxResults = 5): Promise<Array<{ title: string; url: string }>> => {
  const endpoint = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = (await fetchUrl(endpoint)).body;
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gimu;

  const results: Array<{ title: string; url: string }> = [];
  for (const match of html.matchAll(re)) {
    const title = match[2].replace(/<[^>]+>/g, "").trim();
    results.push({ title, url: match[1] });
    if (results.length >= maxResults) {
      break;
    }
  }

  return results;
};

// Browser automation tools
export const browserOpenUrl = async (
  url: string,
  cwd = process.cwd(),
  policy: RunCommandPolicy = {}
): Promise<string> => {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const result = await runCommand(`${opener} "${url}"`, { ...policy, allowList: [opener] }, cwd);
  return result.stdout;
};

export const browserScreenshot = async (
  url: string,
  outPath: string,
  cwd = process.cwd(),
  policy: RunCommandPolicy = {}
): Promise<string> => {
  const command = `npx playwright screenshot --browser=chromium "${url}" "${outPath}"`;
  const result = await runCommand(command, { ...policy, allowList: ["npx"] }, cwd);
  return result.stdout;
};

// Cloud/deploy tools
export const deployVercel = async (cwd = process.cwd(), policy: RunCommandPolicy = {}): Promise<string> => {
  const result = await runCommand("npx vercel deploy --yes", { ...policy, allowList: ["npx"] }, cwd);
  return result.stdout;
};

export const deployNetlify = async (cwd = process.cwd(), policy: RunCommandPolicy = {}): Promise<string> => {
  const result = await runCommand("npx netlify deploy --prod", { ...policy, allowList: ["npx"] }, cwd);
  return result.stdout;
};

export const deployDocker = async (
  imageTag: string,
  cwd = process.cwd(),
  policy: RunCommandPolicy = {}
): Promise<string> => {
  const build = await runCommand(`docker build -t ${imageTag} .`, { ...policy, allowList: ["docker"] }, cwd);
  const push = await runCommand(`docker push ${imageTag}`, { ...policy, allowList: ["docker"] }, cwd);
  return `${build.stdout}\n${push.stdout}`.trim();
};

const toLocalPath = (cwd: string, rawPath: unknown): string => path.resolve(cwd, String(rawPath ?? "."));

export const DEFAULT_TOOL_REGISTRY: Record<string, ToolDefinition> = {
  readFile: {
    name: "readFile",
    description: "Read text content from a file path",
    execute: async (args, context) => readFile(toLocalPath(context.cwd, args.path))
  },
  writeFile: {
    name: "writeFile",
    description: "Write text content to a file path",
    execute: async (args, context) => writeFile(toLocalPath(context.cwd, args.path), String(args.content ?? ""))
  },
  appendFile: {
    name: "appendFile",
    description: "Append text content to file",
    execute: async (args, context) => appendFile(toLocalPath(context.cwd, args.path), String(args.content ?? ""))
  },
  updateFile: {
    name: "updateFile",
    description: "Overwrite file using provided content",
    execute: async (args, context) =>
      updateFile(toLocalPath(context.cwd, args.path), async () => String(args.content ?? ""))
  },
  deleteFile: {
    name: "deleteFile",
    description: "Delete a file",
    execute: async (args, context) => deleteFile(toLocalPath(context.cwd, args.path))
  },
  touchFile: {
    name: "touchFile",
    description: "Create file if missing",
    execute: async (args, context) => touchFile(toLocalPath(context.cwd, args.path))
  },
  makeDir: {
    name: "makeDir",
    description: "Create directory recursively",
    execute: async (args, context) => makeDir(toLocalPath(context.cwd, args.path))
  },
  deleteDir: {
    name: "deleteDir",
    description: "Delete directory recursively",
    execute: async (args, context) => deleteDir(toLocalPath(context.cwd, args.path))
  },
  movePath: {
    name: "movePath",
    description: "Move file or directory",
    execute: async (args, context) => movePath(toLocalPath(context.cwd, args.from), toLocalPath(context.cwd, args.to))
  },
  copyPath: {
    name: "copyPath",
    description: "Copy file or directory",
    execute: async (args, context) => copyPath(toLocalPath(context.cwd, args.from), toLocalPath(context.cwd, args.to))
  },
  listDir: {
    name: "listDir",
    description: "List direct children in directory",
    execute: async (args, context) => listDir(toLocalPath(context.cwd, args.path))
  },
  listDirRecursive: {
    name: "listDirRecursive",
    description: "List all nested paths under directory",
    execute: async (args, context) => listDirRecursive(toLocalPath(context.cwd, args.path))
  },
  pathExists: {
    name: "pathExists",
    description: "Check if file or directory exists",
    execute: async (args, context) => pathExists(toLocalPath(context.cwd, args.path))
  },
  statPath: {
    name: "statPath",
    description: "Get file/dir metadata",
    execute: async (args, context) => statPath(toLocalPath(context.cwd, args.path))
  },
  readJson: {
    name: "readJson",
    description: "Read JSON file",
    execute: async (args, context) => readJson(toLocalPath(context.cwd, args.path))
  },
  writeJson: {
    name: "writeJson",
    description: "Write JSON file",
    execute: async (args, context) => writeJson(toLocalPath(context.cwd, args.path), args.value)
  },
  searchFiles: {
    name: "searchFiles",
    description: "Search text recursively across files",
    execute: async (args, context) =>
      searchFiles(
        toLocalPath(context.cwd, args.path),
        String(args.query ?? ""),
        Array.isArray(args.extensions) ? args.extensions.map((item) => String(item)) : undefined,
        {
          ignoreDirs: Array.isArray(args.ignoreDirs) ? args.ignoreDirs.map((item) => String(item)) : undefined,
          maxFileSizeBytes:
            typeof args.maxFileSizeBytes === "number" && Number.isFinite(args.maxFileSizeBytes)
              ? args.maxFileSizeBytes
              : undefined,
          maxMatches:
            typeof args.maxMatches === "number" && Number.isFinite(args.maxMatches) ? args.maxMatches : undefined,
          maxFiles: typeof args.maxFiles === "number" && Number.isFinite(args.maxFiles) ? args.maxFiles : undefined,
          timeoutMs: typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) ? args.timeoutMs : undefined
        }
      )
  },
  replaceString: {
    name: "replaceString",
    description: "Replace all string matches",
    execute: async (args) => replaceString(String(args.input ?? ""), String(args.search ?? ""), String(args.replacement ?? ""))
  },
  replaceRegex: {
    name: "replaceRegex",
    description: "Replace by regular expression",
    execute: async (args) =>
      replaceRegex(String(args.input ?? ""), String(args.pattern ?? ""), String(args.replacement ?? ""), String(args.flags ?? "g"))
  },
  replaceLine: {
    name: "replaceLine",
    description: "Replace one line",
    execute: async (args) => replaceLine(String(args.input ?? ""), Number(args.lineNumber), String(args.replacement ?? ""))
  },
  replaceLineRange: {
    name: "replaceLineRange",
    description: "Replace line range",
    execute: async (args) =>
      replaceLineRange(
        String(args.input ?? ""),
        Number(args.startLine),
        Number(args.endLine),
        Array.isArray(args.replacementLines) ? args.replacementLines.map((item) => String(item)) : [String(args.replacement ?? "")]
      )
  },
  insertLine: {
    name: "insertLine",
    description: "Insert a line",
    execute: async (args) => insertLine(String(args.input ?? ""), Number(args.lineNumber), String(args.content ?? ""))
  },
  removeLine: {
    name: "removeLine",
    description: "Remove a line",
    execute: async (args) => removeLine(String(args.input ?? ""), Number(args.lineNumber))
  },
  formatJson: {
    name: "formatJson",
    description: "Pretty-print JSON string",
    execute: async (args) => formatJson(String(args.input ?? "{}"))
  },
  extractImports: {
    name: "extractImports",
    description: "Extract import statements",
    execute: async (args) => extractImports(String(args.input ?? ""))
  },
  countLines: {
    name: "countLines",
    description: "Count lines in text",
    execute: async (args) => countLines(String(args.input ?? ""))
  },
  runLint: {
    name: "runLint",
    description: "Run lint via pnpm",
    execute: async (_, context) => runLint(context.cwd, context.policy)
  },
  runTypecheck: {
    name: "runTypecheck",
    description: "Run typecheck via pnpm",
    execute: async (_, context) => runTypecheck(context.cwd, context.policy)
  },
  gitStatus: {
    name: "gitStatus",
    description: "Show git status",
    execute: async (_, context) => gitStatus(context.cwd)
  },
  gitDiff: {
    name: "gitDiff",
    description: "Show git diff",
    execute: async (_, context) => gitDiff(context.cwd)
  },
  gitApplyPatch: {
    name: "gitApplyPatch",
    description: "Apply patch text",
    execute: async (args, context) => gitApplyPatch(String(args.patch ?? ""), context.cwd)
  },
  gitAdd: {
    name: "gitAdd",
    description: "Stage files",
    execute: async (args, context) =>
      gitAdd(Array.isArray(args.files) ? args.files.map((item) => String(item)) : ["."], context.cwd)
  },
  gitCommit: {
    name: "gitCommit",
    description: "Create commit",
    execute: async (args, context) => gitCommit(String(args.message ?? "update"), context.cwd)
  },
  gitLog: {
    name: "gitLog",
    description: "Read commit log",
    execute: async (args, context) => gitLog(Number(args.limit ?? 20), context.cwd)
  },
  gitBranchList: {
    name: "gitBranchList",
    description: "List git branches",
    execute: async (_, context) => gitBranchList(context.cwd)
  },
  gitCheckout: {
    name: "gitCheckout",
    description: "Checkout branch",
    execute: async (args, context) => gitCheckout(String(args.branch ?? ""), context.cwd)
  },
  packageInstall: {
    name: "packageInstall",
    description: "Install dependencies",
    execute: async (args, context) =>
      packageInstall(
        (args.manager as "pnpm" | "npm" | "yarn") ?? "pnpm",
        Array.isArray(args.deps) ? args.deps.map((item) => String(item)) : [],
        context.cwd,
        context.policy
      )
  },
  packageRemove: {
    name: "packageRemove",
    description: "Remove dependencies",
    execute: async (args, context) =>
      packageRemove(
        (args.manager as "pnpm" | "npm" | "yarn") ?? "pnpm",
        Array.isArray(args.deps) ? args.deps.map((item) => String(item)) : [],
        context.cwd,
        context.policy
      )
  },
  packageRunScript: {
    name: "packageRunScript",
    description: "Run package script",
    execute: async (args, context) =>
      packageRunScript(
        (args.manager as "pnpm" | "npm" | "yarn") ?? "pnpm",
        String(args.script ?? "build"),
        context.cwd,
        context.policy
      )
  },
  runCommand: {
    name: "runCommand",
    description: "Run shell command with policy gate",
    execute: async (args, context) => runCommand(String(args.command ?? ""), context.policy, context.cwd)
  },
  fetchUrl: {
    name: "fetchUrl",
    description: "Fetch raw URL body",
    execute: async (args) => fetchUrl(String(args.url ?? ""))
  },
  downloadFile: {
    name: "downloadFile",
    description: "Download URL to local path",
    execute: async (args, context) => downloadFile(String(args.url ?? ""), toLocalPath(context.cwd, args.outPath))
  },
  searchWeb: {
    name: "searchWeb",
    description: "Search web by scraping HTML results",
    execute: async (args) => searchWeb(String(args.query ?? ""), Number(args.maxResults ?? 5))
  },
  browserOpenUrl: {
    name: "browserOpenUrl",
    description: "Open URL in local browser",
    execute: async (args, context) => browserOpenUrl(String(args.url ?? ""), context.cwd, context.policy)
  },
  browserScreenshot: {
    name: "browserScreenshot",
    description: "Take screenshot with Playwright CLI",
    execute: async (args, context) =>
      browserScreenshot(String(args.url ?? ""), toLocalPath(context.cwd, args.outPath ?? "screenshot.png"), context.cwd, context.policy)
  },
  deployVercel: {
    name: "deployVercel",
    description: "Deploy to Vercel",
    execute: async (_, context) => deployVercel(context.cwd, context.policy)
  },
  deployNetlify: {
    name: "deployNetlify",
    description: "Deploy to Netlify",
    execute: async (_, context) => deployNetlify(context.cwd, context.policy)
  },
  deployDocker: {
    name: "deployDocker",
    description: "Build + push Docker image",
    execute: async (args, context) => deployDocker(String(args.imageTag ?? ""), context.cwd, context.policy)
  }
};

export const executeTool = async (
  name: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<unknown> => {
  const tool = DEFAULT_TOOL_REGISTRY[name];
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  return tool.execute(args, context);
};
