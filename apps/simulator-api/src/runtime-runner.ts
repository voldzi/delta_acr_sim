import type { RuntimeStatus, Scenario } from "@delta-acr/contracts";
import type { PublisherClient } from "@delta-acr/publisher-client";
import { generateScenarioEvents } from "@delta-acr/simulation-core";
import { randomUUID } from "node:crypto";
import type { ApiConfig } from "./config.js";
import type { JsonStore } from "./store.js";

export interface RuntimeStartOptions {
  speedMultiplier?: number;
  tickIntervalSeconds?: number;
}

export interface ExtendedRuntimeStatus extends RuntimeStatus {
  tick?: number;
  elapsedSeconds?: number;
  speedMultiplier?: number;
  tickIntervalSeconds?: number;
  activeObjects?: number;
  lastTickAt?: string;
  completedAt?: string;
}

export class RuntimeRunner {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;
  private speedMultiplier = 1;
  private tickIntervalSeconds = 1;

  constructor(
    private readonly config: ApiConfig,
    private readonly store: JsonStore,
    private readonly publisher: PublisherClient
  ) {}

  async start(scenario: Scenario, options: RuntimeStartOptions = {}): Promise<ExtendedRuntimeStatus> {
    this.clearTimer();
    this.speedMultiplier = clamp(Number(options.speedMultiplier ?? 1), 0.1, 20);
    this.tickIntervalSeconds = clamp(Number(options.tickIntervalSeconds ?? 1), 0.25, 10);

    const startedAt = new Date().toISOString();
    scenario.status = "RUNNING";
    this.store.data.runtime = {
      scenarioId: scenario.scenarioId,
      runtimeId: randomUUID(),
      state: "RUNNING",
      startedAt,
      generatedEvents: 0,
      publishedEvents: this.countDelivered(),
      queuedEvents: this.publisher.status().queueSize,
      tick: 0,
      elapsedSeconds: 0,
      speedMultiplier: this.speedMultiplier,
      tickIntervalSeconds: this.tickIntervalSeconds,
      activeObjects: 0,
      lastTickAt: startedAt
    } as ExtendedRuntimeStatus;

    await this.publishTick(scenario, 0);
    this.schedule(scenario.scenarioId);
    await this.store.save();
    return this.currentStatus();
  }

  async step(scenario: Scenario): Promise<ExtendedRuntimeStatus> {
    const nextTick = (this.currentStatus().tick ?? 0) + 1;
    await this.publishTick(scenario, nextTick);
    await this.store.save();
    return this.currentStatus();
  }

  async pause(scenario: Scenario): Promise<ExtendedRuntimeStatus> {
    this.clearTimer();
    scenario.status = "PAUSED";
    this.store.data.runtime = {
      ...this.currentStatus(),
      scenarioId: scenario.scenarioId,
      state: "PAUSED",
      publishedEvents: this.countDelivered(),
      queuedEvents: this.publisher.status().queueSize
    };
    await this.store.save();
    return this.currentStatus();
  }

  async resume(scenario: Scenario): Promise<ExtendedRuntimeStatus> {
    scenario.status = "RUNNING";
    const status = this.currentStatus();
    this.speedMultiplier = status.speedMultiplier ?? this.speedMultiplier;
    this.tickIntervalSeconds = status.tickIntervalSeconds ?? this.tickIntervalSeconds;
    this.store.data.runtime = {
      ...status,
      scenarioId: scenario.scenarioId,
      state: "RUNNING",
      publishedEvents: this.countDelivered(),
      queuedEvents: this.publisher.status().queueSize
    };
    this.schedule(scenario.scenarioId);
    await this.store.save();
    return this.currentStatus();
  }

