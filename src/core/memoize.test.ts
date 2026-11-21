import { describe, expect, it, vi } from "vite-plus/test";
import { memoizeAsync } from "./memoize.ts";

describe("memoizeAsync", () => {
  it("calls the loader once and shares the result", async () => {
    const load = vi.fn(() => Promise.resolve({ value: 1 }));
    const shared = memoizeAsync(load);
    const [a, b] = await Promise.all([shared(), shared()]);
    expect(a).toBe(b);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("shares a rejection instead of retrying", async () => {
    const load = vi.fn(() => Promise.reject(new Error("down")));
    const shared = memoizeAsync(load);
    await expect(shared()).rejects.toThrow("down");
    await expect(shared()).rejects.toThrow("down");
    expect(load).toHaveBeenCalledTimes(1);
  });
});
