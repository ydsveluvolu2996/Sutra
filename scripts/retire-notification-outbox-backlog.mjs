// Measure, and only on an explicit instruction retire, the notification outbox
// backlog that would otherwise be flushed to real Slack / Teams / PagerDuty /
// webhook / SES destinations the instant the delivery worker first starts.
//
// Background: services/notification-worker/postgres-repository.ts claim()
// selects any row with status IN ('pending','retry_scheduled') whose
// next_attempt_at has passed — with no age filter — plus any 'processing' row
// whose lease has expired. Every alert Sutra has ever queued is therefore
// eligible immediately. See docs/notification-delivery-enablement.md section 6.
//
// This script is read-only by default. Retirement moves stale rows to the exact
// terminal status the worker itself assigns when it cannot deliver,
// 'not_configured' / 'DELIVERY_ADAPTER_NOT_CONFIGURED', which is outside
// claim()'s IN list, so the history stays truthful and claim() can never select
// the row again. It never marks a row 'delivered', never writes delivered_at,
// and never deletes a row.
//
//   node scripts/retire-notification-outbox-backlog.mjs
//   node scripts/retire-notification-outbox-backlog.mjs --older-than 24h
//   node scripts/retire-notification-outbox-backlog.mjs --older-than 24h --retire
//   node scripts/retire-notification-outbox-backlog.mjs --older-than 24h --retire --include-expired-leases
//
// DATABASE_URL (or SUTRA_OUTBOX_DATABASE_URL) selects the database. On the
// private-beta host that is the same PostgreSQL the app and worker share.

import pg from "pg";

// The only status and error code this script may ever write. Both are literal
// module constants, not derived from input, so no argument can turn a retired
// row into a delivered one.
const RETIRED_STATUS = "not_configured";
const RETIRED_ERROR_CODE = "DELIVERY_ADAPTER_NOT_CONFIGURED";
const CLAIMABLE_STATUSES = ["pending", "retry_scheduled"];
const MINIMUM_CUTOFF_MS = 60 * 60 * 1000;

const argv = process.argv.slice(2);
const knownFlags = new Set([
  "--retire",
  "--include-expired-leases",
  "--older-than",
  "--help",
  "-h",
]);
for (const [index, argument] of argv.entries()) {
  if (knownFlags.has(argument)) continue;
  // The only permitted bare word is the value of --older-than.
  if (argv[index - 1] === "--older-than") continue;
  throw new Error(`Unknown argument ${argument}. Run with --help.`);
}
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(
    [
      "Measure (default) or retire the Sutra notification outbox backlog.",
      "",
      "  --older-than <duration>    Cutoff, minimum 1h. Accepts 30m, 24h, 7d.",
      "  --retire                   Actually update rows. Requires --older-than.",
      "  --include-expired-leases   Also retire 'processing' rows whose lease has expired.",
      "",
      "Without --retire nothing is written. Rows are never deleted and never",
      `marked delivered; retirement sets status='${RETIRED_STATUS}' with`,
      `last_error_code='${RETIRED_ERROR_CODE}'.`,
      "",
    ].join("\n"),
  );
  process.exit(0);
}

function parseDuration(value) {
  const match = /^([0-9]{1,6})(m|h|d)$/u.exec(value ?? "");
  if (match === null) {
    throw new Error("--older-than must look like 30m, 24h or 7d");
  }
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  return Number(match[1]) * unit;
}

const olderThanIndex = argv.indexOf("--older-than");
const cutoffMs = olderThanIndex < 0 ? null : parseDuration(argv[olderThanIndex + 1]);
const retire = argv.includes("--retire");
const includeExpiredLeases = argv.includes("--include-expired-leases");

if (retire && cutoffMs === null) {
  throw new Error(
    "--retire requires an explicit --older-than cutoff. Measure first, choose the cutoff deliberately, then re-run.",
  );
}
if (cutoffMs !== null && cutoffMs < MINIMUM_CUTOFF_MS) {
  throw new Error("--older-than must be at least 1h so genuinely current alerts are never retired");
}

const databaseUrl = (process.env.SUTRA_OUTBOX_DATABASE_URL ?? process.env.DATABASE_URL)?.trim();
if (!databaseUrl) {
  throw new Error("DATABASE_URL (or SUTRA_OUTBOX_DATABASE_URL) is required");
}
const parsed = new URL(databaseUrl);
if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
  throw new Error("DATABASE_URL must be a PostgreSQL URL");
}

function formatEpochMs(value) {
  if (value === null || value === undefined) return "-";
  return new Date(Number(value)).toISOString();
}

function writeTable(rows, columns) {
  if (rows.length === 0) {
    process.stdout.write("  (none)\n");
    return;
  }
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => String(row[column] ?? "").length)),
  );
  const line = (cells) =>
    `  ${cells.map((cell, index) => String(cell).padEnd(widths[index])).join("  ")}\n`;
  process.stdout.write(line(columns));
  process.stdout.write(`  ${widths.map((width) => "-".repeat(width)).join("  ")}\n`);
  for (const row of rows) {
    process.stdout.write(line(columns.map((column) => row[column] ?? "")));
  }
}

// Every statement below is built by concatenation of literal fragments, so
// assert before execution that its placeholders and its bound values agree.
// A mismatch here would otherwise surface as a runtime bind error mid-run.
function checkedQuery(client, sql, values = []) {
  const referenced = new Set([...sql.matchAll(/\$([0-9]+)/gu)].map((match) => Number(match[1])));
  const expected = new Set(values.map((_, index) => index + 1));
  if (referenced.size !== expected.size || [...expected].some((index) => !referenced.has(index))) {
    throw new Error(
      `Statement binds ${values.length} values but references placeholders ${[...referenced].sort((a, b) => a - b).join(",") || "none"}`,
    );
  }
  return client.query(sql, values);
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  application_name: "sutra-outbox-backlog",
  max: 1,
  connectionTimeoutMillis: 10_000,
});
const client = await pool.connect();
const now = Date.now();

