import pg, { type Client, type QueryResult } from "pg";

const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

interface ExecutableStatement {
  readonly query: string;
  readonly values: readonly unknown[];
}

function normalizedDatabaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL");
  }
  if (!POSTGRES_PROTOCOLS.has(parsed.protocol) || parsed.hostname.length === 0 || parsed.pathname.length < 2) {
    throw new Error("DATABASE_URL must use postgres:// or postgresql:// and name a database");
  }
  if (parsed.hash.length > 0) throw new Error("DATABASE_URL must not contain a URL fragment");
  return parsed.toString();
}

/** Convert the positional placeholder form used by D1 into node-postgres placeholders. */
export function postgresSqlFromD1(sql: string): string {
  let output = "";
  let placeholder = 0;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote !== null) {
      output += character;
      if (character !== quote) continue;
      if (sql[index + 1] === quote) {
        output += sql[index + 1];
        index += 1;
      } else {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      output += character;
      continue;
    }
    if (character === "?") {
      placeholder += 1;
      output += `$${placeholder}`;
    } else {
      output += character;
    }
  }

  output = output.replace(
    /COALESCE\(MAX\(mutation_sequence\),\s*0\)\s*\+\s*1/giu,
    "nextval('local_schedule_mutation_sequence') + (COALESCE(MAX(mutation_sequence), 0) * 0)",
  );

  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\s/iu.test(output)) {
    const withoutIgnore = output.replace(/^(\s*)INSERT\s+OR\s+IGNORE\s+INTO\s/iu, "$1INSERT INTO ");
    const trimmed = withoutIgnore.trimEnd();
    const hasSemicolon = trimmed.endsWith(";");
    const body = hasSemicolon ? trimmed.slice(0, -1).trimEnd() : trimmed;
    return `${body} ON CONFLICT DO NOTHING${hasSemicolon ? ";" : ""}`;
  }
  return output;
}

function resultFrom<T>(result: QueryResult): D1Result<T> {
  return {
    results: result.rows as T[],
    success: true,
    meta: { changes: result.rowCount ?? 0 },
  };
}

class PostgresPreparedStatement implements D1PreparedStatement, ExecutableStatement {
  public readonly query: string;
  public readonly values: readonly unknown[];

  public constructor(query: string, values: readonly unknown[] = []) {
    this.query = postgresSqlFromD1(query);
    this.values = values;
  }

  public bind(...values: unknown[]): D1PreparedStatement {
    return new PostgresPreparedStatement(this.query, values.map((value) => value ?? null));
  }

  public async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return withPostgresClient(async (client) => resultFrom<T>(await client.query(this.query, [...this.values])));
  }

  public async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return withPostgresClient(async (client) => resultFrom<T>(await client.query(this.query, [...this.values])));
  }

  public async first<T = Record<string, unknown>>(): Promise<T | null> {
    return withPostgresClient(async (client) => {
      const result = await client.query(this.query, [...this.values]);
      return (result.rows[0] as T | undefined) ?? null;
    });
  }
}

class PostgresDatabase implements D1Database {
  public readonly sutraDialect = "postgres" as const;

  public prepare(query: string): D1PreparedStatement {
    if (query.trim().length === 0) throw new Error("PostgreSQL queries must not be empty");
    return new PostgresPreparedStatement(query);
  }

  public async batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const client = await connectedPostgresClient();
    try {
      await client.query("BEGIN");
      const results: D1Result<T>[] = [];
      for (const candidate of statements) {
        const statement = candidate as Partial<ExecutableStatement>;
        if (typeof statement.query !== "string" || !Array.isArray(statement.values)) {
          throw new Error("PostgreSQL batches only accept statements prepared by the Sutra database adapter");
        }
        results.push(resultFrom<T>(await client.query(statement.query, [...statement.values])));
      }
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      await client.end();
    }
  }
}

let configuredUrl: string | undefined;
let database: PostgresDatabase | undefined;

async function connectedPostgresClient(): Promise<Client> {
  if (configuredUrl === undefined) throw new Error("The PostgreSQL adapter has not been configured");
  const client = new pg.Client({
    connectionString: configuredUrl,
    application_name: "sutra-local-control-plane",
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
  });
  await client.connect();
  return client;
}

async function withPostgresClient<T>(operation: (client: Client) => Promise<T>): Promise<T> {
  const client = await connectedPostgresClient();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function rollbackQuietly(client: Client): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original operation error; a failed connection may also reject rollback.
  }
}

export function postgresDatabase(databaseUrl: string): D1Database {
  const normalized = normalizedDatabaseUrl(databaseUrl);
  if (configuredUrl !== undefined && configuredUrl !== normalized) {
    throw new Error("DATABASE_URL cannot change while the Sutra process is running");
  }
  if (database === undefined) {
    configuredUrl = normalized;
    pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));
    database = new PostgresDatabase();
  }
  return database;
}

export function isPostgresDatabase(candidate: D1Database): boolean {
  return candidate.sutraDialect === "postgres";
}

/** Test/process teardown only. Normal application shutdown lets the pool drain. */
export async function closePostgresDatabase(): Promise<void> {
  configuredUrl = undefined;
  database = undefined;
}
