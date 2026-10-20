import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutingWorkQueue, RoutingSingleFlight } from "../src/routing-work.js";

afterEach(() => vi.useRealTimers());
describe("bounded routing engine work", () => {
  it("bounds active requests, keeps FIFO order and rejects overflow", async () => {
    const queue = new RoutingWorkQueue(1, 1, 1000);
    const order: number[] = [];
    let finish!: () => void;
    const first = queue.run(async () => {
      order.push(1);
      await new Promise<void>((r) => {
        finish = r;
      });
    });
    const second = queue.run(async () => {
      order.push(2);
    });
    await expect(
      queue.run(async () => {
        order.push(3);
      })
    ).rejects.toThrow("busy");
    expect(order).toEqual([1]);
    finish();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
    await queue.run(async () => {
      order.push(4);
    });
    expect(order).toEqual([1, 2, 4]);
  });
  it("expires queued work without executing it and releases capacity on errors", async () => {
    vi.useFakeTimers();
    const queue = new RoutingWorkQueue(1, 1, 50);
    let finish!: () => void;
    const first = queue.run(
      () =>
        new Promise<void>((r) => {
          finish = r;
        })
    );
    const work = vi.fn();
    const rejected = expect(queue.run(work)).rejects.toThrow("expired");
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(work).not.toHaveBeenCalled();
    finish();
    await first;
    await expect(
      queue.run(async () => {
        throw new Error("engine failed");
      })
    ).rejects.toThrow("engine failed");
    expect(await queue.run(async () => "recovered")).toBe("recovered");
  });
  it("coalesces only concurrent exact generation keys and isolates mutable results", async () => {
    const flight = new RoutingSingleFlight<{ items: number[] }>();
    let release!: (value: { items: number[] }) => void;
    const work = vi.fn(
      () =>
        new Promise<{ items: number[] }>((r) => {
          release = r;
        })
    );
    const a = flight.run("graph1-closure1-overlay1", work);
    const b = flight.run("graph1-closure1-overlay1", work);
    await Promise.resolve();
    release({ items: [1] });
    const [one, two] = await Promise.all([a, b]);
    one.items.push(2);
    expect(two.items).toEqual([1]);
    expect(work).toHaveBeenCalledTimes(1);
    expect(await flight.run("graph1-closure1-overlay1", async () => ({ items: [3] }))).toEqual({ items: [3] });
    const different = vi.fn(async () => ({ items: [4] }));
    await flight.run("graph1-closure2-overlay2", different);
    expect(different).toHaveBeenCalledTimes(1);
  });
});
