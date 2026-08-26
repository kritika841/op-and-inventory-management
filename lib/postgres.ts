import postgres, { type Sql } from "postgres";

export interface DatabaseResult<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta?: { changes?: number };
}

export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<DatabaseResult<T>>;
  run<T = Record<string, unknown>>(): Promise<DatabaseResult<T>>;
}

export interface AppDatabase {
  prepare(query: string): PreparedStatement;
  batch<T = Record<string, unknown>>(statements: PreparedStatement[]): Promise<Array<DatabaseResult<T>>>;
}

const clients = new Map<string, Sql>();

function clientFor(connectionString: string) {
  let client = clients.get(connectionString);
  if (!client) {
    client = postgres(connectionString, {
      // Authentication, realtime refreshes and a paginated operational queue
      // must not queue behind one slow dashboard query. A small bounded pool
      // preserves connection discipline while isolating those critical paths.
      max: 5,
      // Rotate pooler connections regularly. This avoids reusing a socket
      // that a proxy or network transition has silently dropped.
      idle_timeout: 10,
      max_lifetime: 60,
      connect_timeout: 5,
      fetch_types: false,
      prepare: false,
      ssl: "require",
    });
    clients.set(connectionString, client);
  }
  return client;
}

function discardClient(connectionString: string) {
  const client = clients.get(connectionString);
  clients.delete(connectionString);
  if (client) void client.end({ timeout: 1 }).catch(() => undefined);
}

function isTransientConnectionError(error: unknown) {
  const code = String((error as { code?: unknown })?.code ?? "");
  return ["ENOTFOUND", "ENETUNREACH", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "CONNECT_TIMEOUT", "CONNECTION_DESTROYED"].includes(code);
}

function isReadQuery(query: string) { return /^\s*(SELECT|WITH)\b/i.test(query); }

const READ_RETRY_DELAYS_MS = [150, 500, 1_000];

function postgresQuery(query: string) {
  let converted = query.replace(/`([^`]+)`/g, '"$1"').replace(/\?(\d+)/g, (_match, index) => `$${index}`);
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(converted)) {
    converted = converted.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i, "INSERT INTO");
    converted = `${converted.replace(/;\s*$/, "")} ON CONFLICT DO NOTHING`;
  }
  return converted;
}

class PostgresStatement implements PreparedStatement {
  values: unknown[] = [];

  constructor(private readonly connectionString: string, readonly query: string) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async execute<T>(transaction?: Sql): Promise<DatabaseResult<T>> {
    const run = async (client: Sql) => {
      const rows = await client.unsafe(postgresQuery(this.query), this.values as never[]) as unknown as T[] & { count?: number };
      return { results: Array.from(rows), success: true, meta: { changes: Number(rows.count ?? 0) } };
    };
    if (transaction) return run(transaction);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await run(clientFor(this.connectionString));
      } catch (error) {
        // Retrying a read cannot duplicate an inventory or order update. DNS
        // for a transaction pooler can briefly fail even when the database is
        // healthy, so make a few short, fresh-connection attempts before the
        // workspace gives up.
        if (!isTransientConnectionError(error)) throw error;
        discardClient(this.connectionString);
        if (!isReadQuery(this.query) || attempt >= READ_RETRY_DELAYS_MS.length) throw error;
        await new Promise((resolve) => setTimeout(resolve, READ_RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  async first<T = Record<string, unknown>>(column?: string) {
    const row = (await this.execute<T>()).results[0] ?? null;
    if (!row || !column) return row;
    return ((row as Record<string, unknown>)[column] as T | undefined) ?? null;
  }

  all<T = Record<string, unknown>>() { return this.execute<T>(); }
  run<T = Record<string, unknown>>() { return this.execute<T>(); }
}

class PostgresDatabase implements AppDatabase {
  constructor(private readonly connectionString: string) {}
  prepare(query: string) { return new PostgresStatement(this.connectionString, query); }

  batch<T = Record<string, unknown>>(statements: PreparedStatement[]) {
    return clientFor(this.connectionString).begin(async (transaction) => {
      const results: Array<DatabaseResult<T>> = [];
      for (const statement of statements) {
        if (!(statement instanceof PostgresStatement)) throw new Error("Batch contains a statement from another database adapter");
        results.push(await statement.execute<T>(transaction as unknown as Sql));
      }
      return results;
    });
  }
}

let database: AppDatabase | null = null;
let configuredUrl = "";

export function getPostgresDatabase(connectionString: string) {
  if (!connectionString) throw new Error("SUPABASE_DATABASE_URL is required. Local database fallback is disabled.");
  if (!database || configuredUrl !== connectionString) {
    configuredUrl = connectionString;
    database = new PostgresDatabase(connectionString);
  }
  return database;
}

export const sqlForPostgres = postgresQuery;
