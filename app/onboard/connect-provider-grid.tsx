"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { CLOUD_PROVIDERS, type CloudProviderId } from "../../lib/onboarding-providers";

/**
 * The "Connect your infrastructure" hub: one card per cloud provider, each
 * stating what a connection gives the customer and offering a Connect control
 * only when a collector actually exists behind it.
 *
 * The provider marks below are drawn here rather than embedded as vendor brand
 * assets. They are recognisable geometry in each provider's colour, used to
 * identify the destination of a link -- the vendor names do that work, and the
 * marks are ours, so no third-party logo file ships in this bundle.
 *
 * There is deliberately no customer-logo strip under the grid. Borrowed
 * customer names would be someone else's proof, and Sutra has no claim to it.
 */
const PROVIDER_MARKS: Record<CloudProviderId, ReactNode> = {
  aws: (
    <svg aria-hidden="true" height="26" viewBox="0 0 32 32" width="26">
      <path d="M8 14.5c0 .7.1 1.3.3 1.7l.5 1a.6.6 0 0 1-.2.8l-1 .6a.7.7 0 0 1-.9-.1 5 5 0 0 1-.8-1.4 4.6 4.6 0 0 1-3.7 1.7 3.4 3.4 0 0 1-2.5-.9A3.2 3.2 0 0 1 0 15.4c0-1.1.4-2 1.2-2.6a5 5 0 0 1 3.3-1c.5 0 1 0 1.6.1l1.2.3v-1c0-.9-.2-1.5-.6-1.9-.4-.4-1-.5-1.9-.5a5.5 5.5 0 0 0-2.6.6.7.7 0 0 1-.4.1c-.2 0-.3-.2-.3-.5v-.8c0-.2 0-.4.1-.5l.4-.3A6.6 6.6 0 0 1 5.6 7c1.4 0 2.4.3 3 1 .7.6 1 1.6 1 2.9zm-5.1 2c.4 0 .9 0 1.4-.2a3 3 0 0 0 1.3-.8l.4-.7c.1-.3.1-.6.1-1v-.5a8.8 8.8 0 0 0-2.2-.3c-.8 0-1.4.2-1.8.5-.4.3-.6.8-.6 1.4s.2 1 .5 1.3c.3.2.7.4 1.2.4z" fill="#ff9900" transform="translate(4 3)" />
      <path d="M4.6 22.8c8.2 3.8 15 1.5 18.6-.4.4-.2.7.2.4.5-3.2 3-8.4 4.4-13.7 2.4a13.4 13.4 0 0 1-5.5-3.4c-.2-.3 0-.6.2-.4z" fill="#ff9900" transform="translate(1 1)" />
      <path d="M9.4 12.5 12 20l2.4-7.5h1.9l2.4 7.5 2.6-7.5h1.8L19.6 22h-1.9l-2.4-7.3L13 22h-1.9L7.6 12.5z" fill="currentColor" opacity=".85" transform="translate(1 -5)" />
    </svg>
  ),
  azure: (
    <svg aria-hidden="true" height="26" viewBox="0 0 32 32" width="26">
      <path d="M12.6 4h6.1l-6.4 18.9a1 1 0 0 1-.9.7H6.7a1 1 0 0 1-.9-1.3l5.9-17.6a1 1 0 0 1 .9-.7z" fill="#0078d4" />
      <path d="M20.4 18.4H10.7a.5.5 0 0 0-.3.8l6.2 5.8a1 1 0 0 0 .7.3h5.6z" fill="#0078d4" opacity=".7" />
      <path d="M19.4 4h-6.8l-6 17.7a1 1 0 0 0 .9 1.3h4.9a1 1 0 0 0 .8-.7l1.3-3.9h6.9l-2-6.1h-4.5z" fill="#0078d4" opacity=".45" />
    </svg>
  ),
  gcp: (
    <svg aria-hidden="true" height="26" viewBox="0 0 32 32" width="26">
      <path d="M20 11h1l3-3-.1-1.3A13 13 0 0 0 5.6 9.4l2.6 2z" fill="#ea4335" />
      <path d="M25.3 9.4A13 13 0 0 0 20 11l-3.8 4.7 4.7 4.7 7.5-1.5A13 13 0 0 0 25.3 9.4z" fill="#fbbc05" />
      <path d="M7.6 26a13 13 0 0 0 8.4 3l7.5-6.9-3.6-3.5H12z" fill="#34a853" />
      <path d="M5.6 9.4A13 13 0 0 0 7.6 26l5.1-5.1-4.5-4.5z" fill="#4285f4" />
    </svg>
  ),
  oracle: (
    <svg aria-hidden="true" height="26" viewBox="0 0 32 32" width="26">
      <rect fill="none" height="12" rx="6" stroke="#c74634" strokeWidth="3.2" width="24" x="4" y="10" />
    </svg>
  ),
};

/**
 * @param heading Rendered as the section's own `h2`. The welcome flow and the
 *   standalone connect page word this differently, so it is never hard-coded.
 */
export function ConnectProviderGrid({
  heading,
  intro,
  selectedId,
}: {
  readonly heading: string;
  readonly intro?: string;
  /** Highlights the provider already being configured, if any. */
  readonly selectedId?: CloudProviderId;
}) {
  return (
    <section aria-labelledby="connect-providers-title" className="connect-hub">
      <h2 className="connect-hub-title" id="connect-providers-title">{heading}</h2>
      {intro === undefined ? null : <p className="connect-hub-intro">{intro}</p>}
      <div className="connect-provider-grid">
        {CLOUD_PROVIDERS.map((provider) => {
          const available = provider.connectHref !== null;
          return (
            <article
              className="connect-provider-card"
              data-available={available ? "true" : "false"}
              data-selected={provider.id === selectedId ? "true" : undefined}
              key={provider.id}
            >
              <span className="connect-provider-mark">{PROVIDER_MARKS[provider.id]}</span>
              <strong className="connect-provider-name">{provider.shortName}</strong>
              <p className="connect-provider-capability">{provider.capability}</p>
              {available && provider.connectHref !== null ? (
                <Link className="button button-primary connect-provider-action" href={provider.connectHref}>
                  Connect {provider.name}
                </Link>
              ) : (
                <>
                  <span aria-disabled="true" className="connect-provider-action connect-provider-blocked">
                    Not yet available
                  </span>
                  <small className="connect-provider-reason">{provider.unavailableReason}</small>
                </>
              )}
            </article>
          );
        })}
      </div>
      <p className="connect-hub-note">
        Read-only permissions required · Guided setup · No credit card needed.
      </p>
    </section>
  );
}
