import { spawn } from "node:child_process";
import path from "node:path";

import { ContextPacker, HybridRetriever, RepositoryIndexer } from "@fusy/core";
import { SqliteMemoryStore } from "@fusy/memory";
import { Logger, exportDebugTrace, type TraceEvent } from "@fusy/telemetry";

export const printHelp = (): void => {
  console.log(`FUSY CLI

Commands:
  pair [intent...]               Start a new paired session.
  run <command...>               Execute a shell command and capture output in session memory.
  resume <sessionId>             Resume an existing session.
  sessions                       List sessions.
  memory list [projectId]        List project memory entries.
  memory clear [projectId]       Clear all memory or memory for one project.
`);
};

const parseFlag = (argv: string[], name: string): string | undefined => {
  const index = argv.findIndex((arg) => arg === `--${name}`);
  if (index < 0) {
    return undefined;
  }

  return argv[index + 1];
};

const runCommand = async (command: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });

const getMemoryStore = (): SqliteMemoryStore =>
  new SqliteMemoryStore({
    dbPath: path.join(process.cwd(), ".fusy", "memory.sqlite")
  });

const createSessionId = (): string => `session-${Date.now()}`;

const traceEvent = (events: TraceEvent[], requestId: string, event: string, payload?: Record<string, unknown>): void => {
  events.push({ ts: new Date().toISOString(), requestId, event, payload });
};

const handlePair = async (argv: string[], logger: Logger, traces: TraceEvent[]): Promise<void> => {
  const memory = getMemoryStore();
  const sessionId = parseFlag(argv, "session") ?? createSessionId();
  const intent = argv.filter((arg) => !arg.startsWith("--")).join(" ").trim() || "Pairing task";

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
  const memory = getMemoryStore();
  const sessionId = parseFlag(argv, "session") ?? createSessionId();
  const command = argv.filter((arg) => !arg.startsWith("--")).join(" ").trim();

  if (!command) {
    throw new Error("run requires a shell command");
  }

  memory.upsertSession({ id: sessionId, status: "active", plan: `run ${command}` });
  const result = await runCommand(command, process.cwd());
  traceEvent(traces, logger.getRequestId(), "run.command", { sessionId, command, code: result.code });

  memory.setProjectMemory(process.cwd(), `session:${sessionId}:last-run`, JSON.stringify({ command, ...result }), true);

  memory.upsertSession({
    id: sessionId,
    status: result.code === 0 ? "completed" : "paused",
    summary: result.code === 0 ? `Command succeeded: ${command}` : `Command failed (${result.code}): ${command}`
  });

  logger.info("run completed", { sessionId, command, code: result.code });
  memory.close();
  return result.code;
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

  if (parseFlag(rest, "trace") === "true") {
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
