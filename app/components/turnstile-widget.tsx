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
    throw error;
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
  const [failed, setFailed] = useState(false);

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
          throw new Error("Security check configuration is unavailable");
        }
        return body;
      })
      .then(async (configuration) => {
        if (!active) return;
        if (!configuration.enabled) {
          bypassed.current = true;
          setMessage("Security check bypassed for this local workspace.");
          setFailed(false);
          onChangeRef.current(null, true);
          return;
        }
        if (!configuration.siteKey || container.current === null) {
          throw new Error("Security check configuration is invalid");
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
            setFailed(false);
            onChangeRef.current(token, true);
          },
          "expired-callback": () => {
            if (!mounted.current) return;
            setMessage("Security check expired. Please complete it again.");
            setFailed(true);
            onChangeRef.current(null, false);
          },
          "error-callback": () => {
            if (!mounted.current) return;
            setMessage("Security check failed to load. Please retry.");
            setFailed(true);
            onChangeRef.current(null, false);
          },
        });
        setMessage("Security check ready.");
      })
      .catch(() => {
        if (!active) return;
        setMessage("Security check is unavailable. Please reload this page.");
        setFailed(true);
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
  }, [action]);

  useEffect(() => {
    if (bypassed.current) {
      setMessage("Security check bypassed for this local workspace.");
      setFailed(false);
      onChangeRef.current(null, true);
      return;
    }
    if (api.current === null || widgetId.current === null) return;
    api.current.reset(widgetId.current);
    setMessage("Complete the refreshed security check.");
    setFailed(false);
    onChangeRef.current(null, false);
  }, [resetSignal]);

  return (
    <div
      className={`sutra-turnstile${failed ? " is-error" : ""}`}
      aria-label="Automated abuse protection"
    >
      <div ref={container} />
      <p role={failed ? "alert" : "status"} aria-live="polite">
        {message}
      </p>
    </div>
  );
}
