import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "json" | "pretty";

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  message: string;
  requestId: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  meta?: Record<string, unknown>;
}

export interface LoggerOptions {
  format?: LogFormat;
  requestId?: string;
}

const toPretty = (record: LogRecord): string => {
  const usage =
    record.tokensIn !== undefined || record.tokensOut !== undefined
      ? ` tokens(in=${record.tokensIn ?? 0},out=${record.tokensOut ?? 0},cost=$${(record.costUsd ?? 0).toFixed(6)})`
      : "";

  return `${record.timestamp} ${record.level.toUpperCase()} [${record.requestId}] ${record.message}${usage}`;
};

export class Logger {
  private readonly requestId: string;
  private readonly format: LogFormat;

  constructor(options: LoggerOptions = {}) {
    this.requestId = options.requestId ?? randomUUID();
    this.format = options.format ?? (process.env.FUSY_LOG_FORMAT === "pretty" ? "pretty" : "json");
  }

  child(meta: Record<string, unknown>): Logger {
    const logger = new Logger({ format: this.format, requestId: this.requestId });
    logger.debug("logger.child", { meta });
    return logger;
  }

  getRequestId(): string {
    return this.requestId;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write("debug", message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write("error", message, meta);
  }

  usage(message: string, usage: { tokensIn: number; tokensOut: number; costUsd: number }, meta?: Record<string, unknown>): void {
    this.write("info", message, { ...meta, usage }, usage);
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>, usage?: { tokensIn: number; tokensOut: number; costUsd: number }): void {
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      message,
      requestId: this.requestId,
      meta,
      tokensIn: usage?.tokensIn,
      tokensOut: usage?.tokensOut,
      costUsd: usage?.costUsd
    };

    const line = this.format === "pretty" ? toPretty(record) : JSON.stringify(record);
    const writer = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    writer(line);
  }
}

export interface TraceEvent {
  ts: string;
  requestId: string;
  event: string;
  payload?: Record<string, unknown>;
}

export const exportDebugTrace = async (events: readonly TraceEvent[], traceFilePath = path.join(process.cwd(), ".fusy", "trace.jsonl")): Promise<string> => {
  await mkdir(path.dirname(traceFilePath), { recursive: true });
  const lines = events.map((event) => `${JSON.stringify(event)}\n`).join("");
  await appendFile(traceFilePath, lines, "utf8");
  return traceFilePath;
};

export const logInfo = (message: string): void => {
  new Logger({ format: "pretty" }).info(message);
};
