# Local Docker and PostgreSQL demo stack

Sutra can run as a self-contained local stack with PostgreSQL 18, the web control
plane, and the signed fixture/live collector. Cloudflare D1 remains the hosted
Sites storage path; setting `DATABASE_URL` selects the PostgreSQL compatibility
adapter for local processes.

## Start from a normal Terminal

Prerequisites are Docker Desktop with Docker Compose and an available loopback
port 3000. From the repository directory run:

```bash
pnpm docker:up
```

The command generates distinct 256-bit PostgreSQL owner/migrator and restricted
runtime passwords in ignored `.sutra/docker.env`, builds the application image,
applies the checked-in
PostgreSQL migration, serves the prebuilt Worker artifact without HMR, waits for
both services to become healthy, and returns.
Open `http://localhost:3000/login` afterward. Retrieve the one-time local owner
token without exposing the rest of the runtime configuration:

```bash
docker compose --env-file .sutra/docker.env exec app pnpm local:bootstrap-token
```

Useful lifecycle commands:

```bash
pnpm docker:logs
pnpm docker:down
pnpm docker:up
```

`docker:down` removes containers and the private network but preserves the
PostgreSQL, application-state, and runtime-secret volumes. A later `docker:up`
uses the same data. Do not add `--volumes` unless the local demo data and secrets
are intentionally being destroyed.

The application connects as `sutra_app`, which cannot create schemas or roles.
The separate `sutra_owner` credential is used only by the migration, backup,
restore, and reset commands. Applied migrations carry an immutable SHA-256
checksum; editing an already-applied migration fails closed.

Do not delete `.sutra/docker.env` while the PostgreSQL volume exists. Sutra refuses
to generate replacement passwords when it detects retained database data. Keep a
separate, access-controlled copy of that ignored file as part of laptop recovery;
never commit it to GitHub or place it in a customer-data backup.

The stack binds the web application and PostgreSQL only to loopback. Override
the non-secret host ports in a shell when necessary:

```bash
SUTRA_WEB_PORT=3010 SUTRA_POSTGRES_PORT=54330 pnpm docker:up
```

## Database verification and maintenance

Run the real PostgreSQL migration and adapter integration test against the local
container:

```bash
pnpm db:postgres:test
```

Create a coordinated PostgreSQL custom-format dump, collector/job-state archive,
and SHA-256/fingerprint manifest:

```bash
pnpm db:postgres:backup
```

The command stops the application while taking both parts and restarts it only
after health checks pass. Backups are permission-restricted under ignored
`.sutra/postgres-backups`. They
can contain customer inventory, users, audit evidence, and encrypted connection
configuration; they must not be committed, attached to issues, or copied into a
demo recording.

Restore verifies both file checksums and current encryption/database-key
fingerprints, stops the application, creates pre-restore database and state
rollback archives, restores into a clean database and application-state volume,
and restarts only after health checks pass. If both restore and automatic rollback
fail, the application remains stopped:

```bash
pnpm db:postgres:restore -- --from .sutra/postgres-backups/<backup>.dump --confirm-restore
```

To intentionally erase the PostgreSQL database while retaining the generated
Docker and application secrets, while also clearing collector/job state:

```bash
pnpm db:postgres:reset -- --confirm-reset
```

## Running the web process on the host

For development outside the application container, start only PostgreSQL,
provide its URL to the existing ignored `.dev.vars`, then use the normal pilot
process. Prefer the full `docker:up` path for demos because it generates and
wires the password automatically.

The local PostgreSQL baseline is in
`postgres/migrations/0000_sutra_baseline.sql`. Runtime queries continue using the
same prepared-statement repository contract as D1; the adapter translates D1
positional parameters and executes batches as PostgreSQL transactions. Local
Worker requests use short-lived database connections so TCP handles never cross
Cloudflare request contexts. Do not
point this local adapter at a production database. Hosted production requires
managed secrets, separate environments, monitored migrations, tested recovery,
and an approved release process.

The Docker stack intentionally starts in fixture mode and does not mount the host
AWS configuration or SSO cache. Live AWS Docker collection remains an explicit
non-container host workflow; never add static AWS access keys to Compose,
`.dev.vars`, or the repository. Follow `docs/local-live-aws.md` for the guarded
one-account disposable-sandbox runbook.
