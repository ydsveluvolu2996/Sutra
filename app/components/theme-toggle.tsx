"use client";

import { useCallback, useSyncExternalStore } from "react";

/* ================================================================== *
 * Sun/moon light/dark theme toggle for the public marketing pages.
 *
 * The active theme lives on `document.documentElement` as
 * `data-theme="light" | "dark"`. A tiny inline script in the root
 * layout sets it before first paint (default: dark, the brand default)
 * so there is no flash, and this button flips it and persists the
 * choice to localStorage["sutra.theme"].
 *
 * SSR-safe: the theme is read through useSyncExternalStore with a
 * server snapshot of "dark", so the server render matches the pre-paint
 * default and there is no hydration mismatch. No Date.now() in render.
 *
 * The `.lz` CSS (app/globals.css) exposes the palette as custom
 * properties and overrides them under `:root[data-theme="light"] .lz`,
 * so flipping the attribute recolors every public surface. The landing
 * page's canvas listens for THEME_CHANGED to recolor its dot field.
 * ================================================================== */

const STORAGE_KEY = "sutra.theme";
export const THEME_CHANGED_EVENT = "sutra:theme-changed";

type Theme = "light" | "dark";

function currentTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function subscribe(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(THEME_CHANGED_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(THEME_CHANGED_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

const noopSubscribe = () => () => {};

export default function ThemeToggle() {
  const isHydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "dark" as Theme);

  const toggle = useCallback(() => {
    const next: Theme = currentTheme() === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* storage may be disabled — the in-memory attribute still applies */
    }
    window.dispatchEvent(new Event(THEME_CHANGED_EVENT));
  }, []);

  const isLight = theme === "light";
  const label = isLight ? "Switch to dark theme" : "Switch to light theme";

  return (
    <button
      type="button"
      className="lx-theme-toggle"
      onClick={toggle}
      aria-label={label}
      title={label}
      aria-pressed={isHydrated ? isLight : undefined}
      data-theme-state={isHydrated ? theme : "dark"}
    >
      {/* Sun (shown in dark theme — click for light) */}
      <svg className="lx-theme-sun" width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2v2.2M12 19.8V22M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2 12h2.2M19.8 12H22M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
      </svg>
      {/* Moon (shown in light theme — click for dark) */}
      <svg className="lx-theme-moon" width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 14.2A8 8 0 0 1 9.8 4 6.6 6.6 0 1 0 20 14.2Z" />
      </svg>
    </button>
  );
}
