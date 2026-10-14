/**
 * Protocol-independent OFFLINE FIXTURE JSON mechanics only.
 * Parsing or canonical bytes do not validate a protocol DTO, identity, registry,
 * admission, outcome or production authority. No transport or application wiring.
 */
import { types } from "node:util";

export type FixtureJsonErrorCode = "INVALID_PACKET" | "INVALID_UTF8" | "BOM_NOT_ALLOWED" |
  "INVALID_JSON" | "DUPLICATE_KEY" | "FLOAT_TOKEN" | "UNSAFE_INTEGER" |
  "STRUCTURE_LIMIT" | "ARRAY_LIMIT" | "KEY_LIMIT" | "STRING_LIMIT" |
  "UNPAIRED_SURROGATE" | "NON_ASCII" | "INVALID_CANONICAL_VALUE";

/** Fixed codes only: never retain or interpolate the supplied packet/value. */
export class FixtureJsonError extends Error {
  constructor(readonly code: FixtureJsonErrorCode) {
    super(code);
    this.name = "FixtureJsonError";
  }
}

const MAX_BYTES = 16_384, MAX_DEPTH = 12, MAX_NODES = 256;
const MAX_ARRAY = 32, MAX_KEY = 64, MAX_STRING = 256;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), "byteLength",
)!.get!;

function need(condition: unknown, code: FixtureJsonErrorCode): asserts condition {
  if (!condition) throw new FixtureJsonError(code);
}

function stringBound(value: string, maximum: number, code: FixtureJsonErrorCode): void {
  let length = 0;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      need(next >= 0xdc00 && next <= 0xdfff, "UNPAIRED_SURROGATE");
    } else need(unit < 0xdc00 || unit > 0xdfff, "UNPAIRED_SURROGATE");
    need(++length <= maximum, code);
  }
}

/** Lexical restrictions run before JSON.parse can erase floats or duplicate keys. */
export function parseStrictFixturePacket(bytes: Uint8Array): unknown {
  need(!types.isProxy(bytes) && types.isUint8Array(bytes), "INVALID_PACKET");
  const size = typedArrayByteLength.call(bytes) as number;
  need(size > 0 && size <= MAX_BYTES, "INVALID_PACKET");
  const snapshot = new Uint8Array(size);
  Uint8Array.prototype.set.call(snapshot, bytes);
  need(!(snapshot[0] === 0xef && snapshot[1] === 0xbb && snapshot[2] === 0xbf), "BOM_NOT_ALLOWED");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(snapshot); }
  catch { throw new FixtureJsonError("INVALID_UTF8"); }
  let at = 0, nodes = 0;
  const whitespace = (): void => {
    while (at < text.length && /[\x20\x09\x0a\x0d]/u.test(text[at]!)) at++;
  };
  function string(maximum: number, code: FixtureJsonErrorCode): string {
    need(text[at] === '"', "INVALID_JSON");
    const start = at++;
    while (at < text.length) {
      const ch = text[at++]!;
      if (ch === '"') {
        let result: string;
        try { result = JSON.parse(text.slice(start, at)) as string; }
        catch { throw new FixtureJsonError("INVALID_JSON"); }
        stringBound(result, maximum, code);
        return result;
      }
      need(ch.charCodeAt(0) >= 0x20, "INVALID_JSON");
      if (ch === "\\") {
        need(at < text.length, "INVALID_JSON");
        const escaped = text[at++]!;
        if (escaped === "u") {
          need(/^[a-fA-F0-9]{4}$/u.test(text.slice(at, at + 4)), "INVALID_JSON");
          at += 4;
        } else need('"\\/bfnrt'.includes(escaped), "INVALID_JSON");
      }
    }
    throw new FixtureJsonError("INVALID_JSON");
  }
  function value(depth: number): unknown {
    need(depth <= MAX_DEPTH && ++nodes <= MAX_NODES, "STRUCTURE_LIMIT");
    whitespace();
    const ch = text[at];
    if (ch === '"') return string(MAX_STRING, "STRING_LIMIT");
    if (ch === "{") {
      at++; whitespace();
      const result = Object.create(null) as Record<string, unknown>, seen = new Set<string>();
      if (text[at] === "}") { at++; return result; }
      while (at < text.length) {
        whitespace();
        const key = string(MAX_KEY, "KEY_LIMIT");
        need(!seen.has(key), "DUPLICATE_KEY"); seen.add(key);
        whitespace(); need(text[at++] === ":", "INVALID_JSON");
        result[key] = value(depth + 1);
        whitespace();
        const end = text[at++];
        if (end === "}") return result;
        need(end === ",", "INVALID_JSON");
      }
      throw new FixtureJsonError("INVALID_JSON");
    }
    if (ch === "[") {
      at++; whitespace();
      const result: unknown[] = [];
      if (text[at] === "]") { at++; return result; }
      while (at < text.length) {
        need(result.length < MAX_ARRAY, "ARRAY_LIMIT");
        result.push(value(depth + 1)); whitespace();
        const end = text[at++];
        if (end === "]") return result;
        need(end === ",", "INVALID_JSON");
      }
      throw new FixtureJsonError("INVALID_JSON");
    }
    for (const [literal, parsed] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(literal, at)) { at += literal.length; return parsed; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)/u.exec(text.slice(at));
    need(number, "INVALID_JSON"); at += number[0].length;
    need(!/[.eE]/u.test(text[at] ?? ""), "FLOAT_TOKEN");
    const integer = BigInt(number[0]);
    need(integer >= -BigInt(Number.MAX_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER), "UNSAFE_INTEGER");
    return Number(integer);
  }
  const result = value(0); whitespace(); need(at === text.length, "INVALID_JSON");
  return result;
}

