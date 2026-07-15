"use client";

import { FormEvent, useMemo, useState } from "react";

const demoExternalId = "psd_demo_01J2F9R8KX4NQ7W3TM6C5V0HYA";

export function OnboardAccount() {
  const [accountId, setAccountId] = useState("");
  const [roleArn, setRoleArn] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const arnAccount = useMemo(() => roleArn.match(/^arn:(?:aws|aws-us-gov|aws-cn):iam::(\d{12}):role\/[A-Za-z0-9+=,.@_\/-]+$/)?.[1], [roleArn]);
  const accountValid = /^\d{12}$/.test(accountId);
  const arnValid = Boolean(arnAccount);
  const idsMatch = accountValid && arnAccount === accountId;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(idsMatch);
  }

  return (
    <>
      <section className="page-heading onboard-heading">
        <div><p className="eyebrow">Secure AWS connection</p><h1>Onboard a customer account</h1><p className="page-subtitle">Deploy one customer-owned, metadata-only IAM role. No access keys are created or stored.</p></div>
        <span className="status-pill status-positive">Read-only v1</span>
      </section>

      <div className="onboard-layout">
        <section className="panel onboard-panel">
          <div className="stepper" aria-label="Onboarding steps"><span className="active"><b>1</b>Connection</span><i /><span><b>2</b>Deploy role</span><i /><span><b>3</b>Validate trust</span></div>
          <div className="onboard-copy"><p className="eyebrow">Step 1 of 3</p><h2>Create the connection contract</h2><p>Palisade generates a unique ExternalId and binds the future role to the selected customer and AWS account.</p></div>
          <form className="onboard-form" onSubmit={submit}>
            <label><span>Customer workspace</span><select defaultValue="northstar"><option value="northstar">Northstar Retail (Demo)</option><option>Bluepeak Health (Demo)</option><option>Harbor Analytics (Demo)</option><option>Evergreen Finance (Demo)</option></select><small>Users only see accounts granted to this customer scope.</small></label>
            <div className="form-grid">
              <label><span>AWS account ID</span><input inputMode="numeric" maxLength={12} placeholder="123456789012" value={accountId} onChange={(event) => { setAccountId(event.target.value.replace(/\D/g, "")); setSubmitted(false); }} aria-invalid={accountId.length > 0 && !accountValid} /><small>Exactly 12 digits.</small></label>
              <label><span>AWS partition</span><select defaultValue="aws"><option value="aws">Commercial (aws)</option><option value="aws-us-gov">GovCloud</option><option value="aws-cn">China</option></select><small>Collector workloads are isolated by partition.</small></label>
            </div>
            <label><span>Customer role ARN</span><input placeholder="arn:aws:iam::123456789012:role/mspcmdb/MSPCMDBReadRole" value={roleArn} onChange={(event) => { setRoleArn(event.target.value.trim()); setSubmitted(false); }} aria-invalid={roleArn.length > 0 && (!arnValid || !idsMatch)} /><small>{roleArn.length === 0 ? "Paste this after the CloudFormation stack finishes." : !arnValid ? "Enter a canonical IAM role ARN; assumed-role and user ARNs are rejected." : !idsMatch ? "The role ARN account must match the account ID above." : "Role ARN syntax and account binding match."}</small></label>
            <label><span>Platform-generated ExternalId</span><div className="copy-field"><code>{demoExternalId}</code><button type="button" onClick={() => navigator.clipboard?.writeText(demoExternalId)}>Copy</button></div><small>Preview value only. Production uses a server-generated value with at least 128 bits of entropy and never accepts customer input.</small></label>
            <div className="template-actions"><a className="button button-secondary" href="/palisade-customer-role.yaml" download>Download CloudFormation</a><span>Review and deploy with <code>CAPABILITY_NAMED_IAM</code>, then return with the role ARN.</span></div>
            <button className="button button-primary onboard-submit" type="submit" disabled={!idsMatch}>Prepare validation</button>
          </form>
          {submitted ? <div className="validation-result" role="status"><span>✓</span><div><strong>Connection contract is ready.</strong><p>A live production broker must still run positive AssumeRole/GetCallerIdentity and negative missing/wrong ExternalId probes before this account becomes active.</p></div></div> : null}
        </section>

        <aside className="onboard-aside">
          <section className="panel"><p className="eyebrow">Trust checklist</p><h2>Customer stays in control</h2><ul className="check-list compact"><li><span>✓</span>Exact vendor workload-role principal</li><li><span>✓</span>Unique ExternalId condition</li><li><span>✓</span>Metadata-only permissions</li><li><span>✓</span>Maximum one-hour STS session</li><li><span>✓</span>No S3 objects, secrets, KMS decrypt, or mutations</li></ul></section>
          <section className="panel aside-warning"><p className="eyebrow">Production gate</p><h2>Validation is behavioral</h2><p>ARN syntax is not proof of safe trust. Palisade only activates a connection after the AWS broker proves the role succeeds with the right ExternalId and fails without it or with a wrong one.</p></section>
          <section className="panel data-path-card"><p className="eyebrow">Credential path</p><ol><li><b>1</b>Signed scoped job</li><li><b>2</b>AWS workload identity</li><li><b>3</b>STS AssumeRole</li><li><b>4</b>Temporary in-memory credentials</li><li><b>5</b>Normalized evidence only</li></ol></section>
        </aside>
      </div>
    </>
  );
}
