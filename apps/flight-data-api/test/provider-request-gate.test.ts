import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderRequestGate } from "../src/provider-request-gate.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("provider-wide cooldown", () => {
  it("does not amplify 429, honors Retry-After across different viewports and recovers", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "120" } }))
      .mockResolvedValue(new Response('{"ac":[]}', { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const gate = new ProviderRequestGate();
    await expect(gate.json("https://example.org/a", 1000, {})).rejects.toThrow("429");
    for (let i = 0; i < 1000; i++) await expect(gate.json(`https://example.org/${i}`, 1000, {})).rejects.toThrow("cooldown");
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(119_999);
    await expect(gate.json("https://example.org/b", 1000, {})).rejects.toThrow("cooldown");
    vi.advanceTimersByTime(1);
    expect(await gate.json("https://example.org/b", 1000, {})).toEqual({ ac: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("bounds concurrent upstream requests and applies backoff to network failure", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const fetcher = vi.fn(() => new Promise((_resolve, r) => { reject = r; }));
    vi.stubGlobal("fetch", fetcher);
    const gate = new ProviderRequestGate();
    const first = gate.json("https://example.org/a", 1000, {});
    await expect(gate.json("https://example.org/b", 1000, {})).rejects.toThrow("cooldown");
    reject(new Error("network unavailable"));
    await expect(first).rejects.toThrow("network unavailable");
    await expect(gate.json("https://example.org/c", 1000, {})).rejects.toThrow("cooldown");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
