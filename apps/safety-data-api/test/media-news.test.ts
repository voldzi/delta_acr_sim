import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MEDIA_NEWS_FEEDS,
  MEDIA_NEWS_MAX_RESPONSE_BYTES,
  MediaNewsQueryError,
  MediaNewsService,
  parseMediaNewsQuery,
  type MediaNewsFeedId
} from "../src/media-news.js";

const NOW = Date.parse("2026-10-10T12:00:00Z");

interface RssEntry {
  title?: string;
  link?: string;
  pubDate?: string;
  extra?: string;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function rss(entries: RssEntry[] = [{}]): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>ČT24</title>${entries.map((entry, index) => `<item><title>${escapeXml(entry.title ?? "Požár v Ostravě, hasiči evakuují obyvatele")}</title><link>${escapeXml(entry.link ?? `https://ct24.ceskatelevize.cz/clanek/domaci/pozar-${index}`)}</link><pubDate>${escapeXml(entry.pubDate ?? new Date(NOW - 60_000).toUTCString())}</pubDate><description>FULL ARTICLE MUST NEVER LEAVE THE SOURCE PARSER</description>${entry.extra ?? ""}</item>`).join("")}</channel></rss>`;
}

function response(xml: string = rss(), headers: HeadersInit = {}): Response {
  return new Response(xml, { headers: { "content-type": "application/rss+xml; charset=utf-8", ...headers } });
}

function service(fetcher = vi.fn<typeof fetch>(async () => response()), clock = () => NOW) {
  return { news: new MediaNewsService({ enabled: true, requestTimeoutMs: 1000 }, { fetch: fetcher, now: clock }), fetcher };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ČT24 media query validation", () => {
  it("supports only allowlisted feeds and a bounded limit, deduplicating feed IDs", () => {
    expect(parseMediaNewsQuery({})).toEqual({});
    expect(parseMediaNewsQuery({ feeds: "ct24-brno, ct24-main,ct24-brno", limit: "100" })).toEqual({ feeds: ["ct24-brno", "ct24-main"], limit: 100 });
  });

  it.each([
    { feeds: "http://localhost/internal" },
    { feeds: "ct24-main,unknown" },
    { feeds: "" },
    { feeds: [] },
    { feeds: "ct24-main," },
    { feeds: { feed: "ct24-main" } },
    { limit: "0" },
    { limit: "101" },
    { limit: "1.5" },
    { limit: "-1" },
    { limit: "1e2" },
    { limit: "01" },
    { limit: 50 },
    { limit: ["10"] },
    { bbox: "14,49,15,50" },
    { feedUrl: MEDIA_NEWS_FEEDS[0]!.url }
  ])("rejects unsafe or ambiguous query %j", (query) => {
    expect(() => parseMediaNewsQuery(query)).toThrow(MediaNewsQueryError);
  });

  it("validates direct service calls before any network access", async () => {
    const { news, fetcher } = service();
    await expect(news.query({ feeds: ["not-allowed" as MediaNewsFeedId] })).rejects.toThrow(MediaNewsQueryError);
    await expect(news.query({ feeds: [] })).rejects.toThrow(MediaNewsQueryError);
    await expect(news.query({ limit: 101 })).rejects.toThrow(MediaNewsQueryError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("ČT24 informational metadata boundary", () => {
  it("returns disabled source states without fetching when disabled", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const news = new MediaNewsService({ enabled: false }, { fetch: fetcher, now: () => NOW });
    const result = await news.query();
    expect(result).toMatchObject({
      contractVersion: "sim-crisis-media-context-v1",
      status: "disabled",
      informationalOnly: true,
      notificationEligible: false,
      items: []
    });
    expect(result.sources).toHaveLength(3);
    expect(result.sources.every((source) => source.status === "disabled" && source.fetchedAt === null && !source.stale && source.errorCode === null)).toBe(
      true
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never infers an incident coordinate or event time from a regional RSS feed", async () => {
    const { news, fetcher } = service(
      vi.fn<typeof fetch>(async () => response(rss([{ extra: "<georss:point>49.2 16.6</georss:point><enclosure url='https://example.org/image.jpg'/>" }])))
    );
    const result = await news.query({ feeds: ["ct24-brno"] });
    expect(result.status).toBe("ok");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      title: "Požár v Ostravě, hasiči evakuují obyvatele",
      eventAt: null,
      location: null,
      locationStatus: "unresolved",
      regionCode: "CZ064",
      regionScope: "feed",
      informationalOnly: true,
      notificationEligible: false,
      publishedAt: "2026-10-10T11:59:00.000Z",
      fetchedAt: "2026-10-10T12:00:00.000Z",
      source: { id: "ct24", name: "ČT24", feedId: "ct24-brno", attribution: "Česká televize / ČT24" }
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/FULL ARTICLE|image\.jpg|geometry|coordinates|49\.2|16\.6/);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(MEDIA_NEWS_FEEDS[2]!.url, expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
  });

  it("does not fetch article links and sanitizes nested markup, entities and unsafe controls", async () => {
    const { news, fetcher } = service(
      vi.fn<typeof fetch>(async () =>
        response(
          rss([
            {
              title: "<script>secret()</script><b>Požár</b> &amp; &quot;evakuace&quot; &#x2013; město\u202e",
              link: "https://ct24.ceskatelevize.cz/clanek/domaci/pozar?utm_source=test&keep=1#video"
            }
          ])
        )
      )
    );
    const result = await news.query({ feeds: ["ct24-main"] });
    expect(result.items[0]!.title).toBe('Požár & "evakuace" – město');
    expect(result.items[0]!.link).toBe("https://ct24.ceskatelevize.cz/clanek/domaci/pozar?keep=1");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "//ct24.ceskatelevize.cz/clanek",
    "https://evil.example/clanek",
    "https://ct24.ceskatelevize.cz.evil.example/clanek",
    "https://ct24.ceskatelevize.cz@evil.example/clanek",
    "https://evil@ct24.ceskatelevize.cz/clanek",
    "https://ct24.ceskatelevize.cz:444/clanek",
    "https://ct24.ceskatelevize.cz\\@evil.example/clanek",
    "https://ct24.ceskatelevize.cz/clan\nek"
  ])("rejects malicious article link %s", async (link) => {
    const { news } = service(vi.fn<typeof fetch>(async () => response(rss([{ link }]))));
    expect((await news.query({ feeds: ["ct24-main"] })).items).toEqual([]);
  });

  it("rejects legacy HTTP article links even on the allowlisted host", async () => {
    const { news } = service(vi.fn<typeof fetch>(async () => response(rss([{ link: "http://ct24.ceskatelevize.cz/clanek/domaci/pozar" }]))));
    expect((await news.query({ feeds: ["ct24-main"] })).items).toEqual([]);
  });

  it("bounds stored headlines and exposed items, orders by publication time and deduplicates across feeds", async () => {
    const entries = Array.from({ length: 120 }, (_, index) => ({
      title: `Požár ${"x".repeat(400)}`,
      link: `https://ct24.ceskatelevize.cz/clanek/${index}`,
      pubDate: new Date(NOW - index * 1000).toUTCString()
    }));
    const { news, fetcher } = service(vi.fn<typeof fetch>(async () => response(rss(entries))));
    const result = await news.query({ limit: 100 });
    expect(result.items).toHaveLength(100);
    expect(result.items.every((item) => item.title.length <= 300)).toBe(true);
    expect(new Set(result.items.map((item) => item.id)).size).toBe(100);
    expect(result.items[0]!.publishedAt).toBe(new Date(NOW).toISOString());
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect((await news.query({ limit: 2 })).items).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("deduplicates repeated entries and canonical tracking variants within a feed", async () => {
    const { news } = service(
      vi.fn<typeof fetch>(async () =>
        response(
          rss([
            { link: "https://ct24.ceskatelevize.cz/clanek/pozar?utm_medium=rss" },
            { link: "https://ct24.ceskatelevize.cz/clanek/pozar?fbclid=abc#top" },
            { link: "https://ct24.ceskatelevize.cz/clanek/pozar" }
          ])
        )
      )
    );
    expect((await news.query({ feeds: ["ct24-main"] })).items).toHaveLength(1);
  });

  it("clones returned metadata so downstream changes cannot modify the cached copy", async () => {
    const { news } = service();
    const first = await news.query({ feeds: ["ct24-main"] });
    first.items[0]!.title = "mutated";
    first.items[0]!.source.attribution = "mutated" as "Česká televize / ČT24";
    const second = await news.query({ feeds: ["ct24-main"] });
    expect(second.items[0]!.title).not.toBe("mutated");
    expect(second.items[0]!.source.attribution).toBe("Česká televize / ČT24");
  });
});

describe("ČT24 conservative current-headline filtering", () => {
  it("keeps current crisis context and omits general, international, retrospective and exercise news", async () => {
    const accepted = [
      "Požár továrny v Ostravě",
      "Povodně zasáhly Opavu",
      "Evakuace domů v Brně pokračuje",
      "Uzavřená dálnice D1 kvůli havárii",
      "Železniční trať zůstává uzavřená",
      "Výpadek elektřiny zasáhl Bruntál",
      "Obyvatelé jsou bez pitné vody",
      "Únik plynu vyžádal evakuaci",
      "ČHMÚ vydal výstrahu před silným větrem",
      "Sesuv půdy uzavřel silnici"
    ];
    const rejected = [
      "Výročí povodní připomíná výstava",
      "Letošní cvičení hasičů simuluje požár",
      "Požár v Kalifornii ničí domy",
      "Povodně zasáhly Slovensko",
      "Retrospektiva povodní před rokem",
      "Loni povodeň zaplavila město",
      "Divadlo bude uzavřeno kvůli opravě",
      "Nové muzeum vystavuje hasičské vozy",
      "Volby změnily vedení města",
      "Francouzský požár zničil sklad",
      "Nácvik evakuace skončil úspěšně",
      "Požár před osmi lety zničil celé město",
      "Požár v Londýně zničil obchod",
      "Povodně v Kanadě evakuovaly město"
    ];
    const { news } = service(vi.fn<typeof fetch>(async () => response(rss([...accepted, ...rejected].map((title) => ({ title }))))));
    const result = await news.query({ feeds: ["ct24-main"] });
    expect(result.items.map((item) => item.title).sort()).toEqual(accepted.sort());
  });

  it("rejects expired, future, missing, invalid and timezone-ambiguous publication times", async () => {
    const dates = [
      new Date(NOW - 24 * 60 * 60 * 1000).toISOString(),
      new Date(NOW - 24 * 60 * 60 * 1000 - 1).toISOString(),
      new Date(NOW + 1).toISOString(),
      "not a date",
      "",
      "2026-10-10",
      "2026-10-10T11:00:00",
      "2026-10-10T10:00:00+02:00"
    ];
    const { news } = service(vi.fn<typeof fetch>(async () => response(rss(dates.map((pubDate) => ({ pubDate }))))));
    const result = await news.query({ feeds: ["ct24-main"] });
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.publishedAt)).toEqual(["2026-10-10T08:00:00.000Z", "2026-10-09T12:00:00.000Z"]);
  });

  it("rejects calendar-overflow dates that JavaScript would roll into the freshness window", async () => {
    const now = Date.parse("2026-03-02T12:00:00Z");
    const { news } = service(
      vi.fn<typeof fetch>(async () => response(rss([{ pubDate: "Mon, 30 Feb 2026 11:00:00 GMT" }, { pubDate: "2026-02-30T11:00:00Z" }]))),
      () => now
    );
    expect((await news.query({ feeds: ["ct24-main"] })).items).toEqual([]);
  });
});

describe("ČT24 bounded shared cache and isolated upstream failures", () => {
  it("coalesces concurrent query permutations into one fetch per feed for five minutes", async () => {
    let now = NOW;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async () => {
      await barrier;
      return response();
    });
    const { news } = service(fetcher, () => now);
    const queries = [
      news.query({ feeds: ["ct24-main"], limit: 1 }),
      news.query({ feeds: ["ct24-main", "ct24-brno"], limit: 2 }),
      news.query({ feeds: ["ct24-main"] })
    ];
    expect(fetcher).toHaveBeenCalledTimes(2);
    release();
    await Promise.all(queries);
    now += 299_999;
    await news.query({ feeds: ["ct24-main", "ct24-brno"], limit: 100 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    now += 1;
    await news.query({ feeds: ["ct24-main"] });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("marks stale fallback explicitly, backs off failures, expires stale metadata and recovers", async () => {
    let now = NOW;
    let failed = false;
    const fetcher = vi.fn<typeof fetch>(async () => (failed ? new Response("unavailable", { status: 503 }) : response()));
    const news = new MediaNewsService({ enabled: true, staleIfErrorSeconds: 600, errorBackoffSeconds: 60 }, { fetch: fetcher, now: () => now });
    await news.query({ feeds: ["ct24-main"] });
    failed = true;
    now += 300_000;
    const stale = await news.query({ feeds: ["ct24-main"] });
    expect(stale.status).toBe("degraded");
    expect(stale.items[0]!.stale).toBe(true);
    expect(stale.items[0]!.fetchedAt).toBe(new Date(NOW).toISOString());
    expect(stale.sources[0]).toMatchObject({ status: "stale", stale: true, errorCode: "UPSTREAM_HTTP_ERROR", retryAfterSeconds: 60 });
    await news.query({ feeds: ["ct24-main"], limit: 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    now += 60_000;
    await news.query({ feeds: ["ct24-main"] });
    expect(fetcher).toHaveBeenCalledTimes(3);
    now = NOW + 900_000;
    const expired = await news.query({ feeds: ["ct24-main"] });
    expect(expired.items).toEqual([]);
    expect(expired.sources[0]).toMatchObject({ status: "unavailable", stale: false, errorCode: "UPSTREAM_HTTP_ERROR" });
    failed = false;
    now += 60_000;
    const recovered = await news.query({ feeds: ["ct24-main"] });
    expect(recovered.status).toBe("ok");
    expect(recovered.sources[0]).toMatchObject({ errorCode: null, retryAfterSeconds: null, stale: false });
    expect(recovered.items).toHaveLength(1);
  });

  it("rechecks the 24-hour age at cached and stale reads", async () => {
    let now = NOW;
    let failed = false;
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (failed) throw new Error("network failed");
      return response(rss([{ pubDate: new Date(NOW - 24 * 60 * 60 * 1000 + 10_000).toISOString() }]));
    });
    const { news } = service(fetcher, () => now);
    expect((await news.query({ feeds: ["ct24-main"] })).items).toHaveLength(1);
    now += 10_001;
    expect((await news.query({ feeds: ["ct24-main"] })).items).toEqual([]);
    failed = true;
    now += 300_000;
    const stale = await news.query({ feeds: ["ct24-main"] });
    expect(stale.sources[0]!.status).toBe("stale");
    expect(stale.items).toEqual([]);
  });

  it("does not refetch an empty successful feed until the shared cache TTL expires", async () => {
    const { news, fetcher } = service(vi.fn<typeof fetch>(async () => response(rss([{ title: "Nová výstava v Brně" }]))));
    await news.query({ feeds: ["ct24-main"] });
    await news.query({ feeds: ["ct24-main"] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("isolates a failed feed while returning other sources and applies cold-failure backoff", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("hlavni-zpravy")) throw new Error("private upstream error details should never be exposed");
      return response(
        rss([{ link: String(url).includes("jihomoravsky") ? "https://ct24.ceskatelevize.cz/clanek/brno" : "https://ct24.ceskatelevize.cz/clanek/ostrava" }])
      );
    });
    const { news } = service(fetcher);
    const result = await news.query();
    expect(result.status).toBe("degraded");
    expect(result.items).toHaveLength(2);
    expect(result.sources.map((source) => source.status)).toEqual(["unavailable", "ok", "ok"]);
    expect(result.sources[0]).toMatchObject({ errorCode: "UPSTREAM_UNAVAILABLE", retryAfterSeconds: 60 });
    expect(JSON.stringify(result)).not.toContain("private upstream");
    await news.query();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([
    "<rss><channel><item></channel></rss>",
    "<html><body>not RSS</body></html>",
    '<!DOCTYPE rss [<!ENTITY evil SYSTEM "file:///etc/passwd">]><rss><channel><title>&evil;</title></channel></rss>',
    '<!DOCTYPE rss [<!ENTITY a "ha"><!ENTITY b "&a;&a;&a;&a;">]><rss><channel><title>&b;</title></channel></rss>'
  ])("rejects malformed or entity-expansive XML without metadata %s", async (xml) => {
    const { news } = service(vi.fn<typeof fetch>(async () => response(xml)));
    const result = await news.query({ feeds: ["ct24-main"] });
    expect(result.items).toEqual([]);
    expect(result.sources[0]).toMatchObject({ status: "unavailable", errorCode: "UPSTREAM_INVALID_XML" });
  });

  it("rejects HTML content even when an upstream claims HTTP success", async () => {
    const { news } = service(vi.fn<typeof fetch>(async () => new Response(rss(), { headers: { "content-type": "text/html" } })));
    expect((await news.query({ feeds: ["ct24-main"] })).sources[0]?.errorCode).toBe("UPSTREAM_INVALID_XML");
  });

  it("rejects overly nested XML even below the response-size ceiling", async () => {
    const nested = `<rss><channel>${"<node>".repeat(30)}title${"</node>".repeat(30)}</channel></rss>`;
    const { news } = service(vi.fn<typeof fetch>(async () => response(nested)));
    expect((await news.query({ feeds: ["ct24-main"] })).sources[0]?.errorCode).toBe("UPSTREAM_INVALID_XML");
  });

  it("caps decoded stream bytes with or without a claimed content length", async () => {
    for (const headers of [{}, { "content-length": String(MEDIA_NEWS_MAX_RESPONSE_BYTES + 1) }, { "content-length": "20" }]) {
      const { news } = service(vi.fn<typeof fetch>(async () => response("é".repeat(MEDIA_NEWS_MAX_RESPONSE_BYTES / 2 + 1), headers)));
      const result = await news.query({ feeds: ["ct24-main"] });
      expect(result.items).toEqual([]);
      expect(result.sources[0]?.errorCode).toBe("UPSTREAM_TOO_LARGE");
    }
  });

  it("keeps its timeout active during body consumption and cancels a stalled body", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    let signal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
      signal = options?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          }
        }),
        { headers: { "content-type": "application/rss+xml" } }
      );
    });
    const news = new MediaNewsService({ enabled: true, requestTimeoutMs: 25 }, { fetch: fetcher, now: () => NOW });
    const pending = news.query({ feeds: ["ct24-main"] });
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;
    expect(result.sources[0]?.errorCode).toBe("UPSTREAM_TIMEOUT");
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("enforces a hard deadline even if an injected upstream ignores its abort signal", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async () => new Promise<Response>(() => {}));
    const news = new MediaNewsService({ enabled: true, requestTimeoutMs: 25 }, { fetch: fetcher, now: () => NOW });
    const pending = news.query({ feeds: ["ct24-main"] });
    await vi.advanceTimersByTimeAsync(25);
    expect((await pending).sources[0]?.errorCode).toBe("UPSTREAM_TIMEOUT");
    await news.query({ feeds: ["ct24-main"] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
