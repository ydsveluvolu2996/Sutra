/**
 * The guided-onboarding goal catalog and progress shape, dependency-free so
 * both the server repository and client components import it without dragging
 * runtime bindings into the browser bundle. Goals are a lens over the product,
 * never a permission.
 */
export const ONBOARDING_GOALS = Object.freeze([
  "cmdb",
  "finops",
  "vulnerabilities",
] as const);

export type OnboardingGoal = (typeof ONBOARDING_GOALS)[number];

export interface OnboardingProgress {
  readonly goals: readonly OnboardingGoal[];
  readonly steps: {
    readonly goals: boolean;
    readonly name: boolean;
    readonly connect: boolean;
  };
  /** All three steps done. Purely derived; nothing stores "complete". */
  readonly completed: boolean;
}
