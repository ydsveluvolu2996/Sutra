import assert from "node:assert/strict";
import test from "node:test";

import { productionOutboundFetch } from "../lib/managed-outbound-fetch.ts";

test("managed outbound selection preserves injection and rejects partial configuration", () => {
  const injected = (async () => new Response("injected")) as typeof fetch;
  assert.throws(
    () =>
      productionOutboundFetch(
        { SUTRA_MANAGED_OUTBOUND_URL: "https://outbound.sutracmdb.com" },
        injected,
      ),
    /configuration is invalid/u,
  );
  assert.throws(
    () =>
      productionOutboundFetch({
        SUTRA_MANAGED_OUTBOUND_URL: "https://outbound.sutracmdb.com",
      }),
    /configuration is invalid/u,
  );
  assert.equal(productionOutboundFetch({}, injected), injected);
  assert.equal(productionOutboundFetch({}), fetch);
});

test("complete managed configuration signs a fixed-destination envelope", async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const privateBytes = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const encodedPrivateKey = Buffer.from(privateBytes).toString("base64url");
  const calls: Request[] = [];
  const outbound = productionOutboundFetch(
    {
      SUTRA_MANAGED_OUTBOUND_URL: "https://outbound.sutracmdb.com",
      SUTRA_MANAGED_OUTBOUND_KEY_ID: "production-app",
      SUTRA_MANAGED_OUTBOUND_PRIVATE_KEY: encodedPrivateKey,
    },
    undefined,
    {
      now: () => 1_785_369_600_000,
      randomUUID: () => "01234567-89ab-4def-8123-456789abcdef",
      fetch: async (input, init) => {
        calls.push(new Request(input, init));
        return new Response("{}", {
          headers: { "content-type": "application/json" },
        });
      },
    },
  );

  await outbound(
    "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
    { headers: { accept: "application/json" } },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://outbound.sutracmdb.com/v1/fetch");
  assert.equal(calls[0]?.headers.get("x-sutra-key-id"), "production-app");
  assert.match(calls[0]?.headers.get("x-sutra-signature") ?? "", /^[A-Za-z0-9_-]{86}$/u);
  const envelope = await calls[0]?.json() as { readonly target?: string };
  assert.equal(envelope.target, "cisa-kev");
});
