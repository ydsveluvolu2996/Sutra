/**
 * Public contract shared by the browser widget and the server verifier.
 *
 * Actions are deliberately fixed rather than supplied by request data. The
 * Siteverify response must echo the exact action for the route being protected,
 * which prevents a token minted for the low-value contact form from being
 * replayed against sign-in or invitation acceptance.
 */
export const TURNSTILE_ACTIONS = {
  login: "sutra_login",
  contact: "sutra_contact",
  acceptInvitation: "sutra_accept_invite",
  passwordResetRequest: "sutra_reset_request",
  passwordResetComplete: "sutra_reset_complete",
} as const;

export type TurnstileAction =
  (typeof TURNSTILE_ACTIONS)[keyof typeof TURNSTILE_ACTIONS];

export interface TurnstileClientConfiguration {
  readonly enabled: boolean;
  readonly siteKey?: string;
}
