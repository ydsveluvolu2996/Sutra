import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

// This command intentionally keeps `.dev.vars` so signing and encryption keys
// remain stable. Stop `pnpm dev:pilot` before running it.
await Promise.all([
  rm(resolve(root, ".sutra", "collector-registry.enc"), { force: true }),
  rm(resolve(root, ".sutra", "connections.enc.json"), { force: true }),
  rm(resolve(root, ".wrangler", "state", "v3", "d1"), { recursive: true, force: true }),
]);

process.stdout.write("Reset local connection, CMDB, findings, and sync history. Local keys were preserved.\n");
