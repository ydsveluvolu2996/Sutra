import { resolve } from "node:path";
import { resetLocalState } from "./local-data-utils.mjs";

const root = resolve(import.meta.dirname, "..");

// This command intentionally keeps `.dev.vars` so signing and encryption keys
// remain stable. Stop `pnpm dev:pilot` before running it.
await resetLocalState({ root });

process.stdout.write(
  "Reset local connections, schedules, jobs, CMDB, findings, and sync history. Local keys were preserved.\n",
);
