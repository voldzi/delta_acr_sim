import type { Request, Response as ExpressResponse } from "express";

export class HttpRequestError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status: number
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}

export function problem(req: Request, res: ExpressResponse, status: number, code: string, message: string): void {
  res.status(status).json({
    error: {
      code,
      message,
      correlationId: req.headers["x-correlation-id"] ?? crypto.randomUUID()
    }
  });
}

export async function requestJson<T>(url: string, timeoutMs: number): Promise<T> {
  return request(url, timeoutMs, async (response) => (await response.json()) as T);
}

export async function requestText(url: string, timeoutMs: number): Promise<string> {
  return request(url, timeoutMs, (response) => response.text());
}

async function request<T>(url: string, timeoutMs: number, consume: (response: globalThis.Response) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "CSM-SIM/0.1 safety-data-api"
      }
    });
    if (!response.ok) {
      throw new HttpRequestError(`GET ${url} failed with ${response.status}`, url, response.status);
    }
    // Keep the same deadline active until the response body has been consumed.
    return await consume(response);
  } finally {
    clearTimeout(timeout);
  }
}
