-- Public marketing-site contact leads. Deliberately standalone: no tenant
-- column and no foreign keys into the tenant-gated customer tables, because
-- these are public submissions with no owning tenant.
CREATE TABLE IF NOT EXISTS contact_submissions (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  company text,
  message text NOT NULL,
  source_ip text NOT NULL,
  recipient text NOT NULL,
  delivered integer DEFAULT 0 NOT NULL,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_submissions_source_idx ON contact_submissions (source_ip, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_submissions_created_idx ON contact_submissions (created_at);
