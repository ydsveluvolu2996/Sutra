"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ONBOARDING_GOALS, type OnboardingGoal, type OnboardingProgress } from "../../lib/onboarding-goals";
import { useSession } from "../components/use-session";

/**
 * The guided three-step flow for a fresh trial workspace: choose your goals,
 * share the name, connect your infrastructure. Steps one and two write through
 * PATCH /api/v1/onboarding and announce `sutra:onboarding-changed` so the
 * topbar strip advances without a reload. Step three hands off to the connect
 * flow, whose completion is derived from a real connection existing -- this
 * page never marks anything done by itself.
 */
const GOAL_CARDS: readonly {
  readonly id: OnboardingGoal;
  readonly title: string;
  readonly tags: readonly string[];
  readonly description: string;
}[] = [
  {
    id: "cmdb",
    title: "Gain full cloud visibility",
    tags: ["CMDB"],
    description: "Speed up cloud management decisions with a unified view of your IT infrastructure.",
  },
  {
    id: "finops",
    title: "Optimize cloud spending",
    tags: ["FinOps"],
    description: "Track, predict, and optimize cloud spending with real-time cost visibility.",
  },
  {
    id: "vulnerabilities",
    title: "Remediate vulnerabilities",
    tags: ["Vulnerability management", "Patching"],
    description: "Contextualize, rank, and remediate security vulnerabilities at scale.",
  },
];

const ROADMAP_PROVIDERS = ["Microsoft Azure", "Google Cloud", "Oracle Cloud"] as const;

async function patchOnboarding(body: Record<string, unknown>): Promise<OnboardingProgress> {
  const response = await fetch("/api/v1/onboarding", {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as
    | { onboarding?: OnboardingProgress; error?: { message?: string } }
    | null;
  if (!response.ok || payload?.onboarding === undefined) {
    throw new Error(payload?.error?.message ?? "Sutra could not save your choice");
  }
  window.dispatchEvent(new Event("sutra:onboarding-changed"));
  return payload.onboarding;
}

export function WelcomeFlow() {
  const sessionView = useSession();
  const [progress, setProgress] = useState<OnboardingProgress | null>(null);
  const [selected, setSelected] = useState<readonly OnboardingGoal[]>([]);
  // null = untouched; the field shows the org's current name until edited, so
  // no effect is needed to seed it.
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [busy, setBusy] = useState<"goals" | "name" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void fetch("/api/v1/onboarding", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => response.ok ? response.json() as Promise<{ onboarding?: OnboardingProgress }> : null)
      .then((body) => {
        if (!current || !body?.onboarding) return;
        setProgress(body.onboarding);
        setSelected(body.onboarding.goals);
      })
      .catch(() => undefined);
    return () => { current = false; };
  }, []);

  const shownName = workspaceName ?? sessionView.session?.organization.name ?? "";

  async function saveGoals() {
    setBusy("goals");
    setError(null);
    try {
      setProgress(await patchOnboarding({ goals: selected }));
      document.getElementById("name")?.scrollIntoView({ behavior: "smooth" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not save your goals");
    } finally {
      setBusy(null);
    }
  }

  async function saveName(event: React.FormEvent) {
    event.preventDefault();
    setBusy("name");
    setError(null);
    try {
      setProgress(await patchOnboarding({ workspaceName: shownName }));
      window.dispatchEvent(new Event("sutra:session-changed"));
      document.getElementById("connect")?.scrollIntoView({ behavior: "smooth" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not save the workspace name");
    } finally {
      setBusy(null);
    }
  }

  function toggleGoal(goal: OnboardingGoal) {
    setSelected((current) => current.includes(goal)
      ? current.filter((entry) => entry !== goal)
      : ONBOARDING_GOALS.filter((entry) => current.includes(entry) || entry === goal));
  }

  return (
    <div className="welcome-flow">
      <section aria-labelledby="goals-title" className="welcome-step" id="goals">
        <p className="eyebrow">Step 1 of 3</p>
        <h2 id="goals-title">Choose your goals</h2>
        <p className="welcome-step-copy">Open your goal to access the library of use cases. Goals shape your home page; they never change what your workspace is allowed to do.</p>
        <div className="welcome-goal-grid">
          {GOAL_CARDS.map((card) => (
            <button
              aria-pressed={selected.includes(card.id)}
              className="welcome-goal-card"
              key={card.id}
              onClick={() => toggleGoal(card.id)}
              type="button"
            >
              <strong>{card.title}</strong>
              <span className="welcome-goal-tags">
                {card.tags.map((tag) => <em key={tag}>{tag}</em>)}
              </span>
              <p>{card.description}</p>
            </button>
          ))}
        </div>
        <button
          className="button button-primary"
          disabled={selected.length === 0 || busy !== null}
          onClick={() => void saveGoals()}
          type="button"
        >
          {busy === "goals" ? "Saving…" : progress?.steps.goals ? "Update goals" : "Continue"}
        </button>
      </section>

      <section aria-labelledby="name-title" className="welcome-step" id="name">
        <p className="eyebrow">Step 2 of 3</p>
        <h2 id="name-title">Share the name</h2>
        <p className="welcome-step-copy">This names your workspace across Sutra and in every report.</p>
        <form className="welcome-name-form" onSubmit={(event) => void saveName(event)}>
          <label>
            <span>Workspace name</span>
            <input
              maxLength={100}
              minLength={2}
              onChange={(event) => setWorkspaceName(event.target.value)}
              required
              value={shownName}
            />
          </label>
          <button className="button button-primary" disabled={busy !== null} type="submit">
            {busy === "name" ? "Saving…" : progress?.steps.name ? "Rename" : "Continue"}
          </button>
        </form>
      </section>

      <section aria-labelledby="connect-title" className="welcome-step" id="connect">
        <p className="eyebrow">Step 3 of 3</p>
        <h2 id="connect-title">Connect your infrastructure</h2>
        <p className="welcome-step-copy">Read-only permissions required · Automated and guided setup · No credit card needed.</p>
        {progress?.steps.connect ? (
          <p className="welcome-connect-done" role="status">Your infrastructure is connected. This step completed itself the moment a real connection existed.</p>
        ) : (
          <div className="welcome-provider-grid">
            {/* AWS is the one provider with a collector behind it. The others
                are roadmap cards, deliberately not buttons: rendering a
                Connect control for a provider Sutra cannot collect would be a
                claim, not a plan. No invented object counts either. */}
            <article className="welcome-provider-card" data-available="true">
              <strong>Amazon Web Services</strong>
              <p>Read-only IAM role or access keys, guided end to end.</p>
              <Link className="button button-primary" href="/onboard">Connect AWS</Link>
            </article>
            {ROADMAP_PROVIDERS.map((provider) => (
              <article className="welcome-provider-card" data-available="false" key={provider}>
                <strong>{provider}</strong>
                <p>On the roadmap</p>
                <span className="welcome-provider-soon">Not yet available</span>
              </article>
            ))}
          </div>
        )}
      </section>

      {error ? <p className="auth-error" role="alert">{error}</p> : null}
    </div>
  );
}
