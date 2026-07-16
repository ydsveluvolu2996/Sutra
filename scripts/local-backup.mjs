import { resolve } from "node:path";

import { backupLocalState } from "./local-data-utils.mjs";

const root = resolve(import.meta.dirname, "..");
const argumentsWithoutSeparator = process.argv.slice(2).filter((value) => value !== "--");
if (argumentsWithoutSeparator.length > 1) throw new Error("Usage: pnpm local:backup -- [target-directory]");
const target = argumentsWithoutSeparator[0] === undefined ? undefined : resolve(root, argumentsWithoutSeparator[0]);
const result = await backupLocalState({ root, target });
process.stdout.write(`Created verified local backup: ${result.backupDirectory}\n`);
