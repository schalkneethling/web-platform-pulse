import { describe, expect, it } from "vite-plus/test";
import { fetchJson, fetchWithTimeout } from "./http.ts";

const withFetch = async (
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>,
): Promise<void> => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
  }
};

describe("fetchWithTimeout", () => {
  it("attaches a timeout signal and passes the init through", async () => {
    await withFetch(
      async (_input, init) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
        return new Response("ok", { status: 200 });
      },
      async () => {
        const response = await fetchWithTimeout("https://example.test/artifact", {
          headers: { authorization: "Bearer token" },
        });
        expect(response.status).toBe(200);
      },
    );
  });

  it("names the URL when the request times out (§ per-source failure logging)", async () => {
    await withFetch(
      async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
      async () => {
        await expect(fetchWithTimeout("https://example.test/slow")).rejects.toThrow(
          "https://example.test/slow fetch timed out",
        );
      },
    );
  });

  it("rethrows non-timeout failures untouched", async () => {
    await withFetch(
      async () => {
        throw new TypeError("Unable to connect");
      },
      async () => {
        await expect(fetchWithTimeout("https://example.test/down")).rejects.toThrow(
          "Unable to connect",
        );
      },
    );
  });
});

describe("fetchJson", () => {
  it("parses the payload of an OK response", async () => {
    await withFetch(
      async () => Response.json({ answer: 42 }),
      async () => {
        expect(await fetchJson<{ answer: number }>("https://example.test/data")).toEqual({
          answer: 42,
        });
      },
    );
  });

  it("names the URL and status on a non-OK response", async () => {
    await withFetch(
      async () => new Response("nope", { status: 503, statusText: "Service Unavailable" }),
      async () => {
        await expect(fetchJson("https://example.test/data")).rejects.toThrow(
          "https://example.test/data fetch failed: 503 Service Unavailable",
        );
      },
    );
  });
});
