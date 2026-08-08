"use client";

import Link from "next/link";
import type { OnboardingProgress } from "../../lib/onboarding-goals";

/**
 * The three-step progress strip shown in the top bar while a trial workspace
 * is onboarding: Choose your goals — Share the name — Connect your
 * infrastructure. Done steps show a check; the first not-done step is current
 * and numbered. Every step links into the guided flow, which owns the forms.
 */
const STEPS = [
  { key: "goals", label: "Choose your goals", href: "/welcome#goals" },
  { key: "name", label: "Share the name", href: "/welcome#name" },
  { key: "connect", label: "Connect your infrastructure", href: "/welcome#connect" },
] as const;

export function OnboardingStrip({ progress }: { readonly progress: OnboardingProgress }) {
  if (progress.completed) return null;
  const currentKey = STEPS.find((step) => !progress.steps[step.key])?.key;
  return (
    <nav aria-label="Getting started" className="onboarding-strip">
      {STEPS.map((step, index) => {
        const done = progress.steps[step.key];
        const current = step.key === currentKey;
        return (
          <Link
            aria-current={current ? "step" : undefined}
            className="onboarding-strip-step"
            data-state={done ? "done" : current ? "current" : "upcoming"}
            href={step.href}
            key={step.key}
          >
            <span className="onboarding-strip-label">{step.label}</span>
            <span aria-hidden="true" className="onboarding-strip-marker">
              {done ? (
                <svg fill="none" height="12" viewBox="0 0 12 12" width="12">
                  <path d="M2.5 6.2 5 8.7l4.5-5.4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                </svg>
              ) : (
                index + 1
              )}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
