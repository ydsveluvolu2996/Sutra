"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { OnboardingGoal, OnboardingProgress } from "../../lib/onboarding-goals";

/**
 * "Your goals" on Home: the goal cards the operator chose during onboarding,
 * each routing into the part of the product that serves it. Renders nothing
 * until goals exist -- an empty or failed read shows no section rather than
 * placeholder cards. Goals are a lens; the routes themselves stay
 * capability-gated server-side.
 */
const GOAL_HOME_CARDS: Record<OnboardingGoal, {
  readonly title: string;
  readonly tag: string;
  readonly description: string;
  readonly href: string;
}> = {
  cmdb: {
    title: "Gain full cloud visibility",
    tag: "CMDB",
    description: "Speed up cloud management decisions with a unified view of your IT infrastructure.",
    href: "/cmdb",
  },
  finops: {
    title: "Optimize cloud spending",
    tag: "FinOps",
    description: "Track, predict, and optimize cloud spending with real-time cost visibility.",
    href: "/costs",
  },
  vulnerabilities: {
    title: "Remediate vulnerabilities",
    tag: "Vulnerability management",
    description: "Contextualize, rank, and remediate security vulnerabilities at scale.",
    href: "/vulnerabilities",
  },
};

export function HomeGoals() {
  const [goals, setGoals] = useState<readonly OnboardingGoal[]>([]);

  useEffect(() => {
    let current = true;
    void fetch("/api/v1/onboarding", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => response.ok ? response.json() as Promise<{ onboarding?: OnboardingProgress }> : null)
      .then((body) => {
        if (current && body?.onboarding) setGoals(body.onboarding.goals);
      })
      .catch(() => undefined);
    return () => { current = false; };
  }, []);

  if (goals.length === 0) return null;
  return (
    <section aria-label="Your goals" className="home-goals">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Your goals</p>
          <h2>Open your goal to access the library of use cases</h2>
        </div>
        <Link className="home-goals-edit" href="/welcome#goals">Edit goals</Link>
      </div>
      <div className="home-goals-grid">
        {goals.map((goal) => {
          const card = GOAL_HOME_CARDS[goal];
          return (
            <Link className="home-goal-card" href={card.href} key={goal}>
              <strong>{card.title}</strong>
              <em>{card.tag}</em>
              <p>{card.description}</p>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
