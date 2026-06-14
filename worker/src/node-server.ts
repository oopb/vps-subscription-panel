import Database from "better-sqlite3";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import worker from "./index";
import migrationSql from "../migrations/0001_schema.sql";

type QueryValue = string | number | boolean | null;

class SqliteD1Database {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(migrationSql);
  }

  prepare(sql: string): SqliteD1PreparedStatement {
    return new SqliteD1PreparedStatement(this.db, sql);
  }
}

class SqliteD1PreparedStatement {
  private values: QueryValue[] = [];

  constructor(
    private readonly db: Database.Database,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): SqliteD1PreparedStatement {
    this.values = values.map((value) => normalizeBinding(value));
    return this;
  }

  first<T = unknown>(): T | null {
    return (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }

  all<T = unknown>(): { results: T[] } {
    return { results: this.db.prepare(this.sql).all(...this.values) as T[] };
  }

  run(): { success: true; meta: { changes: number; last_row_id: number | bigint } } {
    const result = this.db.prepare(this.sql).run(...this.values);
    return {
      success: true,
      meta: {
        changes: result.changes,
        last_row_id: result.lastInsertRowid,
      },
    };
  }
}

function normalizeBinding(value: unknown): QueryValue {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || "3000");
const dbPath = resolve(process.env.DB_PATH || "./data/panel.sqlite");
const db = new SqliteD1Database(dbPath);
const env = {
  DB: db as unknown as D1Database,
  ADMIN_USERNAME: process.env.ADMIN_USERNAME,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
};

createServer(async (incoming, outgoing) => {
  try {
    const request = await toRequest(incoming);
    const response = await worker.fetch(request, env);
    await writeResponse(outgoing, response);
  } catch (error) {
    console.error(error);
    outgoing.statusCode = 500;
    outgoing.setHeader("content-type", "application/json; charset=utf-8");
    outgoing.end(JSON.stringify({ error: "Internal server error" }));
  }
}).listen(port, host, () => {
  console.log(`VPS subscription panel listening on http://${host}:${port}`);
  console.log(`SQLite database: ${dbPath}`);
});

async function toRequest(incoming: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const hostHeader = headers.get("host") || `${host}:${port}`;
  const proto = firstHeaderValue(headers.get("x-forwarded-proto")) || "http";
  const url = new URL(incoming.url || "/", `${proto}://${hostHeader}`);
  const body = incoming.method === "GET" || incoming.method === "HEAD" ? undefined : await readBody(incoming);

  return new Request(url, {
    method: incoming.method || "GET",
    headers,
    body,
  });
}

function firstHeaderValue(value: string | null): string | null {
  return value ? value.split(",")[0]?.trim() || null : null;
}

function readBody(incoming: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    incoming.on("end", () => resolveBody(Buffer.concat(chunks)));
    incoming.on("error", reject);
  });
}

async function writeResponse(outgoing: ServerResponse, response: Response): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, key) => {
    outgoing.setHeader(key, value);
  });
  const body = Buffer.from(await response.arrayBuffer());
  outgoing.end(body);
}
