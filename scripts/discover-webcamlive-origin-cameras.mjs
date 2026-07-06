#!/usr/bin/env node

import { writeFile } from "node:fs/promises";

const DEFAULT_ROOT_URL = "https://www.webcamlive.cz/cs/webkamery/ceska-republika/2";
const WEBCAMLIVE_HOST = "www.webcamlive.cz";
const IGNORED_EXTERNAL_HOSTS = new Set([
  "pagead2.googlesyndication.com",
  "toplist.cz",
  "www.q-comp.cz",
  "www.bjsw.cz",
  "www.yr.no",
  "vjs.zencdn.net"
]);

const args = parseArgs(process.argv.slice(2));
const rootUrl = args.rootUrl ?? DEFAULT_ROOT_URL;
const requestedRegionUrls = args.regionUrls.length > 0 ? args.regionUrls : [rootUrl];
const maxRegions = args.maxRegions ?? 20;
const detailLimit = args.detailLimit ?? 50;
const crawlRegions = args.crawlRegions;

const rootHtml = await fetchText(rootUrl);
const regionLinks = dedupeBy(
  extractRegionLinks(rootHtml).filter((item) => item.href.includes("/cs/webkamery/")),
  (item) => item.href
);
const regionUrls = crawlRegions ? regionLinks.slice(0, maxRegions).map((item) => item.href) : requestedRegionUrls;

const regionReports = [];
const candidates = new Map();
for (const regionUrl of regionUrls) {
  const html = regionUrl === rootUrl ? rootHtml : await fetchText(regionUrl);
  const regionName = extractRegionName(html) ?? regionLinks.find((item) => item.href === regionUrl)?.label ?? regionUrl;
  const regionCandidates = extractCameraCandidates(html, regionUrl, regionName);
  regionReports.push({
    regionUrl,
    regionName,
    cameraCount: regionCandidates.length,
    cameraIds: regionCandidates.map((item) => item.webcamliveCameraId).filter(Boolean)
  });
  for (const candidate of regionCandidates) {
    const key = candidate.webcamliveCameraId ?? candidate.webcamliveUrl;
    candidates.set(key, { ...candidates.get(key), ...candidate });
  }
}

const detailCandidates = [...candidates.values()].slice(0, detailLimit);
for (const candidate of detailCandidates) {
  if (!candidate.webcamliveUrl) {
    continue;
  }
  try {
    const detailHtml = await fetchText(candidate.webcamliveUrl);
    Object.assign(candidate, extractDetailSignals(detailHtml));
  } catch (error) {
    candidate.auditWarnings = [`detail fetch failed: ${error instanceof Error ? error.message : String(error)}`];
  }
}

const auditedCandidates = [...candidates.values()].map(classifyCandidate).sort((a, b) =>
  String(a.webcamliveCameraId ?? a.webcamliveUrl).localeCompare(String(b.webcamliveCameraId ?? b.webcamliveUrl))
);

const report = {
  generatedAt: new Date().toISOString(),
  discoverySource: rootUrl,
  mode: {
    crawlRegions,
    maxRegions,
    detailLimit
  },
  policy: {
    runtimeSourceAllowed: false,
    note:
      "WebCamLive is treated as a discovery aid only. SIM production camera feeds must use verified origin URLs, attribution and permission in PUBLIC_CAMERA_FEEDS kind=static_json."
  },
  regionPagesDiscovered: regionLinks.length,
  regionsAudited: regionReports,
  candidateCount: auditedCandidates.length,
  candidates: auditedCandidates,
  curatedStaticFeedTemplate: {
    sourceId: "webcamlive_origin_review",
    label: "Verified origin webcams from WebCamLive audit",
    authority: "REPLACE_WITH_ORIGIN_AUTHORITY",
    attribution: "REPLACE_WITH_REQUIRED_ATTRIBUTION",
    providerPageUrl: "https://www.webcamlive.cz/",
    category: "city",
    locations: auditedCandidates
      .filter((item) => item.status === "origin_review_candidate")
      .map((item) => ({
        locationId: item.suggestedLocationId,
        label: item.label,
        lon: item.lon,
        lat: item.lat,
        providerPageUrl: item.originPageCandidates[0]?.href,
        sourceDataUrl: item.originPageCandidates[0]?.href,
        cameras: [
          {
            cameraId: item.suggestedCameraId,
            name: item.cameraName ?? item.label,
            providerUrl: item.originPageCandidates[0]?.href,
            directImageUrl: "REPLACE_WITH_ORIGIN_IMAGE_OR_STREAM_URL",
            snapshotAvailable: false
          }
        ]
      }))
  }
};

