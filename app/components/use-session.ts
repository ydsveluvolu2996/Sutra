"use client";

import { useCallback, useEffect, useState } from "react";
import type { PublicLocalSession } from "../../db/auth-repository";

interface AuthErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };
}

export class AuthRequestError extends Error {
  public readonly code: string;
  public readonly status: number;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AuthRequestError";
    this.status = status;
    this.code = code;
  }
}

export async function readAuthResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as (T & AuthErrorBody) | null;
  if (!response.ok) {
    throw new AuthRequestError(
      response.status,
      body?.error?.code ?? "AUTH_REQUEST_FAILED",
      body?.error?.message ?? "Sutra could not complete the authentication request",
    );
  }
  if (body === null) {
    throw new AuthRequestError(502, "AUTH_RESPONSE_INVALID", "Sutra received an invalid authentication response");
  }
  return body;
}

export async function postAuth<T>(path: string, body?: unknown, authorizationToken?: string): Promise<T> {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (authorizationToken !== undefined) headers.set("authorization", `Bearer ${authorizationToken}`);
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await readAuthResponse<T>(response);
  window.dispatchEvent(new Event("sutra:session-changed"));
  return result;
}

export interface SessionView {
  readonly session: PublicLocalSession | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<PublicLocalSession | null>;
}

async function loadSession(): Promise<PublicLocalSession | null> {
  const response = await fetch("/api/auth/session", {
    cache: "no-store",
    credentials: "same-origin",
  });
  const body = await readAuthResponse<{ session: PublicLocalSession | null }>(response);
  return body.session;
}

export function useSession(): SessionView {
  const [session, setSession] = useState<PublicLocalSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const current = await loadSession();
      setSession(current);
      setError(null);
      return current;
    } catch (caught) {
      setSession(null);
      setError(caught instanceof Error ? caught.message : "Sutra could not check the local session");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let current = true;
    const reload = () => {
      void loadSession().then((loaded) => {
        if (!current) return;
        setSession(loaded);
        setError(null);
      }).catch((caught: unknown) => {
        if (!current) return;
        setSession(null);
        setError(caught instanceof Error ? caught.message : "Sutra could not check the local session");
      }).finally(() => {
        if (current) setLoading(false);
      });
    };
    reload();
    window.addEventListener("sutra:session-changed", reload);
    return () => {
      current = false;
      window.removeEventListener("sutra:session-changed", reload);
    };
  }, []);

  return { session, loading, error, refresh };
}

export function safeReturnTo(search: string, fallback = "/dashboard"): string {
  const requested = new URLSearchParams(search).get("returnTo");
  if (requested === null || !requested.startsWith("/") || requested.startsWith("//")) return fallback;
  try {
    const parsed = new URL(requested, window.location.origin);
    if (parsed.origin !== window.location.origin) return fallback;
    if (parsed.pathname === "/login") return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
