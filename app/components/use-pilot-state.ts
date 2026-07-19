"use client";

import { useCallback, useEffect, useState } from "react";
import type { CollectorHealth, PilotState, SnapshotOrigin } from "../../lib/pilot-types";

interface PilotApiErrorBody {
  readonly error?: {
    readonly message?: string;
  };
}

export interface PilotStateView {
  readonly state: PilotState | null;
  readonly health: CollectorHealth | null;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as (T & PilotApiErrorBody) | null;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? "Sutra could not load the pilot workspace");
  }
  if (body === null) {
    throw new Error("Sutra received an empty response from the pilot API");
  }
  return body;
}

export async function postPilot<T>(path: string, body: unknown): Promise<T> {
  const result = await readJson<T>(await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  window.dispatchEvent(new Event("sutra:state-changed"));
  return result;
}

async function loadPilot(): Promise<{ state: PilotState; health: CollectorHealth | null }> {
  const selectedConnectionId = typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get("connectionId");
  const statePath = selectedConnectionId !== null && /^conn_[a-f0-9]{32}$/u.test(selectedConnectionId)
    ? `/api/pilot/state?connectionId=${encodeURIComponent(selectedConnectionId)}`
    : "/api/pilot/state";
  const [stateResponse, healthResponse] = await Promise.all([
    fetch(statePath, { cache: "no-store" }),
    fetch("/api/pilot/health", { cache: "no-store" }),
  ]);
  const { state } = await readJson<{ state: PilotState }>(stateResponse);
  try {
    const { health } = await readJson<{ health: CollectorHealth }>(healthResponse);
    return { state, health };
  } catch {
    // Stored CMDB evidence remains useful when the collector is temporarily
    // offline. Actions that need the collector surface their own errors.
    return { state, health: null };
  }
}

export function usePilotState(): PilotStateView {
  const [state, setState] = useState<PilotState | null>(null);
  const [health, setHealth] = useState<CollectorHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const loaded = await loadPilot();
      setState(loaded.state);
      setHealth(loaded.health);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not load the pilot workspace");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let current = true;
    const loadCurrent = () => void loadPilot().then((loaded) => {
      if (!current) return;
      setState(loaded.state);
      setHealth(loaded.health);
      setError(null);
    }).catch((caught: unknown) => {
      if (current) setError(caught instanceof Error ? caught.message : "Sutra could not load the pilot workspace");
    }).finally(() => {
      if (current) setLoading(false);
    });
    loadCurrent();
    window.addEventListener("sutra:state-changed", loadCurrent);
    return () => {
      current = false;
      window.removeEventListener("sutra:state-changed", loadCurrent);
    };
  }, []);

  return { state, health, loading, refreshing, error, refresh };
}

export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Not yet";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

export function compactIdentifier(value: string, leading = 12): string {
  return value.length <= leading + 7 ? value : `${value.slice(0, leading)}…${value.slice(-6)}`;
}

export function snapshotOriginLabel(origin: SnapshotOrigin | null | undefined): string {
  if (origin?.kind === "simulated_fixture") {
    return `Simulated fixture evidence${origin.fixtureVersion ? ` · ${origin.fixtureVersion}` : ""}`;
  }
  if (origin?.kind === "aws_sandbox") return "AWS sandbox evidence";
  return "Stored snapshot evidence";
}
