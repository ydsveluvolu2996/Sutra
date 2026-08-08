"use client";

import { useEffect, useState } from "react";
import type { OnboardingProgress } from "../../lib/onboarding-goals";

/**
 * Client view of the guided-onboarding progress.
 *
 * Fetched only when the caller says the flow applies (trial orgs); a `null`
 * progress means "unknown", never "complete", so the chrome shows nothing
 * rather than a wrongly-checked strip while the read is in flight or failed.
 * Steps re-read after any choice via the `sutra:onboarding-changed` event.
 */
export interface OnboardingView {
  readonly progress: OnboardingProgress | null;
}

async function loadProgress(): Promise<OnboardingProgress | null> {
  try {
    const response = await fetch("/api/v1/onboarding", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) return null;
    const body = await response.json() as { onboarding?: OnboardingProgress };
    return body.onboarding ?? null;
  } catch {
    return null;
  }
}

export function useOnboarding(enabled: boolean): OnboardingView {
  const [progress, setProgress] = useState<OnboardingProgress | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let current = true;
    const reload = () => {
      void loadProgress().then((loaded) => {
        // Unknown stays unknown; the chrome renders nothing for null.
        if (current && loaded !== null) setProgress(loaded);
      });
    };
    reload();
    window.addEventListener("sutra:onboarding-changed", reload);
    return () => {
      current = false;
      window.removeEventListener("sutra:onboarding-changed", reload);
    };
  }, [enabled]);

  return { progress };
}
