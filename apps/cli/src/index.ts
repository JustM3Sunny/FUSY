import path from "node:path";
import readline from "node:readline/promises";

import { ContextPacker, HybridRetriever, RepositoryIndexer } from "@fusy/core";
import { SqliteMemoryStore } from "@fusy/memory";
import { Logger, exportDebugTrace, type TraceEvent } from "@fusy/telemetry";
import { executeTool, type RunCommandPolicy, type ToolExecutionContext } from "@fusy/tools";

export const printHelp = (): void => {
  console.log(`FUSY CLI

Commands:
  pair [intent...]               Start a new paired session.
  run <command...>               Execute a shell command and capture output in session memory.
    --require-approval <bool>    Require confirmation before command execution.
    --allow-list <csv>           Comma-separated list of allowed binaries.
    --deny-list <csv>            Comma-separated list of denied/destructive binaries.
  resume <sessionId>             Resume an existing session.
  sessions                       List sessions.
  memory list [projectId]        List project memory entries.
  memory clear [projectId]       Clear all memory or memory for one project.
`);
};

type ParsedCliArgs = {
  flags: Record<string, string>;
  positionalArgs: string[];
};

type CommandAuditDecision = "auto-approved" | "approved" | "denied";

type CommandExecutionResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
};

const getRawFlagValue = (argv: string[], name: string): string | undefined => {
  const index = argv.findIndex((arg) => arg === `--${name}`);
  if (index < 0) {
    return undefined;
  }

  return argv[index + 1];
};

const parseCliArgs = (argv: string[], knownFlags: string[]): ParsedCliArgs => {
  const knownFlagSet = new Set(knownFlags);
  const flags: Record<string, string> = {};
  const positionalArgs: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionalArgs.push(arg);
      continue;
    }

    const name = arg.slice(2);
    if (!knownFlagSet.has(name)) {
      positionalArgs.push(arg);
      continue;
    }

    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}. Example: --${name} <value>`);
    }

    flags[name] = value;
    i += 1;
  }

  return { flags, positionalArgs };
};

const parseBooleanFlag = (input: string | undefined): boolean | undefined => {
  if (input === undefined) {
    return undefined;
  }

  const normalized = input.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no", "n"].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean value: ${input}`);
};

const parseCsvFlag = (input: string | undefined): string[] | undefined => {
  if (!input) {
    return undefined;
  }

  const values = input
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return values.length > 0 ? values : undefined;
};

const parseCsvEnv = (name: string): string[] | undefined => parseCsvFlag(process.env[name]);

const shouldPromptForApproval = (errorMessage: string): boolean =>
  errorMessage.includes("Command denied by policy") || errorMessage.includes("Command requires approval");

