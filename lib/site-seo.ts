import type { Metadata } from "next";

export const SITE_ORIGIN = "https://www.sutracmdb.com";
export const SITE_NAME = "Sutra";
export const SITE_DESCRIPTION =
  "Evidence-backed AWS CMDB, cloud security, Kubernetes posture and FinOps operations for managed service providers.";

export const PUBLIC_INDEXABLE_PATHS = [
  "/",
  "/about",
  "/contact",
  "/security",
  "/privacy",
  "/terms",
  "/status",
] as const;

const publicIndexablePathSet = new Set<string>(PUBLIC_INDEXABLE_PATHS);

function normalizedPathname(pathname: string): string {
  if (pathname === "/") return pathname;
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

export function isPublicIndexablePath(pathname: string): boolean {
  return publicIndexablePathSet.has(normalizedPathname(pathname));
}

export function canonicalSiteUrl(pathname: (typeof PUBLIC_INDEXABLE_PATHS)[number]): string {
  return new URL(pathname, SITE_ORIGIN).toString();
}

export function isCanonicalPublicSiteUrl(url: URL): boolean {
  return url.origin === SITE_ORIGIN;
}

export function robotsText(): string {
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /accept-invite",
    "Disallow: /mfa/",
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    `Host: ${new URL(SITE_ORIGIN).hostname}`,
    "",
  ].join("\n");
}

export function sitemapXml(): string {
  const urls = PUBLIC_INDEXABLE_PATHS.map(
    (path) => `  <url><loc>${canonicalSiteUrl(path)}</loc></url>`,
  ).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    "</urlset>",
    "",
  ].join("\n");
}

const PUBLIC_ROBOTS: NonNullable<Metadata["robots"]> = {
  index: true,
  follow: true,
  googleBot: {
    index: true,
    follow: true,
    "max-image-preview": "large",
    "max-snippet": -1,
    "max-video-preview": -1,
  },
};

export function publicPageMetadata(input: {
  readonly path: (typeof PUBLIC_INDEXABLE_PATHS)[number];
  readonly title: string;
  readonly description: string;
  readonly home?: boolean;
}): Metadata {
  const canonical = canonicalSiteUrl(input.path);
  const socialTitle = input.home ? input.title : `${input.title} · ${SITE_NAME}`;
  return {
    title: input.home ? { absolute: input.title } : input.title,
    description: input.description,
    alternates: { canonical },
    robots: PUBLIC_ROBOTS,
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      url: canonical,
      title: socialTitle,
      description: input.description,
      images: [
        {
          url: `${SITE_ORIGIN}/og.png`,
          width: 1672,
          height: 941,
          alt: "Sutra cloud operations and security platform",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: socialTitle,
      description: input.description,
      images: [`${SITE_ORIGIN}/og.png`],
    },
  };
}

/**
 * Public, claim-minimal schema for the home page. Deliberately omits prices,
 * ratings, customer counts, certifications and physical contact details that
 * Sutra has not published and cannot substantiate.
 */
export const PUBLIC_SITE_STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_ORIGIN}/#organization`,
      name: SITE_NAME,
      url: `${SITE_ORIGIN}/`,
      description: SITE_DESCRIPTION,
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_ORIGIN}/#website`,
      name: SITE_NAME,
      alternateName: "Sutra CMDB",
      url: `${SITE_ORIGIN}/`,
      publisher: { "@id": `${SITE_ORIGIN}/#organization` },
    },
    {
      "@type": ["SoftwareApplication", "WebApplication"],
      "@id": `${SITE_ORIGIN}/#software`,
      name: SITE_NAME,
      url: `${SITE_ORIGIN}/`,
      description: SITE_DESCRIPTION,
      applicationCategory: "SecurityApplication",
      operatingSystem: "Web browser",
      provider: { "@id": `${SITE_ORIGIN}/#organization` },
    },
  ],
} as const;
