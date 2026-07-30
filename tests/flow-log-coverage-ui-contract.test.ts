import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { connectionIdFromPilotStateResponse } from "../lib/pilot-state-response.ts";

const CONNECTION_ID = `conn_${"a".repeat(32)}`;
const PANEL_PATH = path.resolve(import.meta.dirname, "../app/flow-log-coverage/flow-log-coverage-panel.tsx");

test("flow-log coverage reads the current pilot-state response envelope", () => {
  assert.equal(
    connectionIdFromPilotStateResponse({
      state: {
        connection: {
          id: CONNECTION_ID,
        },
      },
    }),
    CONNECTION_ID,
  );
  assert.equal(connectionIdFromPilotStateResponse({ state: { connection: null } }), null);
});

test("flow-log coverage rejects stale or malformed connection identifiers", () => {
  for (const value of [
    { connectionId: CONNECTION_ID },
    { state: { connectionId: CONNECTION_ID } },
    { state: { connection: { id: "undefined" } } },
    { state: {} },
    null,
  ]) {
    assert.throws(
      () => connectionIdFromPilotStateResponse(value),
      /Could not load the workspace state/u,
    );
  }
});

test("flow-log coverage preserves a validated customer selection", async () => {
  const source = await readFile(PANEL_PATH, "utf8");
  assert.match(source, /statePath = requestedConnectionId/u);
  assert.match(source, /api\/pilot\/state\?connectionId=/u);
});
