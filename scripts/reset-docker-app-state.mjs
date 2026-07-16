import { readdir, rm } from "node:fs/promises";

const stateRoot = "/app/.sutra";
for (const entry of await readdir(stateRoot)) {
  await rm(`${stateRoot}/${entry}`, { recursive: true, force: true });
}
