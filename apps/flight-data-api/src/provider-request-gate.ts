/** Source-wide gate: changing a viewport must not bypass a provider cooldown. */
export class ProviderRequestGate {
  private blockedUntil = 0;
  private failures = 0;
  private busy = false;

  async json<T>(url: string, timeoutMs: number, headers: Record<string, string>): Promise<T> {
    if (this.busy || Date.now() < this.blockedUntil) {
      throw new Error("Flight provider temporarily unavailable; shared cooldown active.");
    }
    this.busy = true;
    let retryAfterMs = 0;
    let rateLimited = false;
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        rateLimited = response.status === 429;
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
          const seconds = Number(retryAfter);
          retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retryAfter) - Date.now());
          if (!Number.isFinite(retryAfterMs)) retryAfterMs = 0;
        }
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
      }
      const data = await response.json() as T;
      this.failures = 0;
      this.blockedUntil = 0;
      return data;
    } catch (error) {
      this.failures = Math.min(this.failures + 1, 8);
      const delay = Math.min(15 * 60_000, (rateLimited ? 60_000 : 5_000) * 2 ** (this.failures - 1));
      // Never shorten the provider's explicit Retry-After, even beyond our backoff cap.
      this.blockedUntil = Date.now() + Math.max(delay, retryAfterMs);
      throw error;
    } finally {
      this.busy = false;
    }
  }
}
