import { XMLParser } from "fast-xml-parser";
import type { TakAffiliation, TakCotEvent, TakLayerId } from "./types.js";

export interface CotParseResult {
  events: TakCotEvent[];
  warnings: string[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "#text",
  trimValues: true,
  parseAttributeValue: false,
  parseTagValue: false,
  allowBooleanAttributes: true,
  preserveOrder: false
});

export function parseCotXml(xml: string, receivedAt = new Date()): CotParseResult {
  if (!xml.trim()) {
    return { events: [], warnings: ["Empty CoT payload."] };
  }

  const parsedPayload = parsePayload(xml);
  if (!parsedPayload.ok) {
    return { events: [], warnings: [parsedPayload.error] };
  }

  const rawEvents = parsedPayload.events;
  const warnings: string[] = [];
  const events: TakCotEvent[] = [];

  for (const [index, rawEvent] of rawEvents.entries()) {
    const event = normalizeEvent(rawEvent, receivedAt.toISOString());
    if (event.ok) {
      events.push(event.value);
    } else {
      warnings.push(`event[${index}]: ${event.error}`);
    }
  }

  if (rawEvents.length === 0) {
    warnings.push("No <event> nodes found in CoT payload.");
  }

  return { events, warnings };
}

function parsePayload(xml: string): { ok: true; events: unknown[] } | { ok: false; error: string } {
  try {
    return { ok: true, events: findEventNodes(parser.parse(xml)) };
  } catch (error) {
    const eventBlocks = xml.match(/<event\b[\s\S]*?<\/event>/gi) ?? [];
    if (eventBlocks.length > 1) {
      const events: unknown[] = [];
      for (const block of eventBlocks) {
        const parsed = parser.parse(block);
        events.push(...findEventNodes(parsed));
      }
      return { ok: true, events };
    }
    const message = error instanceof Error ? error.message : "Unknown XML parser error.";
    return { ok: false, error: `Invalid CoT XML: ${message}` };
  }
}

export function inferAffiliation(type: string): TakAffiliation {
  if (type.startsWith("a-f-")) {
    return "friend";
  }
  if (type.startsWith("a-h-")) {
    return "hostile";
  }
  if (type.startsWith("a-n-")) {
    return "neutral";
  }
  return "unknown";
}

export function inferLayer(event: TakCotEvent): TakLayerId {
  const normalizedType = event.type.toLowerCase();
  const groupRole = event.group?.role?.toLowerCase() ?? "";
  if (normalizedType.includes("-a-") || normalizedType.endsWith("-a") || normalizedType.includes("air")) {
    return "traffic";
  }
  if (event.track?.speed !== undefined || groupRole.includes("team") || groupRole.includes("member")) {
    return "mobile";
  }
  if (normalizedType.includes("-g-") || event.group?.name || event.contact?.callsign) {
    return "mobile";
  }
  return "ground";
}

function findEventNodes(value: unknown): unknown[] {
  if (isRecord(value)) {
    const direct = value.event;
    if (direct) {
      return asArray(direct);
    }
    const cot = value.cot;
    if (isRecord(cot) && cot.event) {
      return asArray(cot.event);
    }
    const events = value.events;
    if (isRecord(events) && events.event) {
      return asArray(events.event);
    }
  }
  return [];
}

function normalizeEvent(raw: unknown, receivedAt: string): { ok: true; value: TakCotEvent } | { ok: false; error: string } {
  if (!isRecord(raw)) {
    return { ok: false, error: "event is not an object." };
  }

  const uid = asString(raw.uid);
  const type = asString(raw.type);
  if (!uid) {
    return { ok: false, error: "missing uid." };
  }
  if (!type) {
    return { ok: false, error: "missing type." };
  }

  const point = isRecord(raw.point) ? raw.point : undefined;
  const lat = parseNumber(point?.lat);
  const lon = parseNumber(point?.lon);
  if (lat === undefined || lon === undefined || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return { ok: false, error: "missing or invalid point lat/lon." };
  }

  const detail = isRecord(raw.detail) ? raw.detail : undefined;
  const contact = isRecord(detail?.contact) ? detail.contact : undefined;
  const group = getGroup(detail);
  const track = isRecord(detail?.track) ? detail.track : undefined;
  const remarks = detail?.remarks;

  return {
    ok: true,
    value: {
      uid,
      type,
      how: asString(raw.how),
      time: normalizeDate(asString(raw.time)),
      start: normalizeDate(asString(raw.start)),
      stale: normalizeDate(asString(raw.stale)),
      receivedAt,
      point: {
        lat,
        lon,
        hae: parseNumber(point?.hae),
        ce: parseNumber(point?.ce),
        le: parseNumber(point?.le)
      },
      contact: contact
        ? {
            callsign: asString(contact.callsign),
            endpoint: asString(contact.endpoint)
          }
        : undefined,
      group: group
        ? {
            name: asString(group.name),
            role: asString(group.role)
          }
        : undefined,
      track: track
        ? {
            course: parseNumber(track.course),
            speed: parseNumber(track.speed)
          }
        : undefined,
      remarks: normalizeRemarks(remarks),
      raw
    }
  };
}

function getGroup(detail: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const group = detail?.__group ?? detail?.group;
  return isRecord(group) ? group : undefined;
}

function normalizeRemarks(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value)) {
    return asString(value["#text"]);
  }
  return undefined;
}

function normalizeDate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
