import { publicPageMetadata } from "../lib/site-seo";
import LandingZone from "./components/landing-zone";
import PublicStructuredData from "./components/public-structured-data";

export const metadata = publicPageMetadata({
  path: "/",
  title: "Sutra — AWS CMDB & Kubernetes Security for MSPs",
  description: "Unify AWS CMDB, evidence-backed cloud and Kubernetes security, compliance readiness and FinOps operations across your MSP customer portfolio.",
  home: true,
});

export default function LandingPage() {
  return (
    <>
      <PublicStructuredData />
      <LandingZone />
    </>
  );
}