  async stop(scenario: Scenario): Promise<ExtendedRuntimeStatus> {
    this.clearTimer();
    scenario.status = "STOPPED";
    this.store.data.runtime = {
      ...this.currentStatus(),
      scenarioId: scenario.scenarioId,
      state: "STOPPED",
      publishedEvents: this.countDelivered(),
      queuedEvents: this.publisher.status().queueSize,
      completedAt: new Date().toISOString()
    };
    await this.store.save();
    return this.currentStatus();
  }

  async reset(scenario: Scenario): Promise<ExtendedRuntimeStatus> {
    this.clearTimer();
    scenario.status = "READY";
    this.store.data.runtime = {
      scenarioId: scenario.scenarioId,
      runtimeId: randomUUID(),
      state: "READY",
      generatedEvents: 0,
      publishedEvents: this.countDelivered(),
      queuedEvents: this.publisher.status().queueSize,
      tick: 0,
      elapsedSeconds: 0,
      speedMultiplier: this.speedMultiplier,
      tickIntervalSeconds: this.tickIntervalSeconds,
      activeObjects: 0
    };
    await this.store.save();
    return this.currentStatus();
  }

  dispose(): void {
    this.clearTimer();
  }

  private schedule(scenarioId: string | undefined): void {
    this.clearTimer();
    if (!scenarioId) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runScheduledTick(scenarioId);
    }, this.tickIntervalSeconds * 1000);
    this.timer.unref?.();
  }

  private async runScheduledTick(scenarioId: string): Promise<void> {
    if (this.inFlight || this.currentStatus().state !== "RUNNING") {
      return;
    }

    const scenario = this.store.data.scenarios.find((item) => item.scenarioId === scenarioId);
    if (!scenario) {
      this.clearTimer();
      return;
    }

    const nextTick = (this.currentStatus().tick ?? 0) + 1;
    const elapsedSeconds = nextTick * this.tickIntervalSeconds * this.speedMultiplier;

    if (elapsedSeconds > scenario.durationSeconds) {
      await this.stop(scenario);
      return;
    }

    try {
      this.inFlight = true;
      await this.publishTick(scenario, nextTick);
      await this.store.save();
    } catch {
      this.clearTimer();
      scenario.status = "ERROR";
      this.store.data.runtime = {
        ...this.currentStatus(),
        scenarioId,
        state: "ERROR",
        publishedEvents: this.countDelivered(),
        queuedEvents: this.publisher.status().queueSize
      };
      await this.store.save();
    } finally {
      this.inFlight = false;
    }
  }

  private async publishTick(scenario: Scenario, tick: number): Promise<void> {
    const elapsedSeconds = tick * this.tickIntervalSeconds;
    const events = generateScenarioEvents(scenario, {
      sourceSystemId: this.config.sourceSystemId,
      adapterVersion: this.config.adapterVersion,
      tick,
      elapsedSeconds,
      tickIntervalSeconds: this.tickIntervalSeconds,
      speedMultiplier: this.speedMultiplier
    });

    for (const event of events) {
      await this.publisher.publishEvent(event);
    }

    this.store.data.runtime = {
      ...this.currentStatus(),
      scenarioId: scenario.scenarioId,
      state: scenario.status ?? "RUNNING",
      generatedEvents: this.currentStatus().generatedEvents + events.length,
      publishedEvents: this.countDelivered(),
      queuedEvents: this.publisher.status().queueSize,
      tick,
      elapsedSeconds: Math.round(elapsedSeconds * this.speedMultiplier),
      speedMultiplier: this.speedMultiplier,
      tickIntervalSeconds: this.tickIntervalSeconds,
      activeObjects: events.filter((event) => event.payload.status === "ACTIVE").length,
      lastTickAt: new Date().toISOString()
    };
  }

  private currentStatus(): ExtendedRuntimeStatus {
    return this.store.data.runtime as ExtendedRuntimeStatus;
  }

  private countDelivered(): number {
    return this.publisher.listQueue().filter((item) => item.state === "SENT" || item.state === "DRY_RUN_VALIDATED").length;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
