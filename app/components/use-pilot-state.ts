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

interface PilotBundle {
  readonly state: PilotState;
  readonly health: CollectorHealth | null;
}

// The app shell AND the rendered page each call usePilotState() independently
// (there is no shared provider), so a single navigation mounted the hook twice
// and fired two identical /api/pilot/state + /api/pilot/health fetches — each
// downloading the full CMDB snapshot. Coalesce concurrent callers onto one
// in-flight request (keyed by the resolved path) and hold a brief result cache
// so the second mount reuses the first fetch instead of re-downloading it.
const PILOT_CACHE_MS = 2500;
let pilotInFlight: { key: string; promise: Promise<PilotBundle> } | null = null;
let pilotCache: { key: string; at: number; value: PilotBundle } | null = null;

function pilotStatePath(): string {
  const selectedConnectionId = typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get("connectionId");
  return selectedConnectionId !== null && /^conn_[a-f0-9]{32}$/u.test(selectedConnectionId)
    ? `/api/pilot/state?connectionId=${encodeURIComponent(selectedConnectionId)}`
    : "/api/pilot/state";
}

async function fetchPilot(statePath: string): Promise<PilotBundle> {
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

async function loadPilot(options?: { fresh?: boolean }): Promise<PilotBundle> {
  const key = pilotStatePath();
  // Always coalesce onto a concurrent in-flight request for the same path.
  if (pilotInFlight !== null && pilotInFlight.key === key) return pilotInFlight.promise;
  // Serve the short cache for initial mounts; `fresh` (refresh / post-mutation)
  // bypasses it so callers always see the latest snapshot after a change.
  if (options?.fresh !== true && pilotCache !== null && pilotCache.key === key
      && Date.now() - pilotCache.at < PILOT_CACHE_MS) {
    return pilotCache.value;
  }
  const promise = fetchPilot(key);
  pilotInFlight = { key, promise };
  try {
    const value = await promise;
    pilotCache = { key, at: Date.now(), value };
    return value;
  } finally {
    if (pilotInFlight !== null && pilotInFlight.promise === promise) pilotInFlight = null;
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
      const loaded = await loadPilot({ fresh: true });
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
    const run = (fresh: boolean) => void loadPilot(fresh ? { fresh: true } : undefined).then((loaded) => {
      if (!current) return;
      setState(loaded.state);
      setHealth(loaded.health);
      setError(null);
    }).catch((caught: unknown) => {
      if (current) setError(caught instanceof Error ? caught.message : "Sutra could not load the pilot workspace");
    }).finally(() => {
      if (current) setLoading(false);
    });
    // Initial mount reuses any in-flight/recent fetch (the shell + page mount
    // this hook together); a mutation event forces a fresh reload.
    run(false);
    const onChanged = () => run(true);
    window.addEventListener("sutra:state-changed", onChanged);
    return () => {
      current = false;
      window.removeEventListener("sutra:state-changed", onChanged);
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
