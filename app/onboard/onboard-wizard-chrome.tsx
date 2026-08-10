"use client";

import { useCallback, useState } from "react";
import { GlyphIcon } from "../components/nav-icon";

/**
 * Presentational chrome for the AWS onboarding wizard.
 *
 * These components carry layout and nothing else. Every security-bearing
 * decision -- which grant paths exist, how the ExternalId is handed off once,
 * what proves the trust boundary -- stays in `onboard-account.tsx`, which is
 * asserted line-by-line by `tests/aws-customer-role-onboarding-ui.test.mjs`.
 * Splitting the chrome out keeps that file's audited strings intact while the
 * surface around them changes shape.
 */

export interface WizardStep {
  readonly label: string;
  /** Short description rendered under the label in the rail. */
  readonly detail?: string;
}

/**
 * The vertical numbered rail.
 *
 * A step is `complete` only when the flow has genuinely moved past it, never
 * because it was rendered. An operator reading a checkmark must be able to
 * trust that the step's contract was actually satisfied.
 */
export function WizardStepRail({
  current,
  steps,
}: {
  readonly current: number;
  readonly steps: readonly WizardStep[];
}) {
  return (
    <ol className="wiz-step-rail" aria-label="Onboarding steps">
      {steps.map((step, index) => {
        const position = index + 1;
        const state = position === current ? "current" : position < current ? "complete" : "upcoming";
        return (
          <li className="wiz-step" data-state={state} key={step.label}>
            <span className="wiz-step-marker" aria-hidden="true">
              {state === "complete" ? <GlyphIcon name="clipboardCheck" size={12} /> : position}
            </span>
            <span className="wiz-step-body">
              <b>{step.label}</b>
              {step.detail === undefined ? null : <small>{step.detail}</small>}
            </span>
            {state === "current" ? <span className="sr-only">(current step)</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

export interface WizardChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /**
   * Renders the option visibly present but not selectable, with the reason
   * shown. Used for capabilities the reference design offers that Sutra does
   * not implement yet: hiding them would misrepresent the roadmap, and
   * enabling them would misrepresent the product.
   */
  readonly unavailable?: string;
  readonly recommended?: boolean;
}

/**
 * A compact radio list ("Connector Scope", "Installation Type").
 *
 * Distinct from the richer `.onboard-path` cards, which stay in
 * `onboard-account.tsx` because their exact copy is under test.
 */
export function WizardRadioGroup({
  legend,
  name,
  onChange,
  options,
  value,
}: {
  readonly legend: string;
  readonly name: string;
  readonly onChange: (id: string) => void;
  readonly options: readonly WizardChoice[];
  readonly value: string;
}) {
  return (
    <fieldset className="wiz-radio-group">
      <legend>{legend}</legend>
      {options.map((option) => {
        const blocked = option.unavailable !== undefined;
        return (
          <label
            className="wiz-radio"
            data-selected={!blocked && value === option.id ? "true" : undefined}
            data-unavailable={blocked ? "true" : undefined}
            key={option.id}
          >
            <input
              checked={!blocked && value === option.id}
              disabled={blocked}
              name={name}
              onChange={() => onChange(option.id)}
              type="radio"
              value={option.id}
            />
            <span className="wiz-radio-body">
              <b>
                {option.label}
                {option.recommended === true ? <em>Recommended</em> : null}
                {blocked ? <i>Not available</i> : null}
              </b>
              {option.description === undefined ? null : <small>{option.description}</small>}
              {blocked ? <small className="wiz-radio-blocked">{option.unavailable}</small> : null}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/**
 * One permission add-on row, stated rather than offered.
 *
 * The reference design makes these interactive checkboxes that compose an IAM
 * policy per connection. Sutra cannot honour that: onboarding deploys a single
 * pinned permission pack, packs are immutable, and successors are integrated
 * sequentially by a designated integrator. So a row here reports what the
 * deployed pack grants -- it never offers a grant the pack does not contain.
 *
 * The control is a disabled checkbox rather than a live one because "on, and
 * you cannot change it" is exactly the truth. `note` must name the pack, so a
 * reader can tell which contract produced the answer.
 */
export function WizardPermissionToggle({
  description,
  label,
  note,
  state,
}: {
  readonly description: string;
  readonly label: string;
  readonly note: string;
  readonly state: "granted" | "unavailable";
}) {
  const granted = state === "granted";
  return (
    <div className="wiz-toggle" data-state={state}>
      <input
        aria-label={`${label}: ${granted ? "granted" : "not granted"}`}
        checked={granted}
        disabled
        readOnly
        type="checkbox"
      />
      <span className="wiz-toggle-body">
        <b>{label}</b>
        <small>{description}</small>
        <small className={granted ? "wiz-toggle-granted" : "wiz-toggle-absent"}>{note}</small>
      </span>
    </div>
  );
}

/**
 * A copyable generated artifact (the Terraform module block, a role ARN).
 *
 * The clipboard write can be rejected by permission policy or an insecure
 * context, so the failure is reported instead of leaving the button showing a
 * success it did not achieve. The text stays selectable either way.
 */
export function WizardCodeBlock({
  code,
  filename,
}: {
  readonly code: string;
  readonly filename: string;
}) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");

  const copy = useCallback(() => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(code);
        setCopied("done");
      } catch {
        setCopied("failed");
      }
      window.setTimeout(() => setCopied("idle"), 2400);
    })();
  }, [code]);

  return (
    <div className="wiz-code">
      <div className="wiz-code-header">
        <span>{filename}</span>
        <button className="wiz-code-copy" onClick={copy} type="button">
          <GlyphIcon name={copied === "done" ? "clipboardCheck" : "layers"} size={12} />
          {copied === "done" ? "Copied" : copied === "failed" ? "Copy blocked" : "Copy"}
        </button>
      </div>
      <pre><code>{code}</code></pre>
      {copied === "failed"
        ? <p className="wiz-code-error" role="alert">The browser blocked clipboard access. Select the text above and copy it manually.</p>
        : null}
    </div>
  );
}
