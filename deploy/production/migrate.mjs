import pg from "pg";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value || /[\r\n]/u.test(value)) throw new Error(`${name} is required and must be one line`);
  return value;
}

function databaseUrl({ user, password }) {
  const url = new URL("postgresql://placeholder/");
  url.username = user;
  url.password = password;
  url.hostname = required("SUTRA_DB_HOST");
  url.port = required("SUTRA_DB_PORT");
  url.pathname = `/${required("SUTRA_DB_NAME")}`;
  url.searchParams.set("sslmode", "require");
  return url.toString();
}

const runtimeRole = "sutra_app";
const runtimePassword = required("SUTRA_DB_APP_PASSWORD");
const administratorUrl = databaseUrl({
  user: required("SUTRA_DB_ADMIN_USER"),
  password: required("SUTRA_DB_ADMIN_PASSWORD"),
});

const client = new pg.Client({
  connectionString: administratorUrl,
  application_name: "sutra-production-role-provisioner",
  connectionTimeoutMillis: 10_000,
});
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('sutra:postgres:runtime-role'))");
  const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [runtimeRole]);
  if (role.rowCount === 0) {
    await client.query(`CREATE ROLE ${runtimeRole} LOGIN NOINHERIT`);
  }
  // quote_literal is evaluated by PostgreSQL itself; the password never becomes
  // an identifier or unescaped SQL fragment.
  const quoted = await client.query("SELECT quote_literal($1) AS value", [runtimePassword]);
  await client.query(`ALTER ROLE ${runtimeRole} PASSWORD ${quoted.rows[0].value}`);
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}

process.env.SUTRA_MIGRATOR_DATABASE_URL = administratorUrl;
process.env.SUTRA_POSTGRES_RUNTIME_ROLE = runtimeRole;
await import("../../scripts/postgres-migrate.mjs");

// A managed-production cutover must not carry legacy local connector plaintext
// into the hosted database. Disable those connectors and erase the old value;
// an administrator re-enters each credential through Settings, which writes a
// tenant-bound AWS Secrets Manager version and restores the enabled state.
const scrubClient = new pg.Client({
  connectionString: administratorUrl,
  application_name: "sutra-production-itsm-secret-scrubber",
  connectionTimeoutMillis: 10_000,
});
await scrubClient.connect();
try {
  const fixtureRows = await scrubClient.query(
    `SELECT COUNT(*)::bigint AS count
       FROM aws_connections
      WHERE source_kind = 'simulated_fixture'`,
  );
  const fixtureCount = Number(fixtureRows.rows[0]?.count ?? Number.NaN);
  if (!Number.isSafeInteger(fixtureCount) || fixtureCount < 0) {
    throw new Error("Could not verify that the production database is free of simulated AWS fixtures");
  }
  if (fixtureCount !== 0) {
    throw new Error(
      `Production migration refused: ${fixtureCount} simulated AWS fixture connection row(s) remain`,
    );
  }
  const scrubbed = await scrubClient.query(
    `UPDATE itsm_connectors
        SET shared_secret = '', enabled = 0
      WHERE secret_storage = 'local' AND shared_secret <> ''`,
  );
  process.stdout.write(
    `Scrubbed ${scrubbed.rowCount ?? 0} legacy ITSM connector credential row(s).\n`,
  );
} finally {
  await scrubClient.end();
}
