"use client";

import { useCallback, useEffect, useState } from "react";
import { ONBOARDING_GOALS, type OnboardingGoal, type OnboardingProgress } from "../../lib/onboarding-goals";
import { ConnectProviderGrid } from "../onboard/connect-provider-grid";
import { useSession } from "../components/use-session";

/**
 * The guided three-step flow for a fresh trial workspace: choose your goals,
 * share the name, connect your infrastructure.
 *
 * One step is on screen at a time. The steps used to stack and scroll, which
 * showed a customer three unfinished things at once and buried the only one
 * they could act on; paging keeps the page about the current decision and lets
 * the top-bar strip carry the sense of progress.
 *
 * Steps one and two write through PATCH /api/v1/onboarding and announce
 * `sutra:onboarding-changed` so the strip advances without a reload. Step three
 * hands off to the connect flow, whose completion is derived from a real
 * connection existing -- this page never marks anything done by itself.
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

type WelcomeStep = "goals" | "name" | "connect";

const STEP_ORDER: readonly WelcomeStep[] = Object.freeze(["goals", "name", "connect"] as const);

function stepFromHash(hash: string): WelcomeStep | null {
  const candidate = hash.replace(/^#/u, "");
  return STEP_ORDER.find((step) => step === candidate) ?? null;
}

/** The first step the workspace has not finished, or the last one when done. */
function firstIncompleteStep(progress: OnboardingProgress | null): WelcomeStep {
  if (progress === null) return "goals";
  return STEP_ORDER.find((step) => !progress.steps[step]) ?? "connect";
}

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
  // null = follow progress. A step the customer navigated to explicitly wins,
  // so the strip's back-links work and saving a step does not yank them
  // forward before they have read the result.
  const [requestedStep, setRequestedStep] = useState<WelcomeStep | null>(null);

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

  // The top-bar strip navigates by hash, so the hash is what selects a step.
  useEffect(() => {
    const apply = () => setRequestedStep(stepFromHash(window.location.hash));
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  const step = requestedStep ?? firstIncompleteStep(progress);
  const shownName = workspaceName ?? sessionView.session?.organization.name ?? "";

  const goToStep = useCallback((next: WelcomeStep) => {
    setRequestedStep(next);
    window.history.replaceState(null, "", `#${next}`);
    window.scrollTo({ top: 0 });
  }, []);

  async function saveGoals() {
    setBusy("goals");
    setError(null);
    try {
      setProgress(await patchOnboarding({ goals: selected }));
      goToStep("name");
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
      goToStep("connect");
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
    <div className="welcome-flow" data-step={step}>
      {step === "goals" ? (
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
          <div className="welcome-step-actions">
            <button
              className="button button-primary"
              disabled={selected.length === 0 || busy !== null}
              onClick={() => void saveGoals()}
              type="button"
            >
              {busy === "goals" ? "Saving…" : "Continue"}
            </button>
          </div>
        </section>
      ) : null}

      {step === "name" ? (
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
            <div className="welcome-step-actions">
              <button className="button button-secondary" onClick={() => goToStep("goals")} type="button">Back</button>
              <button className="button button-primary" disabled={busy !== null} type="submit">
                {busy === "name" ? "Saving…" : "Continue"}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {step === "connect" ? (
        <section aria-labelledby="connect-providers-title" className="welcome-step" id="connect">
          <p className="eyebrow">Step 3 of 3</p>
          {progress?.steps.connect ? (
            <p className="welcome-connect-done" role="status">Your infrastructure is connected. This step completed itself the moment a real connection existed.</p>
          ) : null}
          <ConnectProviderGrid heading="Connect your infrastructure to track every asset, everywhere" />
          <div className="welcome-step-actions">
            <button className="button button-secondary" onClick={() => goToStep("name")} type="button">Back</button>
          </div>
        </section>
      ) : null}

      {error ? <p className="auth-error" role="alert">{error}</p> : null}
    </div>
  );
}
