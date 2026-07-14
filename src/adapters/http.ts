/**
 * Shared fetch conventions for source adapters (#21): every request
 * times out, because a hung upstream connection must fail that one
 * source — skipped and retried from its cursor next run — rather than
 * stall the whole pipeline until the Actions job timeout kills it.
 */
export const FETCH_TIMEOUT_MS = 10_000;

/** An abort names the URL, so per-source failure logging stays informative. */
export const fetchWithTimeout = async (
  url: string,
  init: Omit<RequestInit, "signal"> = {},
): Promise<Response> => {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`${url} fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw error;
  }
};

export const fetchJson = async <T>(
  url: string,
  init: Omit<RequestInit, "signal"> = {},
): Promise<T> => {
  const response = await fetchWithTimeout(url, init);
  if (!response.ok) {
    throw new Error(`${url} fetch failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
};
