import type { Request, Response as ExpressResponse } from "express";

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
  const response = await request(url, timeoutMs);
  return (await response.json()) as T;
}

export async function requestText(url: string, timeoutMs: number): Promise<string> {
  const response = await request(url, timeoutMs);
  return response.text();
}

async function request(url: string, timeoutMs: number): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "DELTA-ACR-SIM/0.1 safety-data-api"
      }
    });
    if (!response.ok) {
      throw new Error(`GET ${url} failed with ${response.status}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}
