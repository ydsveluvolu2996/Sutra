"use client";

import { useEffect, useRef, useState } from "react";

import type {
  TurnstileAction,
  TurnstileClientConfiguration,
} from "../../lib/turnstile-contract";

const TURNSTILE_SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileRenderOptions {
  readonly sitekey: string;
  readonly action: TurnstileAction;
  readonly theme: "auto";
  readonly size: "flexible";
  readonly appearance: "interaction-only";
  readonly callback: (token: string) => void;
  readonly "expired-callback": () => void;
  readonly "error-callback": () => void;
}

interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let turnstileLoader: Promise<TurnstileApi> | null = null;

/**
 * A failed challenge must never be a dead end. The two failure modes need
 * different guidance: Sutra's own configuration endpoint being unreachable is
 * an operator problem, while a blocked challenges.cloudflare.com is almost
 * always a network filter, VPN or extension on the visitor's side.
 */
const CONFIGURATION_FAILURE = "configuration" as const;
const CHALLENGE_FAILURE = "challenge" as const;

type FailureKind = typeof CONFIGURATION_FAILURE | typeof CHALLENGE_FAILURE;

type WidgetStatus = "loading" | "bypassed" | "active" | "error";

class TurnstileClientError extends Error {
  public readonly kind: FailureKind;

  public constructor(kind: FailureKind, message: string) {
    super(message);
    this.name = "TurnstileClientError";
    this.kind = kind;
  }
}

const FAILURE_MESSAGE: Record<FailureKind, string> = {
  [CONFIGURATION_FAILURE]:
    "Sutra could not load the security check settings. Try again, or reload the page.",
  [CHALLENGE_FAILURE]:
    "The security check could not load. A VPN, network filter or browser extension that blocks challenges.cloudflare.com is the usual cause. Try again, or switch network.",
};

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile !== undefined) return Promise.resolve(window.turnstile);
  if (turnstileLoader !== null) return turnstileLoader;
  turnstileLoader = new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      "script[data-sutra-turnstile]",
    );
    const script = existing ?? document.createElement("script");
    const timeout = window.setTimeout(() => {
      script.remove();
      reject(new Error("Turnstile script timed out"));
    }, 10_000);
    const onLoad = () => {
      window.clearTimeout(timeout);
      if (window.turnstile === undefined) {
        script.remove();
        reject(new Error("Turnstile did not initialize"));
        return;
      }
      resolve(window.turnstile);
    };
    const onError = () => {
      window.clearTimeout(timeout);
      script.remove();
      reject(new Error("Turnstile could not be loaded"));
    };
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
    if (existing === null) {
      script.src = TURNSTILE_SCRIPT;
      script.async = true;
      script.defer = true;
      script.dataset.sutraTurnstile = "true";
      document.head.append(script);
    }
  }).catch((error: unknown) => {
    turnstileLoader = null;
    throw new TurnstileClientError(
      CHALLENGE_FAILURE,
      error instanceof Error ? error.message : "Turnstile could not be loaded",
    );
  });
  return turnstileLoader;
}

export interface TurnstileWidgetProps {
  readonly action: TurnstileAction;
  readonly resetSignal: number;
  readonly onChange: (token: string | null, ready: boolean) => void;
}

export default function TurnstileWidget({
  action,
  resetSignal,
  onChange,
}: TurnstileWidgetProps) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const api = useRef<TurnstileApi | null>(null);
  const bypassed = useRef(false);
  const onChangeRef = useRef(onChange);
  const mounted = useRef(false);
  const [message, setMessage] = useState("Loading security check…");
  const [status, setStatus] = useState<WidgetStatus>("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    onChangeRef.current(null, false);
    void fetch("/api/turnstile/config", {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | TurnstileClientConfiguration
          | null;
        if (!response.ok || body === null) {
          throw new TurnstileClientError(
            CONFIGURATION_FAILURE,
            "Security check configuration is unavailable",
          );
        }
        return body;
      })
      .then(async (configuration) => {
        if (!active) return;
        // The server is the only authority on whether the challenge is
        // active. `enabled: false` means this runtime resolved the
        // loopback-only local bypass, so Siteverify will not be consulted and
        // rendering a challenge here would only produce an unsolvable widget.
        if (!configuration.enabled) {
          bypassed.current = true;
          setMessage("");
          setStatus("bypassed");
          onChangeRef.current(null, true);
          return;
        }
        if (!configuration.siteKey || container.current === null) {
          throw new TurnstileClientError(
            CONFIGURATION_FAILURE,
            "Security check configuration is invalid",
          );
        }
        const loaded = await loadTurnstile();
        if (!active || container.current === null) return;
        api.current = loaded;
        widgetId.current = loaded.render(container.current, {
          sitekey: configuration.siteKey,
          action,
          theme: "auto",
          size: "flexible",
          appearance: "interaction-only",
          callback: (token) => {
            if (!mounted.current) return;
            setMessage("Security check complete.");
            setStatus("active");
            onChangeRef.current(token, true);
          },
          "expired-callback": () => {
            if (!mounted.current) return;
            setMessage("Security check expired. Please complete it again.");
            setStatus("error");
            onChangeRef.current(null, false);
          },
          "error-callback": () => {
            if (!mounted.current) return;
            setMessage(FAILURE_MESSAGE[CHALLENGE_FAILURE]);
            setStatus("error");
            onChangeRef.current(null, false);
          },
        });
        setMessage("Security check ready.");
        setStatus("active");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setMessage(
          FAILURE_MESSAGE[
            error instanceof TurnstileClientError
              ? error.kind
              : CHALLENGE_FAILURE
          ],
        );
        setStatus("error");
        onChangeRef.current(null, false);
      });
    return () => {
      active = false;
      mounted.current = false;
      if (api.current !== null && widgetId.current !== null) {
        api.current.remove(widgetId.current);
      }
      widgetId.current = null;
      api.current = null;
      bypassed.current = false;
    };
  }, [action, attempt]);

  useEffect(() => {
    if (bypassed.current) {
      setMessage("");
      setStatus("bypassed");
      onChangeRef.current(null, true);
      return;
    }
    if (api.current === null || widgetId.current === null) return;
    api.current.reset(widgetId.current);
    setMessage("Complete the refreshed security check.");
    setStatus("active");
    onChangeRef.current(null, false);
  }, [resetSignal]);

  // In server-signalled bypass mode there is no challenge to solve, so the
  // widget contributes no chrome at all.
  if (status === "bypassed") return null;

  const failed = status === "error";
  return (
    <div
      className={`sutra-turnstile${failed ? " is-error" : ""}`}
      aria-label="Automated abuse protection"
    >
      <div ref={container} />
      <p role={failed ? "alert" : "status"} aria-live="polite">
        {message}
      </p>
      {failed ? (
        <button
          className="button button-secondary sutra-turnstile-retry"
          onClick={() => setAttempt((current) => current + 1)}
          type="button"
        >
          Retry security check
        </button>
      ) : null}
    </div>
  );
}