try {
  const tableExists = await checkedQuery(
    client,
    "SELECT to_regclass('public.security_notification_outbox') IS NOT NULL AS present",
  );
  if (tableExists.rows[0]?.present !== true) {
    throw new Error("security_notification_outbox does not exist in this database");
  }

  process.stdout.write(`Sutra notification outbox, measured at ${new Date(now).toISOString()}\n\n`);
  process.stdout.write("Rows by status\n");
  const byStatus = await checkedQuery(
    client,
    `SELECT status, count(*)::int AS rows,
            min(created_at)::bigint AS oldest, max(created_at)::bigint AS newest
       FROM security_notification_outbox
      GROUP BY status ORDER BY status`,
  );
  writeTable(
    byStatus.rows.map((row) => ({
      status: row.status,
      rows: row.rows,
      oldest: formatEpochMs(row.oldest),
      newest: formatEpochMs(row.newest),
    })),
    ["status", "rows", "oldest", "newest"],
  );

  process.stdout.write("\nClaimable right now, by destination channel (enabled destinations only)\n");
  const byChannel = await checkedQuery(
    client,
    `SELECT d.channel, count(*)::int AS rows, min(o.created_at)::bigint AS oldest
       FROM security_notification_outbox o
       JOIN security_notification_destinations d ON d.id = o.destination_id
      WHERE d.enabled = 1
        AND ((o.status = ANY($1::text[]) AND o.next_attempt_at <= $2)
          OR (o.status = 'processing' AND o.lease_expires_at < $2))
      GROUP BY d.channel ORDER BY 2 DESC, 1`,
    [CLAIMABLE_STATUSES, now],
  );
  writeTable(
    byChannel.rows.map((row) => ({
      channel: row.channel,
      rows: row.rows,
      oldest: formatEpochMs(row.oldest),
    })),
    ["channel", "rows", "oldest"],
  );

  if (cutoffMs === null) {
    process.stdout.write(
      "\nRead-only measurement complete; nothing was written."
        + "\nChoose a cutoff and re-run with --older-than <duration> to see what it would retire.\n",
    );
  } else {
    const cutoffAt = now - cutoffMs;
    // One predicate, reused verbatim by the count and by the UPDATE, so the
    // preview and the mutation can never disagree.
    const selectionValues = includeExpiredLeases
      ? [CLAIMABLE_STATUSES, cutoffAt, now]
      : [CLAIMABLE_STATUSES, cutoffAt];
    const selectionSql = includeExpiredLeases
      ? `((status = ANY($1::text[]))
          OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at < $3))
         AND created_at < $2`
      : "status = ANY($1::text[]) AND created_at < $2";
    // Retirement constants are bound after the selection values, so their
    // placeholder numbers follow the selection's.
    const statusPlaceholder = `$${selectionValues.length + 1}`;
    const errorCodePlaceholder = `$${selectionValues.length + 2}`;

    const candidates = await checkedQuery(
      client,
      `SELECT count(*)::int AS rows, min(created_at)::bigint AS oldest, max(created_at)::bigint AS newest
         FROM security_notification_outbox WHERE ${selectionSql}`,
      selectionValues,
    );
    const summary = candidates.rows[0];
    process.stdout.write(
      `\nRows created before ${new Date(cutoffAt).toISOString()} that would be retired: ${summary.rows}`
        + `${includeExpiredLeases ? " (including expired leases)" : ""}\n`,
    );
    if (summary.rows > 0) {
      process.stdout.write(
        `  oldest ${formatEpochMs(summary.oldest)}, newest ${formatEpochMs(summary.newest)}\n`,
      );
    }

    if (!retire) {
      process.stdout.write(
        "\nRead-only preview; nothing was written."
          + "\nAdd --retire to apply exactly this selection. Take a backup first:"
          + " deploy/ec2/backup-prod.sh.\n",
      );
    } else if (summary.rows === 0) {
      process.stdout.write("\nNothing to retire at this cutoff; no statement was executed.\n");
    } else {
      await client.query("BEGIN");
      let updated;
      try {
        // UPDATE only. There is no DELETE anywhere in this file, delivered_at is
        // forced to NULL rather than being given a value, and the status and
        // error code are the module constants above, so a retired row can never
        // be mistaken for a delivered one.
        const result = await checkedQuery(
          client,
          `UPDATE security_notification_outbox
              SET status = ${statusPlaceholder},
                  last_error_code = ${errorCodePlaceholder},
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  delivered_at = NULL,
                  updated_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
            WHERE ${selectionSql}`,
          [...selectionValues, RETIRED_STATUS, RETIRED_ERROR_CODE],
        );
        updated = result.rowCount;
        if (updated > summary.rows) {
          throw new Error(
            `Refusing to commit: the update matched ${updated} rows but the measurement showed ${summary.rows}`,
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original failure.
        }
        throw error;
      }
      process.stdout.write(
        `\nRetired ${updated} row${updated === 1 ? "" : "s"} to status='${RETIRED_STATUS}'`
          + ` with last_error_code='${RETIRED_ERROR_CODE}'.`
          + "\nNo row was deleted and no delivered_at was written.\n",
      );
    }
  }
} finally {
  client.release();
  await pool.end();
}
