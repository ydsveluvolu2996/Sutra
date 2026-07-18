"use client";

import Link from "next/link";
import { usePortfolio } from "../../components/use-portfolio";
import { useSession } from "../../components/use-session";

interface GuideStep {
  readonly index: number;
  readonly title: string;
  readonly body: string;
  readonly href: string;
  readonly cta: string;
  readonly done: boolean;
  readonly detail: string;
}

export function ClientOnboardingGuide() {
  const { portfolio, loading, error, refresh } = usePortfolio();
  const { session } = useSession();
  const capabilities = new Set(session?.capabilities ?? []);
  const canOnboard = capabilities.has("customer:create") && capabilities.has("connection:manage");
  const canInvite = capabilities.has("membership:manage");

  const customers = portfolio?.customers ?? [];
  const connectedCustomers = customers.filter((customer) => customer.connections.length > 0);

  const steps: readonly GuideStep[] = [
    {
      index: 1,
      title: "Create the client's workspace",
      body: "Each client gets its own isolated customer workspace. Every resource, finding, and report is stored and served scoped to this customer — no other client can ever see it.",
      href: "/customers",
      cta: customers.length > 0 ? "Manage customers" : "Create the first customer",
      done: customers.length > 0,
      detail: `${customers.length} customer workspace${customers.length === 1 ? "" : "s"} in your scope`,
    },
    {
      index: 2,
      title: "Connect their AWS account",
      body: "Deploy a read-only, customer-owned role with a one-click CloudFormation Quick-Create link and a unique ExternalId. No access keys are ever entered or stored; Sutra assumes the role with short-lived credentials.",
      href: "/onboard",
      cta: connectedCustomers.length > 0 ? "Add another account" : "Connect an AWS account",
      done: connectedCustomers.length > 0,
      detail: `${connectedCustomers.length} customer${connectedCustomers.length === 1 ? "" : "s"} with a connected account`,
    },
    {
      index: 3,
      title: "Invite the client — scoped to their workspace only",
      body: "Send the client user an invitation and set their scope to assigned customers, granting only this customer with a viewer or admin role. When they sign in they see only their own dashboard, findings, and reports.",
      href: "/access",
      cta: "Invite & assign a client user",
      done: false,
      detail: "Scope = assigned customers · grant only this customer",
    },
  ];

  const completed = steps.filter((step) => step.done).length;

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Guided onboarding</p>
          <h1>Onboard a client</h1>
          <p className="page-subtitle">Three steps to bring a client onto Sutra with their own isolated workspace. Each client sees only their own resources and reports — enforced in every query, not just the UI.</p>
        </div>
        <div className="heading-actions">
          <Link className="button button-secondary" href="/controls#architecture">Isolation model</Link>
          {canOnboard ? <Link className="button button-primary" href="/onboard">Connect an account</Link> : null}
        </div>
      </section>

      <div className="trust-strip" role="note"><span className="trust-icon">✓</span><span><strong>Server-enforced tenant isolation.</strong> A client user is granted only their own customer; the organization role and the customer grant must both allow every read, and portfolio/CMDB queries are filtered by the persisted grant in SQL. Names and totals belonging to any other client are never returned to the browser.</span></div>

      {error ? <div className="page-alert page-alert-error" role="alert"><strong>Onboarding status unavailable</strong><span>{error}</span><button type="button" onClick={() => void refresh()}>Retry</button></div> : null}
      {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading onboarding progress…</div> : null}

      {!canOnboard ? <section className="panel empty-workspace compact-empty"><span className="empty-workspace-icon">MSP</span><h2>Ask an organization owner to onboard clients</h2><p>Onboarding a client account requires the customer-create and connection-manage capabilities. Your membership can view the workspaces assigned to it.</p></section> : (
        <>
          <section className="summary-band">
            <div><small>Onboarding progress</small><strong>{completed}/3</strong><span>steps with evidence so far</span></div>
            <div><small>Client workspaces</small><strong>{customers.length}</strong><span>isolated customer scopes</span></div>
            <div><small>Connected accounts</small><strong>{connectedCustomers.length}</strong><span>read-only trust roles active</span></div>
            <div><small>Access model</small><strong>Scoped</strong><span>invited clients see only their own</span></div>
          </section>

          <section className="panel">
            <div className="panel-heading"><div><p className="eyebrow">Do these in order</p><h2>Client onboarding steps</h2></div><span className="status-pill status-positive">{completed}/3 done</span></div>
            <div className="check-list-steps">
              {steps.map((step) => (
                <article className="onboard-step" key={step.index} data-done={step.done ? "true" : "false"}>
                  <span className="onboard-step-index" aria-hidden="true">{step.done ? "✓" : step.index}</span>
                  <div className="onboard-step-body">
                    <strong>{step.title}</strong>
                    <p>{step.body}</p>
                    <small className="onboard-step-detail">{step.detail}</small>
                  </div>
                  {step.index === 3 && !canInvite
                    ? <span className="status-pill">Owner invites clients</span>
                    : <Link className="button button-secondary button-small" href={step.href}>{step.cta}</Link>}
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </>
  );
}
