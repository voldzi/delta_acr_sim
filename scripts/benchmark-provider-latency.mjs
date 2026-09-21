#!/usr/bin/env node

const options = parseArgs(process.argv.slice(2));
const baseUrl = options.baseUrl.replace(/\/$/, "");
const suffix = options.bypassGatewayCache ? "&nocache=1" : "";
const cases = [
  { name: "live", path: "/health/live", maxP95Ms: 250, requests: 5, concurrency: 1, warmup: 0 },
  {
    name: "flight-positions",
    path: `/flight-data/api/v1/aircraft/positions?bbox=12,48,19,52&limit=250${suffix}`,
    maxP95Ms: 1000
  },
  {
    name: "communications-towers",
    path: `/situation-data/api/v1/features?bbox=14.2,49.95,14.6,50.2&layers=mobile&source=osm_postgis&limit=20${suffix}`,
    maxP95Ms: 750
  },
  {
    name: "mobile-coverage",
    path: `/situation-data/api/v1/features?bbox=14.2,49.95,14.6,50.2&layers=mobile_coverage&source=mobile_coverage_model&technology=4G&limit=20${suffix}`,
    maxP95Ms: 1000
  },
  {
    name: "safety-summary",
    path: `/safety-data/api/v1/features/summary?bbox=12,48.5,19,51.2&layers=boundary_admin&source=admin_boundaries&limit=20${suffix}`,
    maxP95Ms: 1000
  }
];

const results = [];
for (const benchmark of cases) {
  for (let index = 0; index < (benchmark.warmup ?? options.warmup); index += 1) {
    await request(`${baseUrl}${benchmark.path}`, options.timeoutMs);
  }
  results.push(await runCase(benchmark));
}

const failed = results.some((result) => result.errors > 0 || result.p95Ms > result.maxP95Ms);
console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      baseUrl,
      requestsPerCase: options.requests,
      concurrency: options.concurrency,
      bypassGatewayCache: options.bypassGatewayCache,
      status: failed ? "failed" : "passed",
      results
    },
    null,
    2
  )
);
process.exitCode = failed ? 1 : 0;

async function runCase(benchmark) {
  const requestCount = benchmark.requests ?? options.requests;
  const concurrency = benchmark.concurrency ?? options.concurrency;
  const latencies = [];
  const statuses = new Map();
  let cursor = 0;
  let errors = 0;
  const startedAt = performance.now();

  async function worker() {
    while (cursor < requestCount) {
      cursor += 1;
      const result = await request(`${baseUrl}${benchmark.path}`, options.timeoutMs);
      latencies.push(result.latencyMs);
      statuses.set(result.status, (statuses.get(result.status) ?? 0) + 1);
      if (result.status < 200 || result.status >= 300) {
        errors += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, requestCount) }, () => worker()));
  const durationMs = performance.now() - startedAt;
  latencies.sort((left, right) => left - right);
  return {
    name: benchmark.name,
    requests: requestCount,
    concurrency,
    errors,
    statuses: Object.fromEntries([...statuses.entries()].sort(([left], [right]) => left - right)),
    throughputPerSecond: round((requestCount * 1000) / durationMs),
    minMs: percentile(latencies, 0),
    medianMs: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    maxMs: percentile(latencies, 1),
    maxP95Ms: benchmark.maxP95Ms,
    passed: errors === 0 && percentile(latencies, 0.95) <= benchmark.maxP95Ms
  };
}

async function request(url, timeoutMs) {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    await response.arrayBuffer();
    return { status: response.status, latencyMs: Math.round(performance.now() - startedAt) };
  } catch {
    return { status: 0, latencyMs: Math.round(performance.now() - startedAt) };
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * fraction) - 1))];
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function parseArgs(argv) {
  const parsed = {
    baseUrl: "http://127.0.0.1:5020",
    requests: 100,
    concurrency: 20,
    warmup: 3,
    timeoutMs: 5000,
    bypassGatewayCache: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--base-url") parsed.baseUrl = argv[++index];
    else if (value === "--requests") parsed.requests = integer(argv[++index], 1, 10_000, value);
    else if (value === "--concurrency") parsed.concurrency = integer(argv[++index], 1, 500, value);
    else if (value === "--warmup") parsed.warmup = integer(argv[++index], 0, 100, value);
    else if (value === "--timeout-ms") parsed.timeoutMs = integer(argv[++index], 100, 60_000, value);
    else if (value === "--bypass-gateway-cache") parsed.bypassGatewayCache = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!parsed.baseUrl) throw new Error("--base-url must not be empty");
  return parsed;
}

function integer(raw, minimum, maximum, name) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}
