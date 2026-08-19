/* eslint-disable @next/next/no-img-element -- These four documentation
   screenshots are served as plain <img> deliberately, not by oversight.
   `next/image` needs the `/_next/image` optimizer route at runtime; this
   application is served by vinext, which ships no such route, and nothing else
   in this codebase imports `next/image` or configures an `images` loader.
   Swapping these for <Image> would trade a performance hint for four broken
   images in production. They are fixed-size 1600x1000 WebP assets committed to
   this repository, already compressed, and sized by `.onboard-guide-shot`, so
   the rule's bandwidth concern does not apply. Revisit if the runtime ever
   gains an image optimizer. */
import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "../../components/app-shell";

export const metadata: Metadata = { title: "AWS quick-start guide" };

/**
 * The quick-start guide, integrated into the onboarding section and structured
 * like the reference: prerequisites, account creation, goals, the two AWS
 * connection paths, validation, and what to explore next. Every claim below
 * describes what Sutra actually does -- the guide is documentation of the real
 * flow, not marketing ahead of it. The screenshots under
 * public/onboarding-guide/ are captures of the shipped pages rendered by the
 * real application, never mock-ups.
 */
export default function OnboardingGuidePage() {
  return (
    <AppShell active="onboard">
      <article className="onboard-guide">
        <section className="page-heading">
          <div>
            <p className="eyebrow">Quick start</p>
            <h1>Get started with Sutra</h1>
            <p className="page-subtitle">From sign-in to your first connected AWS account, end to end.</p>
          </div>
        </section>

        <section aria-labelledby="guide-prereqs">
          <h2 id="guide-prereqs">Before you begin</h2>
          <ul>
            <li>You can sign in with a Google account, or through your organization&apos;s configured identity provider.</li>
            <li>To connect an AWS account you need permission to create an IAM role (recommended) or an IAM user with access keys in that account.</li>
            <li>Sutra requests read-only cloud permissions and never modifies customer infrastructure.</li>
          </ul>
        </section>

        <section aria-labelledby="guide-signup">
          <h2 id="guide-signup">1. Create your workspace</h2>
          <p>Choose <strong>Continue with Google</strong> on the <Link href="/login">sign-in page</Link>. If this is your first time, Sutra creates your own trial workspace — no credit card, and nobody else can see it. If your organization invited you instead, accept the invitation and you will join its existing workspace.</p>
        </section>

        <section aria-labelledby="guide-goals">
          <h2 id="guide-goals">2. Choose your goals and name the workspace</h2>
          <p>The <Link href="/welcome">guided setup</Link> asks what you want from Sutra — cloud visibility (CMDB), cost optimization (FinOps), or vulnerability remediation — and what to call your workspace. Goals shape your home page; they never change what your workspace is allowed to do.</p>
          <figure>
            <img alt="The guided setup: choose your goals, share the workspace name, and connect your infrastructure" className="onboard-guide-shot" src="/onboarding-guide/guided-setup.webp" />
            <figcaption>The three-step guided setup at /welcome: goals, workspace name, and the provider hub.</figcaption>
          </figure>
        </section>

        <section aria-labelledby="guide-connect">
          <h2 id="guide-connect">3. Connect your AWS account</h2>
          <p>Open <Link href="/onboard">Manage AWS account</Link> and choose how to authenticate.</p>
          <figure>
            <img alt="Step 1 of the connection wizard: create the connection contract with customer workspace, AWS account ID, and partition" className="onboard-guide-shot" src="/onboarding-guide/connect-contract.webp" />
            <figcaption>The connection contract: one customer workspace, one AWS account, and the Region coverage choice.</figcaption>
          </figure>
          <figure>
            <img alt="The Authenticate using tabs: IAM Role and Access and Secret Keys" className="onboard-guide-shot" src="/onboarding-guide/authenticate-tabs.webp" />
            <figcaption>Choose the authentication path: IAM Role (recommended) or Access &amp; Secret Keys.</figcaption>
          </figure>
          <h3>IAM Role (recommended)</h3>
          <ol>
            <li>Create the connection contract: customer name, 12-digit AWS account ID, and partition. Sutra binds a unique ExternalId to this connection.</li>
            <li>Deploy the role: launch the pre-generated CloudFormation template with one click, download it to run yourself, or use your own tooling (Terraform) against the documented trust policy. The role is read-only and customer-owned; Sutra stores no long-lived secret.</li>
            <li>Paste the resulting Role ARN back into Sutra. Validation proves the trust boundary — account, partition, role path and ExternalId — before the connection activates.</li>
          </ol>
          <h3>Access &amp; Secret Keys</h3>
          <ol>
            <li>Create a dedicated read-only IAM user in the AWS account and generate an access key.</li>
            <li>Enter a dedicated IAM user&apos;s long-lived AKIA access key ID and secret. Temporary session credentials are not accepted. Sutra stages the values encrypted in AWS Secrets Manager, verifies the expected account with GetCallerIdentity, and promotes that exact secret version only after verification. GetCallerIdentity proves identity, not least privilege; the IAM policies you attach determine effective permissions.</li>
            <li>Wherever the key cannot read a source, collection reports that source as unavailable — never as healthy or zero.</li>
            <li>Disable blocks further use but retains the secret. Offboard blocks use and schedules the secret for deletion after a seven-day recovery window; you must still deactivate and delete the IAM access key in AWS.</li>
          </ol>
        </section>

        <section aria-labelledby="guide-after">
          <h2 id="guide-after">4. After connecting</h2>
          <ul>
            <li>The first collection runs read-only and publishes a complete snapshot — assets, relationships and findings appear on your <Link href="/dashboard">home dashboard</Link>.</li>
            <li><Link href="/connection-health">Connection health</Link> shows trust validation and collection outcomes per account.</li>
            <li>Your chosen goals link straight into the CMDB, FinOps and vulnerability views.</li>
          </ul>
          <figure>
            <img alt="The home dashboard with the Your goals section and the get-started checklist" className="onboard-guide-shot" src="/onboarding-guide/home-goals.webp" />
            <figcaption>Home after setup: your goals up top, the first-collection checklist below.</figcaption>
          </figure>
        </section>
      </article>
    </AppShell>
  );
}