const output = `${JSON.stringify(report, null, 2)}\n`;
if (args.output) {
  await writeFile(args.output, output, "utf8");
} else {
  process.stdout.write(output);
}

function parseArgs(argv) {
  const parsed = {
    regionUrls: [],
    crawlRegions: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--root-url") {
      parsed.rootUrl = argv[++index];
    } else if (value === "--region-url") {
      parsed.regionUrls.push(argv[++index]);
    } else if (value === "--crawl-regions") {
      parsed.crawlRegions = true;
    } else if (value === "--max-regions") {
      parsed.maxRegions = Number(argv[++index]);
    } else if (value === "--detail-limit") {
      parsed.detailLimit = Number(argv[++index]);
    } else if (value === "--output") {
      parsed.output = argv[++index];
    } else if (value === "--help" || value === "-h") {
      printHelpAndExit();
    }
  }
  return parsed;
}

function printHelpAndExit() {
  process.stdout.write(`Usage:
  node scripts/discover-webcamlive-origin-cameras.mjs [options]

Options:
  --root-url URL       WebCamLive root page to inspect. Defaults to Czech Republic.
  --region-url URL     Region page to audit. Can be repeated.
  --crawl-regions      Crawl region links discovered from the root page.
  --max-regions N      Maximum discovered regions to crawl when --crawl-regions is used. Default 20.
  --detail-limit N     Maximum camera detail pages to inspect for origin links. Default 50.
  --output FILE        Write JSON report to FILE instead of stdout.
`);
  process.exit(0);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,*/*",
      "user-agent": "csm-sim-webcamlive-origin-discovery/0.1"
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  return await response.text();
}

function extractRegionLinks(html) {
  const links = [];
  const pattern = /<a\s+href=["'](https:\/\/www\.webcamlive\.cz\/cs\/webkamery\/[^"']+)["'][^>]*>(.*?)<\/a>/gims;
  let match;
  while ((match = pattern.exec(html))) {
    links.push({
      href: decodeHtml(match[1]),
      label: plainText(match[2])
    });
  }
  return links;
}

function extractRegionName(html) {
  const match = /<h2[^>]*class=["'][^"']*halfReg[^"']*["'][^>]*>(.*?)<\/h2>/ims.exec(html);
  return match ? plainText(match[1]) : undefined;
}

function extractCameraCandidates(html, regionUrl, regionName) {
  const regionCameraIds = new Set(extractRegionCameraIds(html));
  const markers = extractMarkers(html);
  const candidates = [];
  for (const marker of markers) {
    if (regionCameraIds.size > 0 && !regionCameraIds.has(marker.webcamliveCameraId)) {
      continue;
    }
    candidates.push({
      ...marker,
      regionUrl,
      regionName
    });
  }
  if (candidates.length > 0) {
    return candidates;
  }
  return extractCards(html).map((item) => ({ ...item, regionUrl, regionName }));
}

function extractRegionCameraIds(html) {
  const match = /let\s+RegionArray\s*=\s*\[([^\]]*)\]/m.exec(html);
  if (!match) {
    return [];
  }
  return match[1]
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^\d+$/.test(item));
}

function extractMarkers(html) {
  const markers = [];
  const pattern = /(?:\[|,)\s*(\d+)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*'((?:\\'|[^'])*)'/g;
  let match;
  while ((match = pattern.exec(html))) {
    const [, id, latText, lonText, bubbleRaw] = match;
    const bubble = decodeJsString(bubbleRaw);
    const webcamliveUrl = firstMatch(/href=["'](https:\/\/www\.webcamlive\.cz\/cs\/webkamera\/[^"']+)["']/i, bubble);
    const thumbnailUrl = firstMatch(/<img[^>]+src=["']([^"']+)["']/i, bubble);
    const cameraName = firstMatch(/<span>(.*?)<\/span>/i, bubble);
    const alt = firstMatch(/<img[^>]+alt=["']([^"']*)["']/i, bubble);
    markers.push({
      webcamliveCameraId: id,
      webcamliveUrl: decodeHtml(webcamliveUrl),
      thumbnailUrl: absoluteWebcamliveUrl(decodeHtml(thumbnailUrl)),
      label: plainText(cameraName) || plainText(alt) || `WebCamLive camera ${id}`,
      cameraName: plainText(alt) || plainText(cameraName),
      lat: Number(latText),
      lon: Number(lonText)
    });
  }
  return dedupeBy(markers, (item) => item.webcamliveCameraId);
}

function extractCards(html) {
  const cards = [];
  const pattern = /<a\s+class=["']block["']\s+href=["'](https:\/\/www\.webcamlive\.cz\/cs\/webkamera\/[^"']+)["']>\s*<img\s+src=["']([^"']+)["']\s+alt=["']([^"']*)["'][\s\S]*?<h3>\s*<a[^>]*>(.*?)<\/a>\s*<\/h3>/gims;
  let match;
  while ((match = pattern.exec(html))) {
    const [, href, thumbnailUrl, alt, label] = match;
    const id = href.split("/").filter(Boolean).pop();
    cards.push({
      webcamliveCameraId: id,
      webcamliveUrl: decodeHtml(href),
      thumbnailUrl: absoluteWebcamliveUrl(decodeHtml(thumbnailUrl)),
      label: plainText(label) || plainText(alt) || `WebCamLive camera ${id}`,
      cameraName: plainText(alt)
    });
  }
  return dedupeBy(cards, (item) => item.webcamliveCameraId ?? item.webcamliveUrl);
}

function extractDetailSignals(html) {
  const sourceLinks = [];
  const sourcePattern = /Zdroj:\s*<a\s+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gims;
  let sourceMatch;
  while ((sourceMatch = sourcePattern.exec(html))) {
    sourceLinks.push({
      href: decodeHtml(sourceMatch[1]),
      label: plainText(sourceMatch[2])
    });
  }

  const externalLinks = extractLinks(html)
    .filter((item) => item.href.startsWith("http://") || item.href.startsWith("https://"))
    .filter((item) => {
      const host = hostOf(item.href);
      return host && host !== WEBCAMLIVE_HOST && !IGNORED_EXTERNAL_HOSTS.has(host);
    });

  const currentImageUrl = firstMatch(/<img[^>]+class=["'][^"']*currentimage[^"']*["'][^>]+src=["']([^"']+)["']/i, html);
  const embedImageUrl = firstMatch(/src=&quot;(https:\/\/www\.webcamlive\.cz\/camera_image\.php\?idCamera=\d+)&quot;/i, html);
  const title = firstMatch(/<h2[^>]*class=["'][^"']*regionName[^"']*["'][^>]*>(.*?)<\/h2>/ims, html);
  return {
    detailTitle: plainText(title),
    webcamliveSnapshotUrl: absoluteWebcamliveUrl(decodeHtml(currentImageUrl)),
    webcamliveEmbedSnapshotUrl: decodeHtml(embedImageUrl),
    originPageCandidates: dedupeBy([...sourceLinks, ...externalLinks], (item) => item.href)
  };
}

function extractLinks(html) {
  const links = [];
  const pattern = /<a\s+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gims;
  let match;
  while ((match = pattern.exec(html))) {
    links.push({
      href: decodeHtml(match[1]),
      label: plainText(match[2])
    });
  }
  return links;
}

function classifyCandidate(candidate) {
  const originPageCandidates = candidate.originPageCandidates ?? [];
  const status = originPageCandidates.length > 0 ? "origin_review_candidate" : "webcamlive_proxy_only";
  return {
    ...candidate,
    suggestedLocationId: stableId(
      `${candidate.regionName ?? "webcamlive"}_${candidate.label ?? candidate.webcamliveCameraId ?? "camera"}_${candidate.webcamliveCameraId ?? ""}`
    ),
    suggestedCameraId: stableId(`${candidate.webcamliveCameraId ?? candidate.cameraName ?? "camera"}`),
    originPageCandidates,
    status,
    recommendation:
      status === "origin_review_candidate"
        ? "Verify permission and find direct origin image/stream URL before adding to PUBLIC_CAMERA_FEEDS kind=static_json."
        : "Do not add directly. WebCamLive currently exposes only aggregator-hosted image URLs for this candidate."
  };
}

function firstMatch(pattern, value) {
  const match = pattern.exec(value);
  return match?.[1];
}

function absoluteWebcamliveUrl(value) {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value, "https://www.webcamlive.cz/").toString();
  } catch {
    return value;
  }
}

function hostOf(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

function decodeJsString(value) {
  return value.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function decodeHtml(value) {
  if (!value) {
    return undefined;
  }
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function plainText(value) {
  if (!value) {
    return undefined;
  }
  const text = decodeHtml(value)
    ?.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text && text.length > 0 ? text : undefined;
}

function stableId(value) {
  const normalized = value.trim().replace(/[^A-Za-z0-9_.:-]/g, "_").replace(/_+/g, "_").slice(0, 96);
  return normalized.length > 0 ? normalized : "camera";
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}
