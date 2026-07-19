import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeCursor,
  encodeCursor,
  extractBearerToken,
  paginate,
  parsePageSize,
  PublicApiError,
} from "../lib/public-api.ts";

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
  it("round-trips offsets opaquely and rejects tampered cursors as a typed 400", () => {
    const cursor = encodeCursor(150);
    assert.equal(decodeCursor(cursor), 150);
    assert.equal(decodeCursor(null), 0);
    assert.equal(decodeCursor(""), 0);
    assert.throws(() => decodeCursor("not-base64!"), (error: unknown) =>
      error instanceof PublicApiError && error.status === 400 && error.code === "INVALID_CURSOR");
    assert.throws(() => decodeCursor(encodeCursor(-0.5 as number)), PublicApiError);
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
  it("slices deterministically and only offers a next cursor when more exists", () => {
    const items = Array.from({ length: 7 }, (_, index) => index);
    const first = paginate(items, 0, 3);
    assert.deepEqual(first.page, [0, 1, 2]);
    assert.notEqual(first.nextCursor, null);
    const second = paginate(items, decodeCursor(first.nextCursor), 3);
    assert.deepEqual(second.page, [3, 4, 5]);
    const last = paginate(items, decodeCursor(second.nextCursor), 3);
    assert.deepEqual(last.page, [6]);
    assert.equal(last.nextCursor, null);
  });
});
