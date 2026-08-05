import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeCursor,
  encodeCursor,
  extractBearerToken,
  paginate,
  parsePageSize,
  publicCursorContext,
  PublicApiError,
} from "../lib/public-api.ts";

const tokenAlpha = {
  id: "pat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  orgId: "org_alpha",
  customerId: "cust_alpha",
  scopes: ["read:resources"] as const,
  createdBy: "usr_alpha",
};
const alphaRequest = new Request("https://api.sutra.test/api/public/v1/resources", {
  headers: { authorization: `Bearer sutra_pat_${"a".repeat(64)}` },
});
const alphaContext = publicCursorContext(alphaRequest, tokenAlpha, "resources");

describe("extractBearerToken", () => {
  it("accepts a well-formed header and rejects everything else", () => {
    assert.equal(extractBearerToken("Bearer sutra_pat_abc"), "sutra_pat_abc");
    assert.equal(extractBearerToken("  Bearer   tok  "), "tok");
    assert.equal(extractBearerToken("Basic dXNlcg=="), null);
    assert.equal(extractBearerToken("Bearer"), null);
    assert.equal(extractBearerToken(null), null);
  });
});

describe("cursor codec", () => {
  it("round-trips scoped offsets and rejects malformed cursors as a typed 400", async () => {
    const cursor = await encodeCursor(150, alphaContext);
    assert.equal(await decodeCursor(cursor, alphaContext), 150);
    assert.equal(await decodeCursor(null, alphaContext), 0);
    assert.equal(await decodeCursor("", alphaContext), 0);
    await assert.rejects(() => decodeCursor("not-base64!", alphaContext), (error: unknown) =>
      error instanceof PublicApiError && error.status === 400 && error.code === "INVALID_CURSOR");
    await assert.rejects(() => decodeCursor("a".repeat(4_097), alphaContext), (error: unknown) =>
      error instanceof PublicApiError && error.status === 400 && error.code === "INVALID_CURSOR");
    await assert.rejects(() => encodeCursor(-0.5 as number, alphaContext), PublicApiError);
  });

  it("rejects cursors swapped across customer, token, and collection scope", async () => {
    const cursor = await encodeCursor(25, alphaContext);
    const contexts = [
      { ...alphaContext, customerId: "cust_beta" },
      { ...alphaContext, orgId: "org_beta", customerId: "cust_beta" },
      { ...alphaContext, tokenId: "pat_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      { ...alphaContext, collection: "findings" },
      { ...alphaContext, signingSecret: `sutra_pat_${"b".repeat(64)}` },
    ];
    for (const context of contexts) {
      await assert.rejects(
        () => decodeCursor(cursor, context),
        (error: unknown) =>
          error instanceof PublicApiError &&
          error.status === 400 &&
          error.code === "INVALID_CURSOR",
      );
    }
  });

  it("rejects a payload or signature modified after issue", async () => {
    const cursor = await encodeCursor(25, alphaContext);
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { p: string; s: string };
    const payload = JSON.parse(Buffer.from(decoded.p, "base64url").toString("utf8")) as { o: number };
    payload.o = 0;
    const alteredPayload = Buffer.from(JSON.stringify({
      p: Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
      s: decoded.s,
    }), "utf8").toString("base64url");
    await assert.rejects(() => decodeCursor(alteredPayload, alphaContext), PublicApiError);
    const alteredSignature = Buffer.from(JSON.stringify({
      p: decoded.p,
      s: `${decoded.s.slice(0, -1)}${decoded.s.endsWith("A") ? "B" : "A"}`,
    }), "utf8").toString("base64url");
    await assert.rejects(() => decodeCursor(alteredSignature, alphaContext), PublicApiError);
  });
});

describe("parsePageSize", () => {
  it("defaults, bounds and rejects garbage", () => {
    assert.equal(parsePageSize(null), 50);
    assert.equal(parsePageSize("100"), 100);
    assert.throws(() => parsePageSize("0"), PublicApiError);
    assert.throws(() => parsePageSize("101"), PublicApiError);
    assert.throws(() => parsePageSize("ten"), PublicApiError);
  });
});

describe("paginate", () => {
  it("slices deterministically and only offers a scoped next cursor when more exists", async () => {
    const items = Array.from({ length: 7 }, (_, index) => index);
    const first = await paginate(items, 0, 3, alphaContext);
    assert.deepEqual(first.page, [0, 1, 2]);
    assert.notEqual(first.nextCursor, null);
    const second = await paginate(items, await decodeCursor(first.nextCursor, alphaContext), 3, alphaContext);
    assert.deepEqual(second.page, [3, 4, 5]);
    const last = await paginate(items, await decodeCursor(second.nextCursor, alphaContext), 3, alphaContext);
    assert.deepEqual(last.page, [6]);
    assert.equal(last.nextCursor, null);
  });
});
