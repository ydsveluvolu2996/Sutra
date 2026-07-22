import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";

import { postInternalJobRun } from "../scripts/internal-job-request.mjs";

async function listen(server) {
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

test("job runner connects to loopback while preserving the canonical public Host and scheme", async (context) => {
  let requestDetails;
  const server = createServer((request, response) => {
    requestDetails = {
      method: request.method,
      path: request.url,
      host: request.headers.host,
      forwardedProto: request.headers["x-forwarded-proto"],
      token: request.headers["x-sutra-job-token"],
      peer: request.socket.remoteAddress,
    };
    response.writeHead(204).end();
  });
  context.after(() => server.close());
  const port = await listen(server);

  const outcome = await postInternalJobRun({
    port,
    token: "runner-test-token",
    publicOrigin: "https://www.sutracmdb.com",
  });

  assert.deepEqual(outcome, { status: 204, ok: true });
  assert.deepEqual(requestDetails, {
    method: "POST",
    path: "/api/internal/jobs/run",
    host: "www.sutracmdb.com",
    forwardedProto: "https",
    token: "runner-test-token",
    peer: "127.0.0.1",
  });
});

test("pilot uses the node:http runner and reads its configuration from the merged environment", async () => {
  const source = await readFile(new URL("../scripts/start-pilot.mjs", import.meta.url), "utf8");
  assert.match(source, /postInternalJobRun\(\{/u);
  assert.match(source, /const jobRunnerToken = environment\.SUTRA_JOB_RUNNER_TOKEN/u);
  assert.match(source, /environment\.SUTRA_JOB_RUNNER_INTERVAL_MS/u);
  assert.doesNotMatch(source, /fetch\(runUrl/u);
});
