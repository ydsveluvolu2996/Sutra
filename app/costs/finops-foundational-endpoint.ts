"use client";

import { useCallback, useEffect, useState } from "react";
import {
  cudosUrl,
  costIntelligenceUrl,
  kpiUrl,
  readEnvelope,
  stateForEnvelope,
  validCostIntelligenceEnvelope,
  validCudosEnvelope,
  validKpiEnvelope,
  type CostIntelligenceEnvelope,
  type CudosEnvelope,
  type EndpointState,
  type KpiEnvelope,
} from "./finops-foundational-panels";

/**
 * One loader for the three Foundational endpoints.
 *
 * The URL builders, envelope validators, schema check and state machine are
 * imported from the existing foundational panels rather than reimplemented:
 * those validators enforce the tenant binding, the pinned official-definition
 * hashes and the source-state/evidence cross-checks, and a second
 * implementation would be a second thing to keep correct.
 *
 * The hook adds only what a per-dashboard route needs that the concern-based
 * panels did not: a reusable fetch lifecycle with abort on unmount and an
 * explicit reload.
 */

export type FoundationalEndpointStatus = EndpointState<unknown>["status"];

export interface FoundationalEndpointResult<T> {
  readonly state: EndpointState<T>;
  readonly reload: () => void;
}

const SCHEMA = {
  cudos: "sutra.finops-cudos.v1",
  costIntelligence: "sutra.finops-cost-intelligence.v1",
  kpi: "sutra.finops-kpi.v1",
} as const;

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Sutra could not load the canonical billing evidence.";
}

/**
 * Fetch and validate one endpoint. `url` of `null` means the prerequisites are
 * not met (no connection yet), which stays `idle` rather than being reported as
 * an error — a missing connection is not a failed request.
 */
function useEndpoint<T extends {
  readonly report: { readonly ok: boolean } | null;
  readonly sourceState: string;
}>(
  url: string | null,
  connectionId: string | null,
  schema: string,
  validate: (value: Readonly<Record<string, unknown>>) => boolean,
): FoundationalEndpointResult<T> {
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  /**
   * Settled results are keyed by the request that produced them, so `idle` and
   * `loading` are derived rather than written. That keeps the effect free of
   * direct state writes and makes a late response for a superseded request
   * impossible to display.
   */
  const [settled, setSettled] = useState<{
    readonly key: string;
    readonly state: EndpointState<T>;
  } | null>(null);
  const key = url === null ? null : `${nonce}:${url}`;

  useEffect(() => {
    if (url === null || connectionId === null || key === null) return;
    const controller = new AbortController();
    let active = true;

    void (async () => {
      try {
        const response = await fetch(url, {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        const envelope = await readEnvelope<T>(response, connectionId, schema, validate);
        if (active) setSettled({ key, state: stateForEnvelope(envelope) });
      } catch (error) {
        // An aborted request is a navigation, not a failure worth reporting.
        if (!active || controller.signal.aborted) return;
        setSettled({ key, state: { status: "error", message: message(error) } });
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [url, connectionId, schema, validate, key]);

  const state: EndpointState<T> = url === null || connectionId === null
    ? { status: "idle" }
    : settled !== null && settled.key === key
      ? settled.state
      : { status: "loading" };

  return { state, reload };
}

export function useCudosEndpoint(connectionId: string | null): FoundationalEndpointResult<CudosEnvelope> {
  return useEndpoint<CudosEnvelope>(
    connectionId === null ? null : cudosUrl(connectionId),
    connectionId,
    SCHEMA.cudos,
    validCudosEnvelope,
  );
}

export function useCostIntelligenceEndpoint(
  connectionId: string | null,
): FoundationalEndpointResult<CostIntelligenceEnvelope> {
  return useEndpoint<CostIntelligenceEnvelope>(
    connectionId === null ? null : costIntelligenceUrl(connectionId),
    connectionId,
    SCHEMA.costIntelligence,
    validCostIntelligenceEnvelope,
  );
}

export interface KpiEndpointFilters {
  readonly period: string;
  readonly accountId: string;
  readonly payerAccountId: string;
}

export const EMPTY_KPI_FILTERS: KpiEndpointFilters =
  Object.freeze({ period: "", accountId: "", payerAccountId: "" });

export function useKpiEndpoint(
  connectionId: string | null,
  filters: KpiEndpointFilters,
): FoundationalEndpointResult<KpiEnvelope> {
  return useEndpoint<KpiEnvelope>(
    connectionId === null ? null : kpiUrl(connectionId, filters),
    connectionId,
    SCHEMA.kpi,
    validKpiEnvelope,
  );
}

/** Narrow a state to its ready form so a renderer can rely on the envelope. */
export function readyEnvelope<T>(state: EndpointState<T>): T | null {
  return state.status === "ready" && "envelope" in state ? state.envelope : null;
}