/** Python ensure_ascii-compatible quoting of ASCII DTO strings, including DEL. */
function asciiQuote(value: string): string {
  let result = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    need(code <= 0x7f, "NON_ASCII");
    switch (code) {
      case 0x22: result += '\\"'; break;
      case 0x5c: result += "\\\\"; break;
      case 0x08: result += "\\b"; break;
      case 0x0c: result += "\\f"; break;
      case 0x0a: result += "\\n"; break;
      case 0x0d: result += "\\r"; break;
      case 0x09: result += "\\t"; break;
      default: result += code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, "0")}` : value[i]!;
    }
  }
  return result + '"';
}

/**
 * Canonicalize a caller-validated ASCII fixture DTO, NOT arbitrary Unicode JCS.
 * This only checks safe JSON mechanics; the caller still owes exact DTO schema
 * and cross-field validation. No getter/toJSON/iterator or proxy trap is invoked.
 */
export function canonicalAsciiFixtureBytes(validatedDTO: unknown): Uint8Array {
  let nodes = 0;
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): string {
    need(depth <= MAX_DEPTH && ++nodes <= MAX_NODES, "STRUCTURE_LIMIT");
    if (value === null) return "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") {
      need(Number.isSafeInteger(value), "UNSAFE_INTEGER");
      return String(Object.is(value, -0) ? 0 : value);
    }
    if (typeof value === "string") {
      stringBound(value, MAX_STRING, "STRING_LIMIT"); return asciiQuote(value);
    }
    need(typeof value === "object" && !types.isProxy(value), "INVALID_CANONICAL_VALUE");
    need(!ancestors.has(value), "INVALID_CANONICAL_VALUE");
    const prototype = Object.getPrototypeOf(value);
    const array = Array.isArray(value);
    need(array ? prototype === Array.prototype : prototype === null || prototype === Object.prototype, "INVALID_CANONICAL_VALUE");
    const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
    need(keys.every(key => typeof key === "string"), "INVALID_CANONICAL_VALUE");
    ancestors.add(value);
    try {
      if (array) {
        const length = descriptors.length;
        need(length && "value" in length && Number.isSafeInteger(length.value) && length.value >= 0 && length.value <= MAX_ARRAY, "ARRAY_LIMIT");
        need(keys.length === length.value + 1, "INVALID_CANONICAL_VALUE");
        const parts: string[] = [];
        for (let i = 0; i < length.value; i++) {
          const item = descriptors[String(i)];
          need(item && "value" in item && item.enumerable, "INVALID_CANONICAL_VALUE");
          parts.push(visit(item.value, depth + 1));
        }
        return `[${parts.join(",")}]`;
      }
      const parts: string[] = [];
      for (const key of (keys as string[]).sort()) {
        stringBound(key, MAX_KEY, "KEY_LIMIT");
        const item = descriptors[key];
        need(item && "value" in item && item.enumerable, "INVALID_CANONICAL_VALUE");
        parts.push(`${asciiQuote(key)}:${visit(item.value, depth + 1)}`);
      }
      return `{${parts.join(",")}}`;
    } finally { ancestors.delete(value); }
  }
  const bytes = new TextEncoder().encode(visit(validatedDTO, 0));
  need(bytes.byteLength > 0 && bytes.byteLength <= MAX_BYTES, "INVALID_PACKET");
  return bytes;
}
