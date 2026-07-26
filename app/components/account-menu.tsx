"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Capability } from "../../lib/auth-policy";
import { GlyphIcon } from "./nav-icon";

export function AccountMenu({
  displayName,
  email,
  roleLabel,
  organizationName,
  initials,
  mfaVerified,
  capabilities,
  signingOut,
  onSignOut,
}: {
  readonly displayName: string;
  readonly email: string;
  readonly roleLabel: string;
  readonly organizationName: string;
  readonly initials: string;
  readonly mfaVerified: boolean;
  readonly capabilities: ReadonlySet<Capability>;
  readonly signingOut: boolean;
  readonly onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // pointerdown (not mousedown) so a touch outside the panel dismisses it on
    // the first tap instead of waiting for the emulated mouse event.
    const onPointerDown = (event: PointerEvent) => {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="account-menu" ref={containerRef}>
      <button
        type="button"
        className="topbar-avatar account-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${displayName}`}
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
      >
        {initials}
      </button>
      {open ? (
        <div className="account-menu-panel" role="menu">
          <div className="account-menu-head">
            <span className="account-menu-avatar" aria-hidden="true">{initials}</span>
            <div>
              <strong>{displayName}</strong>
              <small>{email}</small>
              <span className="account-menu-role">{roleLabel} · {organizationName}</span>
            </div>
          </div>
          <div className="account-menu-status">
            <span className={`account-menu-mfa ${mfaVerified ? "is-verified" : "is-pending"}`}>
              <i aria-hidden="true" /> {mfaVerified ? "MFA verified" : "MFA required"}
            </span>
          </div>
          <div className="account-menu-links">
            <Link href="/settings" role="menuitem" onClick={() => setOpen(false)}><GlyphIcon className="account-menu-glyph" name="gear" size={14} />Settings</Link>
            <Link href="/settings/notifications" role="menuitem" onClick={() => setOpen(false)}><GlyphIcon className="account-menu-glyph" name="bell" size={14} />Notification destinations</Link>
            {capabilities.has("membership:manage") || capabilities.has("membership:manage:customer")
              ? <Link href="/access" role="menuitem" onClick={() => setOpen(false)}><GlyphIcon className="account-menu-glyph" name="key" size={14} />Access &amp; invitations</Link>
              : null}
            <Link href="/docs" role="menuitem" onClick={() => setOpen(false)}><GlyphIcon className="account-menu-glyph" name="fileText" size={14} />Documentation</Link>
            <Link href="/controls#architecture" role="menuitem" onClick={() => setOpen(false)}><GlyphIcon className="account-menu-glyph" name="policy" size={14} />Architecture &amp; trust</Link>
          </div>
          <button
            type="button"
            className="account-menu-signout"
            role="menuitem"
            disabled={signingOut}
            onClick={() => { setOpen(false); onSignOut(); }}
          >
            <GlyphIcon className="account-menu-glyph" name="logout" size={14} />{signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
