"use client";

import { useCallback, useEffect, useState } from "react";
import type { PortfolioState } from "../../lib/portfolio-types";

interface PortfolioErrorBody {
  readonly error?: { readonly message?: string };
}

async function loadPortfolio(): Promise<PortfolioState> {
  const response = await fetch("/api/v1/portfolio", { cache: "no-store", credentials: "same-origin" });
  const body = await response.json().catch(() => null) as ({ readonly portfolio?: PortfolioState } & PortfolioErrorBody) | null;
  if (!response.ok || body?.portfolio === undefined) {
    throw new Error(body?.error?.message ?? "Sutra could not load the customer portfolio");
  }
  return body.portfolio;
}

export function usePortfolio(): {
  readonly portfolio: PortfolioState | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
} {
  const [portfolio, setPortfolio] = useState<PortfolioState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setPortfolio(await loadPortfolio());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not load the customer portfolio");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    let current = true;
    void loadPortfolio().then((loaded) => {
      if (!current) return;
      setPortfolio(loaded);
      setError(null);
    }).catch((caught: unknown) => {
      if (current) setError(caught instanceof Error ? caught.message : "Sutra could not load the customer portfolio");
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => {
      current = false;
    };
  }, []);
  return { portfolio, loading, error, refresh };
}
