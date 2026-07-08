#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";

const DEFAULT_INPUT = "apps/situation-data-api/data/curated-outdoor-webcams-cz.json";
const DEFAULT_OUTPUT = DEFAULT_INPUT;
const DEFAULT_REPORT = "docs/archive/camera-audits/curated-outdoor-webcams-direct-snapshot-audit.json";
const USER_AGENT = "csm-sim-camera-origin-enrichment/0.1";

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input ?? DEFAULT_INPUT;
const outputPath = args.output ?? DEFAULT_OUTPUT;
const reportPath = args.report ?? DEFAULT_REPORT;
const limit = args.limit ?? Number.POSITIVE_INFINITY;
const concurrency = Math.max(1, Math.min(args.concurrency ?? 8, 16));
const timeoutMs = Math.max(1500, Math.min(args.timeoutMs ?? 8000, 15000));
const dryRun = args.dryRun ?? false;

const feed = JSON.parse(await readFile(inputPath, "utf8"));
const locations = Array.isArray(feed.locations) ? feed.locations : [];
const pending = locations
  .filter((location) => Array.isArray(location.cameras) && location.cameras.length > 0)
  .slice(0, Number.isFinite(limit) ? limit : undefined);

let inspected = 0;
let directAdded = 0;
let directKept = 0;
let noCandidate = 0;
let failed = 0;

const reports = await mapConcurrent(pending, concurrency, async (location) => {
  const camera = location.cameras[0];
  inspected += 1;
  if (camera.directImageUrl) {
    directKept += 1;
    return {
      locationId: location.locationId,
      label: location.label,
      status: "already_direct",
      directImageUrl: camera.directImageUrl
    };
  }

  const pageUrl = validRuntimeFetchUrl(camera.providerUrl) ?? validRuntimeFetchUrl(location.providerPageUrl) ?? validRuntimeFetchUrl(location.sourceDataUrl);
  if (!pageUrl) {
    noCandidate += 1;
    return {
      locationId: location.locationId,
      label: location.label,
      status: "no_public_origin_page"
    };
  }

  try {
    const html = await requestText(pageUrl, timeoutMs);
    const candidates = extractImageCandidates(html, pageUrl).slice(0, 10);
    for (const candidate of candidates) {
      const verified = await verifyImage(candidate.url, timeoutMs).catch((error) => ({
        ok: false,
        reason: error instanceof Error ? error.message : String(error)
      }));
      if (!verified.ok) {
        continue;
      }
      if (!dryRun) {
        camera.providerUrl = pageUrl;
        camera.directImageUrl = candidate.url;
        camera.contentType = verified.contentType;
        camera.snapshotAvailable = true;
        location.verification = {
          ...(location.verification ?? {}),
          status: "direct_snapshot_verified",
          verifiedAt: new Date().toISOString(),
          directSnapshotUrl: candidate.url,
          directSnapshotContentType: verified.contentType,
          directSnapshotBytes: verified.bytes,
          discoverySource: "Origin provider page enrichment",
          note: "SIM fetches this origin image server-side for COP detail preview; WebCamLive remains discovery-only."
        };
      }
      directAdded += 1;
      return {
        locationId: location.locationId,
        label: location.label,
        providerPageUrl: pageUrl,
        status: "direct_snapshot_verified",
        directImageUrl: candidate.url,
        contentType: verified.contentType,
        bytes: verified.bytes,
        score: candidate.score,
        candidateCount: candidates.length
      };
    }
    noCandidate += 1;
    return {
      locationId: location.locationId,
      label: location.label,
      providerPageUrl: pageUrl,
      status: candidates.length === 0 ? "no_image_candidates" : "candidates_not_images",
      candidateCount: candidates.length,
      candidates: candidates.slice(0, 5).map((candidate) => ({ url: candidate.url, score: candidate.score }))
    };
  } catch (error) {
    failed += 1;
    return {
      locationId: location.locationId,
      label: location.label,
      providerPageUrl: pageUrl,
      status: "origin_page_failed",
      error: error instanceof Error ? error.message : String(error)
    };
  }
});

feed.generatedAt = new Date().toISOString();
feed.policy = {
  ...(feed.policy ?? {}),
  directSnapshotAudit: {
    generatedAt: feed.generatedAt,
    inspected,
    directAdded,
    directKept,
    noCandidate,
    failed
  }
};

const report = {
  generatedAt: feed.generatedAt,
  inputPath,
  outputPath,
  dryRun,
  concurrency,
  timeoutMs,
  summary: {
    locationsTotal: locations.length,
    inspected,
    directAdded,
    directKept,
    noCandidate,
    failed
  },
  results: reports
};

