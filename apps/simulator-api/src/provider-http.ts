export interface ProviderJsonOptions {
  maxBytes: number;
  timeoutMs: number;
}

export interface ProviderJsonResult {
  latencyMs: number;
  payload: unknown;
}

export async function fetchProviderJson(url: string, options: ProviderJsonOptions): Promise<ProviderJsonResult> {
  const startedAt = Date.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs) });
  const latencyMs = Date.now() - startedAt;
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const text = await readResponseText(response, options.maxBytes);
  try {
    return {
      latencyMs,
      payload: JSON.parse(text) as unknown
    };
  } catch (error) {
    throw new Error(`invalid JSON response: ${error instanceof Error ? error.message : "unknown parse error"}`);
  }
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`response too large: ${contentLength} bytes > ${maxBytes} bytes`);
  }
  if (!response.body) {
    const text = await response.text();
    enforceTextSize(text, maxBytes);
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    receivedBytes += value.byteLength;
    if (receivedBytes > maxBytes) {
      await reader.cancel();
      throw new Error(`response too large: ${receivedBytes} bytes > ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function enforceTextSize(text: string, maxBytes: number): void {
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > maxBytes) {
    throw new Error(`response too large: ${byteLength} bytes > ${maxBytes} bytes`);
  }
}
