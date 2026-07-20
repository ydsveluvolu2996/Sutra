import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { THEME_BOOTSTRAP } from "../lib/theme-bootstrap";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || requestHeaders.get("host") || "localhost:3000";
  const forwardedProto = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : host.startsWith("localhost") ? "http" : "https";
  let metadataBase: URL;
  try {
    metadataBase = new URL(`${protocol}://${host}`);
  } catch {
    metadataBase = new URL("http://localhost:3000");
  }

  const description = "Multi-tenant AWS CMDB and configuration posture operations for managed service providers.";
  return {
    metadataBase,
    title: { default: "Sutra", template: "%s · Sutra" },
    description,
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      type: "website",
      title: "Sutra",
      description,
    },
    twitter: { card: "summary", title: "Sutra", description },
  };
}

/** Reads the per-request CSP nonce from the script-src directive the worker
 * pins on the request headers, so the inline theme script carries it and can
 * run under a policy with no 'unsafe-inline'. */
function scriptNonce(csp: string | null): string | undefined {
  if (csp === null) return undefined;
  const match = /'nonce-([A-Za-z0-9+/=_-]+)'/u.exec(csp);
  return match?.[1];
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const requestHeaders = await headers();
  const nonce = scriptNonce(requestHeaders.get("content-security-policy"));
  return (
    <html lang="en">
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
