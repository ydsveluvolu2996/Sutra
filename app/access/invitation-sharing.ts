export interface InvitationShareDetails {
  readonly activationUrl: string;
  readonly email: string;
  readonly expiresAt: string;
}

export type ShareResult = "shared" | "cancelled" | "unsupported";

interface ClipboardLike {
  readonly writeText?: (value: string) => Promise<void>;
}

interface ClipboardNavigatorLike {
  readonly clipboard?: ClipboardLike;
}

interface ShareNavigatorLike {
  readonly share?: (data: { readonly title: string; readonly text: string; readonly url: string }) => Promise<void>;
}

interface CopyDocumentLike {
  readonly body: {
    appendChild(node: HTMLTextAreaElement): void;
  };
  createElement(tagName: "textarea"): HTMLTextAreaElement;
  execCommand(command: "copy"): boolean;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

export function invitationEmailHref(details: InvitationShareDetails): string {
  const expiry = new Date(details.expiresAt);
  const expiryLabel = Number.isNaN(expiry.valueOf()) ? details.expiresAt : expiry.toLocaleString();
  const subject = "Your secure Sutra invitation";
  const body = [
    "You have been invited to Sutra.",
    "",
    `Activate your access before ${expiryLabel}:`,
    details.activationUrl,
    "",
    "This link is single-use. If you were not expecting it, do not open it and contact the sender.",
  ].join("\n");
  return `mailto:${encodeURIComponent(details.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * Copy a one-time activation URL from a direct user action. The temporary DOM
 * fallback supports local HTTP demos where the async Clipboard API is often
 * unavailable, and is removed immediately after the copy attempt.
 */
export async function copyInvitationUrl(
  activationUrl: string,
  navigatorLike: ClipboardNavigatorLike | undefined = typeof navigator === "undefined" ? undefined : navigator,
  documentLike: CopyDocumentLike | undefined = typeof document === "undefined" ? undefined : document,
): Promise<void> {
  if (navigatorLike?.clipboard?.writeText) {
    await navigatorLike.clipboard.writeText(activationUrl);
    return;
  }
  if (documentLike === undefined) throw new Error("Clipboard access is unavailable in this browser");

  const temporary = documentLike.createElement("textarea");
  temporary.value = activationUrl;
  temporary.setAttribute("readonly", "");
  temporary.style.position = "fixed";
  temporary.style.inset = "-9999px auto auto -9999px";
  documentLike.body.appendChild(temporary);
  temporary.select();
  try {
    if (!documentLike.execCommand("copy")) throw new Error("The browser did not allow clipboard access");
  } finally {
    temporary.remove();
  }
}

export async function shareInvitation(
  details: InvitationShareDetails,
  navigatorLike: ShareNavigatorLike | undefined = typeof navigator === "undefined" ? undefined : navigator,
): Promise<ShareResult> {
  if (navigatorLike?.share === undefined) return "unsupported";
  try {
    await navigatorLike.share({
      title: "Your secure Sutra invitation",
      text: "Activate this Sutra invitation. The link is single-use.",
      url: details.activationUrl,
    });
    return "shared";
  } catch (error) {
    if (isAbortError(error)) return "cancelled";
    throw error;
  }
}
