import assert from "node:assert/strict";
import test from "node:test";

import { assertLiveProcessesStopped } from "../scripts/live-aws-backup.mjs";

test("live backup fails closed while host web or collector processes can mutate state", () => {
  assert.doesNotThrow(() => assertLiveProcessesStopped({ webOpen: false, collectorOpen: false }));
  assert.throws(
    () => assertLiveProcessesStopped({ webOpen: true, collectorOpen: false }),
    /Stop the live AWS launcher/u,
  );
  assert.throws(
    () => assertLiveProcessesStopped({ webOpen: false, collectorOpen: true }),
    /Stop the live AWS launcher/u,
  );
});
