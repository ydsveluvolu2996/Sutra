# Connection pooling (PgBouncer) — validation & activation

Review finding #1: the app opens a **new Postgres connection per query** because
workerd forbids reusing a socket across requests, so an in-process `pg.Pool` is
impossible. The workerd-safe fix is an **external pooler**. This is shipped as an
opt-in overlay (`compose.pgbouncer.yaml`) so it never affects a normal deploy
until you deliberately activate it.

## Why it needs one validation pass (not a blind flip)
1. **Image digest** — pin a reviewed `edoburu/pgbouncer` digest in the overlay
   (the rest of the stack pins every image by `@sha256`).
2. **Driver compatibility** — transaction pooling breaks *named/server-side*
   prepared statements. node-postgres uses **unnamed** prepares (safe), but this
   must be confirmed against the running build once, under real traffic.
3. **Pool sizing** — `DEFAULT_POOL_SIZE` × clients must stay under Postgres
   `max_connections` (default 100) with headroom for `migrate` + manual `psql`.

## Validation steps (on the EC2 box)
```bash
cd /opt/sutra
# 1. Bring up ONLY pgbouncer alongside the running stack (app still on :5432).
sudo docker compose -f deploy/ec2/compose.prod.yaml -f deploy/ec2/compose.pgbouncer.yaml \
  --env-file deploy/ec2/.env.ec2 --env-file .sutra/docker.env up -d pgbouncer
# 2. Confirm pooled auth works end-to-end.
sudo docker compose -f deploy/ec2/compose.prod.yaml -f deploy/ec2/compose.pgbouncer.yaml ps pgbouncer   # healthy?
# 3. Flip the app onto the pooler (recreates the app container).
sudo docker compose -f deploy/ec2/compose.prod.yaml -f deploy/ec2/compose.pgbouncer.yaml \
  --env-file deploy/ec2/.env.ec2 --env-file .sutra/docker.env up -d
# 4. Smoke test through the real edge.
curl -s https://www.sutracmdb.com/api/healthz          # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' https://www.sutracmdb.com/login   # 200
# ...then sign in and click through a couple of workspace pages.
# 5. Watch for pooling errors (prepared-statement or auth failures).
sudo docker logs sutra-prod-pgbouncer-1 --tail 50
sudo docker logs sutra-prod-app-1 --tail 50 | grep -iE 'prepared|pgbouncer|ECONN|password' || echo clean
```

## Rollback (instant)
Bring the stack up **without** the overlay — the app returns to `postgres:5432`:
```bash
sudo docker compose -f deploy/ec2/compose.prod.yaml \
  --env-file deploy/ec2/.env.ec2 --env-file .sutra/docker.env up -d
```

## Expected benefit
Removes the per-query TCP+TLS+auth handshake to Postgres on the hot path (many
queries per page). Latency and Postgres connection churn both drop; the app code
is unchanged.
