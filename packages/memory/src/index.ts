import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface SessionRecord {
  id: string;
  status: "active" | "paused" | "completed";
  intent?: string;
  plan?: string;
  summary?: string;
  checkpoint?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryRecord {
  key: string;
  value: string;
  sensitive: boolean;
  updatedAt: number;
}

export interface MemoryStoreOptions {
  dbPath?: string;
  encryptionKey?: string;
}

type StoredValue = { encrypted: false; value: string } | { encrypted: true; payload: string };

const encodeStoredValue = (value: StoredValue): string => JSON.stringify(value);

const decodeStoredValue = (input: string): StoredValue => {
  try {
    const parsed = JSON.parse(input) as StoredValue;
    if (parsed && typeof parsed === "object" && "encrypted" in parsed) {
      return parsed;
    }
  } catch {
    // keep backwards-compatible with plaintext values
  }

  return { encrypted: false, value: input };
};

class FieldEncryptor {
  private readonly key?: Buffer;

  constructor(secret?: string) {
    if (!secret) {
      return;
    }

    this.key = createHash("sha256").update(secret).digest();
  }

  canEncrypt(): boolean {
    return this.key !== undefined;
  }

  encrypt(plaintext: string): string {
    if (!this.key) {
      return encodeStoredValue({ encrypted: false, value: plaintext });
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return encodeStoredValue({
      encrypted: true,
      payload: `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`
    });
  }

  decrypt(stored: string): string {
    const decoded = decodeStoredValue(stored);
    if (!decoded.encrypted) {
      return decoded.value;
    }

    if (!this.key) {
      throw new Error("Encrypted record found but no encryption key configured");
    }

    const [ivText, tagText, encryptedText] = decoded.payload.split(".");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivText, "base64"));
    decipher.setAuthTag(Buffer.from(tagText, "base64"));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedText, "base64")),
      decipher.final()
    ]);

    return decrypted.toString("utf8");
  }
}

export class SqliteMemoryStore {
  private readonly db: DatabaseSync;
  private readonly encryptor: FieldEncryptor;

  constructor(options: MemoryStoreOptions = {}) {
    const dbPath = options.dbPath ?? path.join(process.cwd(), ".fusy", "memory.sqlite");
    mkdirSync(path.dirname(dbPath), { recursive: true });

    this.encryptor = new FieldEncryptor(options.encryptionKey ?? process.env.FUSY_MEMORY_KEY);
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        intent TEXT,
        plan TEXT,
        summary TEXT,
        checkpoint TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_prefs (
        user_id TEXT NOT NULL,
        pref_key TEXT NOT NULL,
        pref_value TEXT NOT NULL,
        sensitive INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, pref_key)
      );

      CREATE TABLE IF NOT EXISTS project_memory (
        project_id TEXT NOT NULL,
        mem_key TEXT NOT NULL,
        mem_value TEXT NOT NULL,
        sensitive INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, mem_key)
      );
    `);
  }

  upsertSession(session: Pick<SessionRecord, "id"> & Partial<SessionRecord>): SessionRecord {
    const now = Date.now();
    const status = session.status ?? "active";

    this.db
      .prepare(
        `INSERT INTO sessions (id, status, intent, plan, summary, checkpoint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           intent = COALESCE(excluded.intent, sessions.intent),
           plan = COALESCE(excluded.plan, sessions.plan),
           summary = COALESCE(excluded.summary, sessions.summary),
           checkpoint = COALESCE(excluded.checkpoint, sessions.checkpoint),
           updated_at = excluded.updated_at`
      )
      .run(
        session.id,
        status,
        session.intent ?? null,
        session.plan ?? null,
        session.summary ?? null,
        session.checkpoint ?? null,
        now,
        now
      );

    const record = this.getSession(session.id);
    if (!record) {
      throw new Error(`Failed to upsert session ${session.id}`);
    }

    return record;
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      status: row.status as SessionRecord["status"],
      intent: (row.intent as string | null) ?? undefined,
      plan: (row.plan as string | null) ?? undefined,
      summary: (row.summary as string | null) ?? undefined,
      checkpoint: (row.checkpoint as string | null) ?? undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }

  listSessions(limit = 50): SessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: String(row.id),
      status: row.status as SessionRecord["status"],
      intent: (row.intent as string | null) ?? undefined,
      plan: (row.plan as string | null) ?? undefined,
      summary: (row.summary as string | null) ?? undefined,
      checkpoint: (row.checkpoint as string | null) ?? undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    }));
  }

  setUserPreference(userId: string, key: string, value: string, sensitive = false): void {
    const storedValue = sensitive ? this.encryptor.encrypt(value) : encodeStoredValue({ encrypted: false, value });
    this.db
      .prepare(
        `INSERT INTO user_prefs (user_id, pref_key, pref_value, sensitive, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, pref_key) DO UPDATE SET
           pref_value = excluded.pref_value,
           sensitive = excluded.sensitive,
           updated_at = excluded.updated_at`
      )
      .run(userId, key, storedValue, sensitive ? 1 : 0, Date.now());
  }

  listUserPreferences(userId: string): MemoryRecord[] {
    const rows = this.db
      .prepare("SELECT pref_key, pref_value, sensitive, updated_at FROM user_prefs WHERE user_id = ? ORDER BY pref_key")
      .all(userId) as Record<string, unknown>[];

    return rows.map((row) => ({
      key: String(row.pref_key),
      value: this.encryptor.decrypt(String(row.pref_value)),
      sensitive: Number(row.sensitive) === 1,
      updatedAt: Number(row.updated_at)
    }));
  }

  setProjectMemory(projectId: string, key: string, value: string, sensitive = false): void {
    const shouldEncrypt = sensitive && this.encryptor.canEncrypt();
    const storedValue = shouldEncrypt
      ? this.encryptor.encrypt(value)
      : encodeStoredValue({ encrypted: false, value });

    this.db
      .prepare(
        `INSERT INTO project_memory (project_id, mem_key, mem_value, sensitive, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, mem_key) DO UPDATE SET
           mem_value = excluded.mem_value,
           sensitive = excluded.sensitive,
           updated_at = excluded.updated_at`
      )
      .run(projectId, key, storedValue, sensitive ? 1 : 0, Date.now());
  }

  listProjectMemory(projectId: string): MemoryRecord[] {
    const rows = this.db
      .prepare("SELECT mem_key, mem_value, sensitive, updated_at FROM project_memory WHERE project_id = ? ORDER BY mem_key")
      .all(projectId) as Record<string, unknown>[];

    return rows.map((row) => ({
      key: String(row.mem_key),
      value: this.encryptor.decrypt(String(row.mem_value)),
      sensitive: Number(row.sensitive) === 1,
      updatedAt: Number(row.updated_at)
    }));
  }

  clearMemory(projectId?: string): void {
    if (projectId) {
      this.db.prepare("DELETE FROM project_memory WHERE project_id = ?").run(projectId);
      return;
    }

    this.db.exec("DELETE FROM project_memory; DELETE FROM user_prefs;");
  }

  close(): void {
    this.db.close();
  }
}
