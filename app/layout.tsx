import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { SITE_DESCRIPTION, SITE_NAME, SITE_ORIGIN } from "../lib/site-seo";
import { THEME_BOOTSTRAP } from "../lib/theme-bootstrap";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: { default: "Sutra", template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  // Private application pages inherit this fail-closed default. Each reviewed
  // public page opts in explicitly with publicPageMetadata().
  robots: {
    index: false,
    follow: false,
    googleBot: { index: false, follow: false },
  },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
  },
  twitter: { card: "summary_large_image", title: SITE_NAME, description: SITE_DESCRIPTION },
};

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
    // The two attributes React would diff on this element are both set outside
    // its control, so the mismatch is expected and must be suppressed here —
    // otherwise every route logs an unpatchable hydration error that buries the
    // real ones. `data-theme` is stamped by THEME_BOOTSTRAP below before React
    // hydrates (that is the point: it prevents a light-mode flash), and the CSP
    // `nonce` is hidden from the client by the browser's nonce-hiding rule, so
    // the client always reads a different value than the server rendered.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* suppressHydrationWarning does not inherit to child elements, so the
            nonce diff has to be suppressed on the script itself as well. */}
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
