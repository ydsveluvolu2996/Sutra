import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { GET as robotsResponse } from "../app/robots.txt/route.ts";
import { GET as sitemapResponse } from "../app/sitemap.xml/route.ts";
import { responseSecurityHeaders } from "../lib/deployment-security.ts";
import {
  canonicalSiteUrl,
  PUBLIC_INDEXABLE_PATHS,
  PUBLIC_SITE_STRUCTURED_DATA,
  publicPageMetadata,
  robotsText,
  SITE_ORIGIN,
  sitemapXml,
} from "../lib/site-seo.ts";

test("sitemap publishes only reviewed canonical public pages", () => {
  const xml = sitemapXml();
  assert.deepEqual([...xml.matchAll(/<loc>([^<]+)<\/loc>/gu)].map((match) => match[1]), PUBLIC_INDEXABLE_PATHS.map(canonicalSiteUrl));
  for (const forbidden of ["/login", "/dashboard", "/customers", "/access", "/api/"]) {
    assert.equal(xml.includes(forbidden), false);
  }
});

test("crawl-control routes return the expected media types", async () => {
  const robots = robotsResponse();
  const sitemap = sitemapResponse();
  assert.match(robots.headers.get("content-type") ?? "", /^text\/plain/u);
  assert.match(sitemap.headers.get("content-type") ?? "", /^application\/xml/u);
  assert.equal(await robots.text(), robotsText());
  assert.equal(await sitemap.text(), sitemapXml());
});

test("robots advertises the canonical sitemap without hiding pages from their noindex directive", () => {
  const policy = robotsText();
  assert.match(policy, new RegExp(`Sitemap: ${SITE_ORIGIN}/sitemap\\.xml`, "u"));
  assert.match(policy, /Host: www\.sutracmdb\.com/u);
  for (const path of ["/api/", "/accept-invite", "/mfa/"]) {
    assert.match(policy, new RegExp(`Disallow: ${path.replaceAll("/", "\\/")}`, "u"));
  }
  assert.doesNotMatch(policy, /Disallow: \/_next\//u, "Google must be able to render public CSS and JavaScript");
});

test("public metadata has one canonical URL and explicit index/social directives", () => {
  const metadata = publicPageMetadata({
    path: "/about",
    title: "About us",
    description: "Public description",
  });
  assert.equal(metadata.alternates?.canonical, `${SITE_ORIGIN}/about`);
  assert.deepEqual(metadata.robots, {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  });
  assert.equal(metadata.openGraph?.url, `${SITE_ORIGIN}/about`);
  assert.deepEqual(metadata.twitter, {
    card: "summary_large_image",
    title: "About us · Sutra",
    description: "Public description",
    images: [`${SITE_ORIGIN}/og.png`],
  });
});

test("only canonical reviewed pages omit the response-level noindex header", () => {
  for (const path of [...PUBLIC_INDEXABLE_PATHS, "/robots.txt", "/sitemap.xml"]) {
    assert.equal(
      responseSecurityHeaders(`${SITE_ORIGIN}${path === "/" ? "/" : path}`, "staging")["X-Robots-Tag"],
      undefined,
      `${path} should be crawlable on the canonical staging/private-beta origin`,
    );
  }

  for (const path of [
    "/login",
    "/dashboard",
    "/customers",
    "/access",
    "/docs",
    "/settings",
    "/onboard",
    "/kubernetes",
    "/api/status",
    "/accept-invite?token=secret",
  ]) {
    assert.equal(
      responseSecurityHeaders(`${SITE_ORIGIN}${path}`, "staging")["X-Robots-Tag"],
      "noindex, nofollow",
      `${path} must remain excluded`,
    );
  }

  assert.equal(
    responseSecurityHeaders("https://preview.sutracmdb.com/", "preview")["X-Robots-Tag"],
    "noindex, nofollow",
  );
  assert.equal(
    responseSecurityHeaders("https://app.sutracmdb.com/", "production")["X-Robots-Tag"],
    "noindex, nofollow",
  );
});

test("private pages inherit a fail-closed robots default and public pages opt in", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /robots:\s*\{[\s\S]*?index:\s*false,[\s\S]*?follow:\s*false/u);
  assert.doesNotMatch(layout, /x-forwarded-host/u);

  for (const page of ["page.tsx", "about/page.tsx", "contact/page.tsx", "security/page.tsx", "privacy/page.tsx", "terms/page.tsx", "status/page.tsx"]) {
    const source = await readFile(new URL(`../app/${page}`, import.meta.url), "utf8");
    assert.match(source, /publicPageMetadata\(/u, `${page} must explicitly opt into indexing`);
  }
});

test("structured data is truthful and omits unsupported commercial or trust claims", () => {
  const schema = JSON.stringify(PUBLIC_SITE_STRUCTURED_DATA);
  assert.match(schema, /"Organization"/u);
  assert.match(schema, /"SoftwareApplication"/u);
  assert.match(schema, /"WebApplication"/u);
  assert.match(schema, /"SecurityApplication"/u);
  assert.doesNotMatch(schema, /aggregateRating|review|customerCount|certification|"offers"|"price"/iu);
});