const requestApproval = async (command: string): Promise<boolean> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Command blocked by policy. Approve execution?\n> ${command}\nType 'yes' to approve: `);
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
};

const resolveRunCommandPolicy = (flags: Record<string, string>): RunCommandPolicy => ({
  requireApproval: parseBooleanFlag(flags["require-approval"]) ?? parseBooleanFlag(process.env.FUSY_REQUIRE_APPROVAL) ?? false,
  allowList: parseCsvFlag(flags["allow-list"]) ?? parseCsvEnv("FUSY_ALLOW_LIST"),
  denyList: parseCsvFlag(flags["deny-list"]) ?? parseCsvEnv("FUSY_DENY_LIST")
});

const executeWithPolicy = async (
  command: string,
  context: ToolExecutionContext
): Promise<{ decision: CommandAuditDecision; result: CommandExecutionResult }> => {
  try {
    const response = await executeTool("runCommand", { command }, context);
    const output = response as { stdout?: string; stderr?: string };
    return {
      decision: "auto-approved",
      result: { success: true, stdout: output.stdout ?? "", stderr: output.stderr ?? "" }
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    if (!shouldPromptForApproval(message)) {
      return {
        decision: "auto-approved",
        result: { success: false, stdout: "", stderr: message, error: message }
      };
    }

    const approved = await requestApproval(command);
    if (!approved) {
      return {
        decision: "denied",
        result: { success: false, stdout: "", stderr: message, error: "Command denied by user" }
      };
    }

    const approvedContext: ToolExecutionContext = {
      ...context,
      policy: { ...(context.policy ?? {}), approved: true }
    };

    try {
      const response = await executeTool("runCommand", { command }, approvedContext);
      const output = response as { stdout?: string; stderr?: string };
      return {
        decision: "approved",
        result: { success: true, stdout: output.stdout ?? "", stderr: output.stderr ?? "" }
      };
    } catch (approvedError: unknown) {
      const approvedMessage = approvedError instanceof Error ? approvedError.message : String(approvedError);
      return {
        decision: "approved",
        result: { success: false, stdout: "", stderr: approvedMessage, error: approvedMessage }
      };
    }
  }
};

const getMemoryStore = (): SqliteMemoryStore =>
  new SqliteMemoryStore({
    dbPath: path.join(process.cwd(), ".fusy", "memory.sqlite")
  });

const createSessionId = (): string => `session-${Date.now()}`;

const traceEvent = (events: TraceEvent[], requestId: string, event: string, payload?: Record<string, unknown>): void => {
  events.push({ ts: new Date().toISOString(), requestId, event, payload });
};

const handlePair = async (argv: string[], logger: Logger, traces: TraceEvent[]): Promise<void> => {
  const parsedArgs = parseCliArgs(argv, ["session"]);
  const memory = getMemoryStore();
  const sessionId = parsedArgs.flags.session ?? createSessionId();
  const intent = parsedArgs.positionalArgs.join(" ").trim() || "Pairing task";

  traceEvent(traces, logger.getRequestId(), "pair.start", { sessionId, intent });
  memory.upsertSession({ id: sessionId, intent, status: "active" });

  const indexer = new RepositoryIndexer();
  const index = await indexer.index(process.cwd());
  const retriever = new HybridRetriever();
  const retrieval = await retriever.search(
    intent,
    index.files.slice(0, 30).map((file) => ({ id: file.path, text: `${file.path} ${file.extension}`, path: file.path }))
  );

  const packer = new ContextPacker();
  const packed = packer.pack(
    retrieval.map((item, i) => ({ id: item.candidate.id, text: item.candidate.text, priority: Math.max(1, 10 - i) })),
    { tokenBudget: 800, reservedTokens: 200 }
  );

  memory.setProjectMemory(process.cwd(), `session:${sessionId}:context`, JSON.stringify(packed), true);

  logger.info("Started pairing session", { sessionId, indexedFiles: index.files.length, symbols: index.symbols.length });
  logger.usage("context-packed", { tokensIn: packed.usedTokens, tokensOut: 0, costUsd: 0 }, { dropped: packed.droppedChunkIds.length });
  memory.close();
};

const handleRun = async (argv: string[], logger: Logger, traces: TraceEvent[]): Promise<number> => {
  const parsedArgs = parseCliArgs(argv, ["session", "require-approval", "allow-list", "deny-list"]);
  const memory = getMemoryStore();
  const sessionId = parsedArgs.flags.session ?? createSessionId();
  const command = parsedArgs.positionalArgs.join(" ").trim();

  if (!command) {
    throw new Error("run requires a shell command");
  }

  memory.upsertSession({ id: sessionId, status: "active", plan: `run ${command}` });
  const policy = resolveRunCommandPolicy(parsedArgs.flags);
  const { decision, result } = await executeWithPolicy(command, { cwd: process.cwd(), policy });

  traceEvent(traces, logger.getRequestId(), "run.command", {
    sessionId,
    command,
    decision,
    success: result.success
  });

  const decisionRecord = {
    command,
    decision,
    policy,
    timestamp: new Date().toISOString()
  };

  const resultRecord = {
    command,
    success: result.success,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
    timestamp: new Date().toISOString()
  };

  memory.setProjectMemory(process.cwd(), `session:${sessionId}:last-decision`, JSON.stringify(decisionRecord), true);
  memory.setProjectMemory(process.cwd(), `session:${sessionId}:last-run`, JSON.stringify(resultRecord), true);

  memory.upsertSession({
    id: sessionId,
    status: result.success ? "completed" : "paused",
    summary: result.success ? `Command succeeded: ${command}` : `Command failed: ${command}`
  });

  logger.info("run completed", { sessionId, command, decision, success: result.success });
  memory.close();
  return result.success ? 0 : 1;
};

const handleResume = (sessionId: string | undefined, logger: Logger): void => {
  if (!sessionId) {
    throw new Error("resume requires a sessionId");
  }

  const memory = getMemoryStore();
  const session = memory.getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  memory.upsertSession({ id: sessionId, status: "active" });
  logger.info("session resumed", { sessionId });
  console.log(JSON.stringify(session, null, 2));
  memory.close();
};

const handleSessions = (): void => {
  const memory = getMemoryStore();
  const sessions = memory.listSessions();
  console.table(
    sessions.map((session) => ({
      id: session.id,
      status: session.status,
      intent: session.intent ?? "",
      updatedAt: new Date(session.updatedAt).toISOString()
    }))
  );
  memory.close();
};

const handleMemory = (argv: string[]): void => {
  const subcommand = argv[0];
  const projectId = argv[1] ?? process.cwd();
  const memory = getMemoryStore();

  if (subcommand === "list") {
    const rows = memory.listProjectMemory(projectId);
    console.table(rows);
  } else if (subcommand === "clear") {
    const scope = argv[1];
    memory.clearMemory(scope);
    console.log(scope ? `Cleared memory for ${scope}` : "Cleared all memory");
  } else {
    throw new Error("memory requires subcommand: list|clear");
  }

  memory.close();
};

export const executeCli = async (argv: string[]): Promise<number> => {
  const [command, ...rest] = argv;
  const logger = new Logger();
  const traces: TraceEvent[] = [];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  if (command === "pair") {
    await handlePair(rest, logger, traces);
  } else if (command === "run") {
    const code = await handleRun(rest, logger, traces);
    if (code !== 0) {
      await exportDebugTrace(traces);
      return code;
    }
  } else if (command === "resume") {
    handleResume(rest[0], logger);
  } else if (command === "sessions") {
    handleSessions();
  } else if (command === "memory") {
    handleMemory(rest);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }

  if (getRawFlagValue(rest, "trace") === "true") {
    const tracePath = await exportDebugTrace(traces);
    logger.info("trace exported", { tracePath });
  }

  return 0;
};

const isMain = process.argv[1] && path.resolve(process.argv[1]).includes(`${path.sep}apps${path.sep}cli${path.sep}`);

if (isMain) {
  void executeCli(process.argv.slice(2)).then((code) => {
    if (code !== 0) {
      process.exit(code);
    }
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
