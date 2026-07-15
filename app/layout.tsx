import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
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
  const imageUrl = new URL("/og.png", metadataBase);
  return {
    metadataBase,
    title: { default: "Palisade Cloud", template: "%s · Palisade Cloud" },
    description,
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      type: "website",
      title: "Palisade Cloud",
      description,
      images: [{ url: imageUrl, width: 1672, height: 939, alt: "Palisade Cloud AWS CMDB and posture operations for MSPs" }],
    },
    twitter: { card: "summary_large_image", title: "Palisade Cloud", description, images: [imageUrl] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
