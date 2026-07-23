import assert from "node:assert/strict";
import test from "node:test";
import {
  RELEASE_IMAGE_HEADER,
  validatedReleaseImage,
} from "../lib/release-identity.ts";

const validImage =
  "738663485493.dkr.ecr.ap-south-1.amazonaws.com/sutra/app@sha256:" + "a".repeat(64);

test("release identity accepts only an exact immutable Sutra ECR digest", () => {
  assert.equal(RELEASE_IMAGE_HEADER, "X-Sutra-Release-Image");
  assert.equal(validatedReleaseImage(validImage), validImage);
  assert.equal(validatedReleaseImage(undefined), null);
  assert.equal(validatedReleaseImage(""), null);
});

test("release identity rejects mutable, alternate and header-unsafe references", () => {
  for (const value of [
    "738663485493.dkr.ecr.ap-south-1.amazonaws.com/sutra/app:latest",
    "738663485493.dkr.ecr.ap-south-1.amazonaws.com/other/app@sha256:" + "a".repeat(64),
    "738663485493.dkr.ecr.ap-south-1.amazonaws.com/sutra/app@sha256:" + "A".repeat(64),
    "738663485493.dkr.ecr.ap-south-1.amazonaws.com/sutra/app@sha256:short",
    ` ${validImage}`,
    `${validImage}\r\nX-Forged: true`,
  ]) {
    assert.throws(() => validatedReleaseImage(value));
  }
});
