import { createServer, type Server, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpRequestError, requestJson, requestText } from "../src/http.js";

const servers: Server[] = [];
const pendingServerTimers = new Set<ReturnType<typeof setTimeout>>();

async function loopback(handler: (response: ServerResponse, userAgent: string | undefined) => void): Promise<string> {
  const server = createServer((request, response) => handler(response, request.headers["user-agent"]));
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Loopback test server has no address");
  }
  return `http://127.0.0.1:${address.port}`;
}

function later(action: () => void, delayMs: number): void {
  const timer = setTimeout(() => {
    pendingServerTimers.delete(timer);
    action();
  }, delayMs);
  pendingServerTimers.add(timer);
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const timer of pendingServerTimers) {
    clearTimeout(timer);
  }
  pendingServerTimers.clear();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("Safety HTTP request whole-response deadline", () => {
  it.each(["json", "text"] as const)("aborts %s requests while waiting for headers", async (kind) => {
    const url = await loopback((response) => {
      later(() => response.end(kind === "json" ? '{"ok":true}' : "ok"), 500);
    });
    const startedAt = performance.now();
    const result = kind === "json" ? requestJson(url, 100) : requestText(url, 100);
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  it.each(["json", "text"] as const)("aborts %s body reads after headers have arrived", async (kind) => {
    let headersReceived = false;
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const response = await originalFetch(...args);
      headersReceived = true;
      return response;
    });
    const url = await loopback((response) => {
      response.writeHead(200, { "content-type": kind === "json" ? "application/json" : "text/plain" });
      response.flushHeaders();
      response.write(kind === "json" ? '{"ok":' : "part-");
      later(() => response.end(kind === "json" ? "true}" : "complete"), 500);
    });
    const startedAt = performance.now();
    const result = kind === "json" ? requestJson(url, 150) : requestText(url, 150);
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(headersReceived).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  it("uses one deadline across delayed headers and delayed body, not one per phase", async () => {
    const url = await loopback((response) => {
      later(() => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.flushHeaders();
        response.write("partial");
        later(() => response.end(" complete"), 250);
      }, 150);
    });
    const startedAt = performance.now();
    await expect(requestText(url, 300)).rejects.toMatchObject({ name: "AbortError" });
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  it("returns JSON and text unchanged with the existing user agent", async () => {
    const userAgents: Array<string | undefined> = [];
    const url = await loopback((response, userAgent) => {
      userAgents.push(userAgent);
      response.end('{"ok":true,"count":2}');
    });
    await expect(requestJson(url, 1000)).resolves.toEqual({ ok: true, count: 2 });
    await expect(requestText(url, 1000)).resolves.toBe('{"ok":true,"count":2}');
    expect(userAgents).toEqual(["CSM-SIM/0.1 safety-data-api", "CSM-SIM/0.1 safety-data-api"]);
  });

  it("preserves HTTP status errors without waiting for the error body", async () => {
    const url = await loopback((response) => {
      response.writeHead(503);
      response.flushHeaders();
      later(() => response.end("unavailable"), 500);
    });
    const result = requestText(url, 1000);
    await expect(result).rejects.toBeInstanceOf(HttpRequestError);
    await expect(result).rejects.toMatchObject({ url, status: 503, name: "HttpRequestError" });
  });

  it("preserves malformed JSON errors", async () => {
    const url = await loopback((response) => response.end("not-json"));
    await expect(requestJson(url, 1000)).rejects.toBeInstanceOf(SyntaxError);
  });

  it("clears the deadline after a successful body read", async () => {
    const url = await loopback((response) => response.end("complete"));
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const cleared: Array<ReturnType<typeof setTimeout> | undefined> = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => {
      const timer = originalSetTimeout(callback, delay, ...args);
      if (delay === 1234) {
        timers.push(timer);
      }
      return timer;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(((timer) => {
      cleared.push(timer);
      originalClearTimeout(timer);
    }) as typeof clearTimeout);
    await expect(requestText(url, 1234)).resolves.toBe("complete");
    expect(timers).toHaveLength(1);
    expect(cleared).toContain(timers[0]);
  });

  it("aborts the stalled response and clears its deadline", async () => {
    let responseClosed = false;
    let resolveClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const url = await loopback((response) => {
      response.once("close", () => {
        responseClosed = true;
        resolveClosed?.();
      });
      response.writeHead(200);
      response.flushHeaders();
      response.write("never complete");
    });
    const abort = vi.spyOn(AbortController.prototype, "abort");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    await expect(requestText(url, 150)).rejects.toMatchObject({ name: "AbortError" });
    await closed;
    expect(responseClosed).toBe(true);
    expect(abort).toHaveBeenCalled();
    expect(clear).toHaveBeenCalled();
  });
});