if (!dryRun) {
  await writeFile(outputPath, `${JSON.stringify(feed, null, 2)}\n`, "utf8");
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--input") {
      parsed.input = argv[++index];
    } else if (value === "--output") {
      parsed.output = argv[++index];
    } else if (value === "--report") {
      parsed.report = argv[++index];
    } else if (value === "--limit") {
      parsed.limit = Number(argv[++index]);
    } else if (value === "--concurrency") {
      parsed.concurrency = Number(argv[++index]);
    } else if (value === "--timeout-ms") {
      parsed.timeoutMs = Number(argv[++index]);
    } else if (value === "--dry-run") {
      parsed.dryRun = true;
    }
  }
  return parsed;
}

async function mapConcurrent(items, maxConcurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(maxConcurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function requestText(url, timeout) {
  const safeUrl = assertRuntimeFetchUrl(url);
  const response = await fetch(safeUrl, {
    headers: {
      accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "user-agent": USER_AGENT
    },
    redirect: "error",
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(safeUrl).hostname}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > 3_000_000) {
    throw new Error(`Origin page from ${new URL(safeUrl).hostname} is too large.`);
  }
  const html = await response.text();
  return html.length > 3_000_000 ? html.slice(0, 3_000_000) : html;
}

async function verifyImage(url, timeout) {
  const safeUrl = assertRuntimeFetchUrl(url);
  const response = await fetch(safeUrl, {
    headers: {
      accept: "image/webp,image/png,image/jpeg,image/gif,*/*;q=0.8",
      "user-agent": USER_AGENT
    },
    redirect: "error",
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(safeUrl).hostname}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > 5_000_000) {
    throw new Error(`Image from ${new URL(safeUrl).hostname} is too large.`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > 5_000_000) {
    throw new Error(`Image from ${new URL(safeUrl).hostname} is too large.`);
  }
  const declaredType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const contentType = declaredType?.startsWith("image/") ? declaredType : imageContentType(body);
  if (!validSnapshotContentType(contentType)) {
    throw new Error(`Candidate is not a supported raster camera image.`);
  }
  return { ok: true, contentType, bytes: body.length };
}

function extractImageCandidates(html, pageUrl) {
  const candidates = [];
  const add = (value, baseScore, context) => {
    const candidateUrl = validOriginSnapshotCandidateUrl(value, pageUrl);
    if (!candidateUrl) {
      return;
    }
    const score = scoreImageCandidate(candidateUrl, context, baseScore);
    if (score >= 75) {
      candidates.push({ url: candidateUrl, score });
    }
  };

  for (const tag of html.matchAll(/<meta\s+([^>]+)>/gim)) {
    const attrs = parseHtmlAttributes(tag[1] ?? "");
    const key = `${attrs.property ?? ""} ${attrs.name ?? ""}`.toLowerCase();
    if (/\b(?:og:image|twitter:image|image)\b/.test(key)) {
      add(attrs.content, 45, `${key} ${attrs.content ?? ""}`);
    }
  }

  for (const tag of html.matchAll(/<link\s+([^>]+)>/gim)) {
    const attrs = parseHtmlAttributes(tag[1] ?? "");
    const rel = attrs.rel?.toLowerCase() ?? "";
    if (rel.includes("image_src")) {
      add(attrs.href, 45, `${rel} ${attrs.href ?? ""}`);
    }
  }

  for (const tag of html.matchAll(/<(img|source)\s+([^>]+)>/gim)) {
    const tagName = tag[1]?.toLowerCase() ?? "img";
    const attrs = parseHtmlAttributes(tag[2] ?? "");
    const context = Object.entries(attrs)
      .filter(([key]) => key !== "src" && key !== "srcset")
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    for (const key of ["src", "data-src", "data-original", "data-lazy-src", "data-url", "data-full", "data-image"]) {
      add(attrs[key], tagName === "img" ? 55 : 45, context);
    }
    for (const url of parseSrcSet(attrs.srcset)) {
      add(url, tagName === "img" ? 55 : 45, context);
    }
  }

  for (const match of html.matchAll(/https?:\\?\/\\?\/[^"'<>\\\s]+?\.(?:jpe?g|png|webp|gif)(?:\?[^"'<>\\\s]*)?/gim)) {
    add(match[0], 35, match[0]);
  }

  return dedupeBy(candidates, (candidate) => candidate.url).sort((a, b) => b.score - a.score);
}

function parseHtmlAttributes(value) {
  const attrs = {};
  for (const match of value.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    const key = match[1]?.toLowerCase();
    const rawValue = match[2] ?? match[3] ?? match[4];
    if (key && rawValue !== undefined) {
      attrs[key] = decodeHtml(rawValue);
    }
  }
  return attrs;
}

function parseSrcSet(value) {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function validOriginSnapshotCandidateUrl(value, pageUrl) {
  if (!value) {
    return undefined;
  }
  const normalized = decodeHtml(value).replace(/\\\//g, "/").trim();
  if (!normalized || normalized.startsWith("data:") || normalized.startsWith("blob:")) {
    return undefined;
  }
  const candidate = validRuntimeFetchUrl(absoluteUrl(normalized, pageUrl));
  if (!candidate) {
    return undefined;
  }
  const url = new URL(candidate);
  if (url.hostname === "webcamlive.cz" || url.hostname.endsWith(".webcamlive.cz")) {
    return undefined;
  }
  return url.toString();
}

function scoreImageCandidate(url, context, baseScore) {
  const haystack = `${safeDecodeUri(url)} ${context}`.toLowerCase();
  if (!hasCameraUrlSignal(url)) {
    return 0;
  }
  let score = baseScore;
  if (/\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/i.test(url)) {
    score += 12;
  }
  if (/(webcam|webkamera|kamera|camera|snapshot|snap|mjpg|live|current|aktual|latest|cam\b|kamera_)/i.test(haystack)) {
    score += 45;
  }
  if (/(meteo|weather|ski|sjezdov|lanov|hotel|obec|radnice|namesti|n[aá]m[eě]st[ií]|trail|tourist|turist|koupal|golf)/i.test(haystack)) {
    score += 10;
  }
  if (
    /(logo|favicon|apple-touch-icon|sprite|placeholder|blank|avatar|banner|advert|reklam|facebook|instagram|youtube|mapy|mapbox|google|galerie|gallery|slider|plak[aá]t|poster|aktuality\/20\d{2})/i.test(
      haystack
    )
  ) {
    score -= 80;
  }
  return score;
}

function hasCameraUrlSignal(value) {
  const decoded = safeDecodeUri(value).toLowerCase();
  if (isRejectedCameraImageUrl(decoded)) {
    return false;
  }
  if (
    /(?:webcam|webkamera|kamera|camera|snapshot|snap|mjpg|livecam|current|latest|axis-cgi|image\.cgi|video\.mjpg|last_photo|now\.jpe?g|getimage\.php|aktualni_thumb)/i.test(
      decoded
    )
  ) {
    return true;
  }
  return /20\d{6}[_-]\d{6}[^/]*\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(decoded);
}

function isRejectedCameraImageUrl(value) {
  return /(?:\/o\/adaptive-media\/image\/|\/documents\/42501\/503062\/webkamera|stocksnap|perex\.jpe?g|webcam[_-]?icon|offer_camera|televize\.png|system_preview|second-menu-webcam|aktualni-(?:informace|otviraci)|akt_prx|ikona|icon|menu|\/wp-content\/uploads\/20\d{2}\/\d{2}\/img_|\/icons?\/|\/modules\/[^?#]*\/img\/webcam\.svg|\.svg(?:[?#]|$)|\/gallery\/|\/galerie\/|\/slider\/|\/aktuality\/20\d{2})/i.test(
    value
  );
}

function validSnapshotContentType(value) {
  return new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]).has(value);
}

function validRuntimeFetchUrl(value) {
  if (!value) {
    return undefined;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password) {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return undefined;
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return undefined;
  }
  const ipVersion = isIP(hostname);
  if (ipVersion === 4 && isBlockedIpv4(hostname)) {
    return undefined;
  }
  if (ipVersion === 6 && isBlockedIpv6(hostname)) {
    return undefined;
  }
  return url.toString();
}

function assertRuntimeFetchUrl(value) {
  const safe = validRuntimeFetchUrl(value);
  if (!safe) {
    throw new Error(`URL is not allowed for camera fetch.`);
  }
  return safe;
}

function isBlockedIpv4(value) {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [first, second, third] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function isBlockedIpv6(value) {
  const compact = value.toLowerCase();
  return (
    compact === "::" ||
    compact === "::1" ||
    compact.startsWith("0:0:0:0:0:0:0:") ||
    compact.startsWith("fc") ||
    compact.startsWith("fd") ||
    /^fe[89ab]/.test(compact)
  );
}

function absoluteUrl(value, base) {
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

function imageContentType(body) {
  if (body.length >= 6 && body.toString("ascii", 0, 3) === "GIF") {
    return "image/gif";
  }
  if (body.length >= 8 && body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) {
    return "image/png";
  }
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    return "image/jpeg";
  }
  if (body.length >= 12 && body.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return "application/octet-stream";
}

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function safeDecodeUri(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function dedupeBy(items, keyFor) {
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}
