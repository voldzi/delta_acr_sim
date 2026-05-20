import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  CirclePause,
  CirclePlay,
  CloudSun,
  Database,
  ExternalLink,
  FlaskConical,
  Gauge,
  Layers3,
  MapPinned,
  Pause,
  Plane,
  Play,
  Plus,
  RadioTower,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Settings2,
  Square,
  Trash2,
  Zap
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  acceptAiDraft,
  addConnectivityFault,
  clearQueue,
  createAiDraft,
  createScenario,
  demoScenario,
  denseDemoScenario,
  loadDashboard,
  runtimeAction,
  testPublisher
} from "./api";
import type {
  AiDraft,
  FlightDataConfig,
  FlightDataHealth,
  FlightDataSource,
  FlightDataTrack,
  FlightDataTrackResponse,
  PublisherStatus,
  QueueItem,
  RuntimeStatus,
  Scenario,
  ScenarioBlock,
  SituationDataConfig,
  SituationDataFeature,
  SituationDataFeatureResponse,
  SituationDataHealth,
  SituationDataLayer,
  SituationDataSource,
  SituationLayerId
} from "./types";

type Tone = "safe" | "danger" | "active" | "neutral" | "warn";
type AffiliationCategory = "own" | "foreign" | "other";
type AppSection = "overview" | "scenario" | "flight-data" | "situation-data" | "publisher" | "ai" | "safety";

interface DashboardData {
  scenarios: Scenario[];
  runtime: RuntimeStatus;
  publisher: PublisherStatus;
  queue: QueueItem[];
  queueTotalCount: number;
  blocks: ScenarioBlock[];
  providers: Array<{ id: string; enabled: boolean; external: boolean; healthy: boolean }>;
  flightData: {
    health: FlightDataHealth;
    sources: FlightDataSource[];
    config: FlightDataConfig;
    tracks: FlightDataTrackResponse;
  };
  situationData: {
    health: SituationDataHealth;
    layers: SituationDataLayer[];
    sources: SituationDataSource[];
    config: SituationDataConfig;
    features: SituationDataFeatureResponse;
  };
  warnings: string[];
}

interface AffiliationSummaryItem {
  category: AffiliationCategory;
  label: string;
  value: number;
  detail: string;
}

const copDisplayUrl = import.meta.env.VITE_COP_DISPLAY_URL ?? "https://cop.zeleznalady.cz";
const ownAffiliations = new Set(["FRIEND", "ASSUMED_FRIEND"]);
const foreignAffiliations = new Set(["HOSTILE", "SUSPECT"]);

const emptyRuntime: RuntimeStatus = {
  state: "STOPPED",
  generatedEvents: 0,
  publishedEvents: 0,
  queuedEvents: 0
};

const emptyPublisher: PublisherStatus = {
  mode: "DRY_RUN",
  queueSize: 0,
  deadLetterSize: 0,
  publishingEnabled: true
};

const emptyFlightTracks: FlightDataTrackResponse = {
  contractVersion: "cop-flight-source-v1",
  source: {
    sourceId: "flight-data-api",
    sourceType: "PUBLIC_FLIGHT_AGGREGATE",
    generatedAt: new Date(0).toISOString()
  },
  summary: {
    rawObservationCount: 0,
    deduplicatedTrackCount: 0,
    droppedWithoutPositionCount: 0,
    staleTrackCount: 0
  },
  tracks: [],
  sources: [],
  warnings: []
};

const emptySituationFeatures: SituationDataFeatureResponse = {
  contractVersion: "cop-situation-source-v1",
  type: "FeatureCollection",
  generatedAt: new Date(0).toISOString(),
  source: {
    sourceId: "situation-data-api",
    sourceType: "PUBLIC_SITUATION_AGGREGATE",
    generatedAt: new Date(0).toISOString()
  },
  query: {
    bbox: { west: 0, south: 0, east: 0, north: 0 },
    layers: [],
    limit: 0,
    sources: []
  },
  summary: {
    featureCount: 0,
    sourceCount: 0,
    staleFeatureCount: 0,
    warningCount: 0
  },
  features: [],
  sources: [],
  warnings: []
};

export function App() {
  const [data, setData] = useState<DashboardData>({
    scenarios: [],
    runtime: emptyRuntime,
    publisher: emptyPublisher,
    queue: [],
    queueTotalCount: 0,
    blocks: [],
    providers: [],
    flightData: {
      health: { status: "unknown", enabledSources: [] },
      sources: [],
      config: {
        enabledSources: [],
        defaultArea: { lat: 0, lon: 0, radiusNm: 0 },
        cacheTtlSeconds: 0,
        staleAfterSeconds: 0,
        requestTimeoutMs: 0,
        providers: []
      },
      tracks: emptyFlightTracks
    },
    situationData: {
      health: { status: "unknown", enabledSources: [] },
      layers: [],
      sources: [],
      config: {
        enabledSources: [],
        defaultBbox: { west: 0, south: 0, east: 0, north: 0 },
        cacheTtlSeconds: 0,
        staleAfterSeconds: 0,
        requestTimeoutMs: 0,
        providers: []
      },
      features: emptySituationFeatures
    },
    warnings: []
  });
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>("");
  const [activeSection, setActiveSection] = useState<AppSection>("overview");
  const [aiPrompt, setAiPrompt] = useState("Create a 15 minute synthetic air situation latency test with aircraft, UAV and missile tracks.");
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const [notice, setNotice] = useState<string>("Ready for continuous synthetic movement.");
  const [loading, setLoading] = useState(false);
  const [speedMultiplier, setSpeedMultiplier] = useState(1);
  const [lastRefreshAt, setLastRefreshAt] = useState<string>();

  const selectedScenario = useMemo(
    () => data.scenarios.find((scenario) => scenario.scenarioId === selectedScenarioId) ?? data.scenarios[0],
    [data.scenarios, selectedScenarioId]
  );
  const scenarioList = useMemo(
    () =>
      [...data.scenarios].sort((first, second) => {
        const activeDelta = Number(isActiveRuntimeScenario(second, data.runtime)) - Number(isActiveRuntimeScenario(first, data.runtime));
        if (activeDelta !== 0) {
          return activeDelta;
        }
        return scenarioCreatedAt(second) - scenarioCreatedAt(first);
      }),
    [data.runtime, data.scenarios]
  );
  const displayedBlocks = selectedScenario?.blocks ?? data.blocks;
  const totalObjects = useMemo(
    () => displayedBlocks.reduce((sum, block) => sum + (block.enabled ? block.objectCount : 0), 0),
    [displayedBlocks]
  );
  const affiliationSummary = useMemo(() => summarizeAffiliations(displayedBlocks), [displayedBlocks]);
  const simulationClock = formatDuration(data.runtime.elapsedSeconds ?? 0);
  const isRunning = data.runtime.state === "RUNNING";
  const isPaused = data.runtime.state === "PAUSED";
  const effectiveSpeedMultiplier = isRunning ? (data.runtime.speedMultiplier ?? speedMultiplier) : speedMultiplier;
  const deliveryRate = formatPercent(data.runtime.publishedEvents, data.runtime.generatedEvents);
  const queueTone: Tone = data.publisher.deadLetterSize > 0 ? "danger" : data.publisher.queueSize > 0 ? "warn" : "safe";
  const runtimeTone = runtimeStateTone(data.runtime.state);
  const publisherTone: Tone = data.publisher.publishingEnabled ? (data.publisher.mode === "LIVE" ? "active" : "safe") : "danger";
  const selectedScenarioState = scenarioDisplayState(selectedScenario, data.runtime);
  const selectedScenarioIsRuntime = selectedScenario ? isRuntimeScenario(selectedScenario, data.runtime) : false;
  const otherScenarioIsActive = Boolean(!selectedScenarioIsRuntime && data.runtime.scenarioId && (isRunning || isPaused));
  const activePublishFailure = isAfter(data.publisher.lastFailureAt, data.publisher.lastSuccessAt);
  const flightDataTone: Tone = data.flightData.health.status === "ok" ? (data.flightData.tracks.warnings.length > 0 ? "warn" : "safe") : "danger";
  const situationDataTone: Tone =
    data.situationData.health.status === "ok" ? (data.situationData.features.warnings.length > 0 ? "warn" : "safe") : "danger";
  const activeSectionMeta = sectionMeta(activeSection);

  const readinessItems = [
    {
      icon: <CirclePlay />,
      label: "Runtime",
      value: data.runtime.state,
      tone: runtimeTone,
      detail: `${data.runtime.tick ?? 0} ticks, ${simulationClock} elapsed`
    },
    {
      icon: <RadioTower />,
      label: "Publisher",
      value: data.publisher.mode,
      tone: publisherTone,
      detail: data.publisher.publishingEnabled ? "adapter enabled" : "adapter stopped"
    },
    {
      icon: <Database />,
      label: "Delivery queue",
      value: `${data.publisher.queueSize} active`,
      tone: queueTone,
      detail: `${data.publisher.deadLetterSize} dead-letter, ${data.queueTotalCount} retained`
    },
    {
      icon: activePublishFailure ? <AlertTriangle /> : <CheckCircle2 />,
      label: "Last publish",
      value: formatTime(data.publisher.lastSuccessAt),
      tone: activePublishFailure ? "danger" : data.publisher.lastSuccessAt ? "safe" : "neutral",
      detail: activePublishFailure
        ? `failure ${formatTime(data.publisher.lastFailureAt)}`
        : data.publisher.lastSuccessAt
          ? "latest delivery succeeded"
          : "no publish attempts yet"
    },
    {
      icon: <Plane />,
      label: "Flight Data",
      value: data.flightData.health.status.toUpperCase(),
      tone: flightDataTone,
      detail: `${data.flightData.tracks.summary.deduplicatedTrackCount} dedup tracks, ${data.flightData.config.enabledSources.join(", ") || "no source"}`
    },
    {
      icon: <Layers3 />,
      label: "Situation Data",
      value: data.situationData.health.status.toUpperCase(),
      tone: situationDataTone,
      detail: `${data.situationData.features.summary.featureCount} features, ${data.situationData.config.enabledSources.join(", ") || "no source"}`
    }
  ];

  const refresh = useCallback(async (preferredScenarioId?: string) => {
    const next = await loadDashboard();
    setData(next);
    setLastRefreshAt(new Date().toISOString());
    if (next.warnings.length > 0) {
      setNotice(`Dashboard degraded: ${next.warnings[0]}`);
    }
    const nextSelection = preferredScenarioId || selectedScenarioId || next.runtime.scenarioId;
    if (nextSelection && next.scenarios.some((scenario) => scenario.scenarioId === nextSelection)) {
      setSelectedScenarioId(nextSelection);
    } else if (next.scenarios[0]?.scenarioId) {
      setSelectedScenarioId(next.scenarios[0].scenarioId);
    }
  }, [selectedScenarioId]);

  useEffect(() => {
    void refresh().catch((error) => setNotice(error instanceof Error ? error.message : "Dashboard load failed."));
    const interval = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  async function runAction<T>(message: string, action: () => Promise<T>) {
    setLoading(true);
    try {
      const result = await action();
      setNotice(message);
      await refresh(typeof result === "string" ? result : undefined);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Operation failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">SIM</div>
          <div>
            <strong>COP Air & Situation Simulator</strong>
            <span>Synthetic data pilot</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="Primary">
          <NavButton section="overview" activeSection={activeSection} onSelect={setActiveSection} icon={<Gauge size={17} />} label="Overview" />
          <NavButton section="scenario" activeSection={activeSection} onSelect={setActiveSection} icon={<Activity size={17} />} label="Scenario" />
          <NavButton section="flight-data" activeSection={activeSection} onSelect={setActiveSection} icon={<Plane size={17} />} label="Flight data" />
          <NavButton section="situation-data" activeSection={activeSection} onSelect={setActiveSection} icon={<Layers3 size={17} />} label="Situation data" />
          <NavButton section="publisher" activeSection={activeSection} onSelect={setActiveSection} icon={<RadioTower size={17} />} label="Publisher" />
          <NavButton section="ai" activeSection={activeSection} onSelect={setActiveSection} icon={<Bot size={17} />} label="AI Assistant" />
          <NavButton section="safety" activeSection={activeSection} onSelect={setActiveSection} icon={<ShieldCheck size={17} />} label="Safety" />
        </nav>

        <div className="safety-panel">
          <ShieldCheck size={18} />
          <div>
            <strong>Synthetic-only gate</strong>
            <span>Non-synthetic payloads are rejected before COP ingest.</span>
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{activeSectionMeta.kicker}</p>
            <h1>{activeSectionMeta.title}</h1>
            <p>{activeSectionMeta.description}</p>
          </div>
          <div className="topbar-actions">
            <a className="external-link" href={copDisplayUrl} target="_blank" rel="noreferrer">
              COP display <ExternalLink size={15} />
            </a>
            <StatusPill label={data.publisher.mode} tone={publisherTone} />
            <StatusPill label={data.runtime.state} tone={runtimeTone} />
          </div>
        </header>

        {activeSection === "overview" ? (
          <>
            <section id="dashboard" className="metrics-grid" aria-label="Runtime metrics">
              <Metric icon={<Activity />} label="Generated events" value={data.runtime.generatedEvents} detail={`${data.runtime.tick ?? 0} ticks`} />
              <Metric icon={<RadioTower />} label="Delivered events" value={data.runtime.publishedEvents} detail={`${deliveryRate} delivery`} />
              <Metric icon={<Database />} label="Active tracks" value={data.runtime.activeObjects ?? totalObjects} detail={`${totalObjects} configured`} />
              <Metric icon={<Plane />} label="Flight tracks" value={data.flightData.tracks.summary.deduplicatedTrackCount} detail={`${data.flightData.tracks.summary.rawObservationCount} raw observations`} />
              <Metric icon={<Layers3 />} label="Situation features" value={data.situationData.features.summary.featureCount} detail={`${data.situationData.layers.length} layers available`} />
            </section>

            <section id="readiness" className="operations-grid" aria-label="Operational readiness">
              <section className="ops-panel readiness-panel">
                <PanelTitle icon={<ShieldCheck />} title="Operational readiness" subtitle={`Last refresh ${formatTime(lastRefreshAt)}`} />
                <div className="readiness-list">
                  {readinessItems.map((item) => (
                    <div key={item.label} className={`readiness-item ${item.tone}`}>
                      <div className="readiness-icon">{item.icon}</div>
                      <div>
                        <span>{item.label}</span>
                        <strong>{item.value}</strong>
                        <small>{item.detail}</small>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="ops-panel affiliation-panel">
                <PanelTitle icon={<ShieldAlert />} title="Track ownership mix" subtitle="COP affiliation source" />
                <div className="affiliation-grid">
                  {affiliationSummary.map((item) => (
                    <div key={item.category} className={`affiliation-card ${item.category}`}>
                      <span>{item.label}</span>
                      <strong>{item.value}</strong>
                      <small>{item.detail}</small>
                    </div>
                  ))}
                </div>
              </section>
            </section>
          </>
        ) : null}

        <section className="section-layout">
          {activeSection === "scenario" ? (
          <section id="scenario" className="panel scenario-panel">
            <PanelTitle icon={<CirclePlay />} title="Scenario execution" subtitle="Deterministic moving tracks for COP display validation." />

            <div className="scenario-toolbar">
              <div>
                <strong>Scenario library</strong>
                <span>{data.scenarios.length.toLocaleString("cs-CZ")} prepared scenarios</span>
              </div>
              <button
                type="button"
                onClick={() =>
                  runAction("Demo scenario created.", async () => {
                    const created = await createScenario(demoScenario);
                    setSelectedScenarioId(created.scenarioId);
                    return created.scenarioId;
                  })
                }
                disabled={loading}
              >
                <Plus size={16} /> Demo
              </button>
              <button
                type="button"
                onClick={() =>
                  runAction("High-density demo scenario created.", async () => {
                    const created = await createScenario(denseDemoScenario);
                    setSelectedScenarioId(created.scenarioId);
                    return created.scenarioId;
                  })
                }
                disabled={loading}
              >
                <Database size={16} /> 300 tracks
              </button>
            </div>

            <div className="scenario-picker" aria-label="Scenario library">
              {scenarioList.length === 0 ? <div className="empty-state">Create the demo scenario to start the pilot runtime.</div> : null}
              {scenarioList.map((scenario) => (
                <ScenarioCard
                  key={scenario.scenarioId}
                  scenario={scenario}
                  runtime={data.runtime}
                  selected={scenario.scenarioId === selectedScenario?.scenarioId}
                  onSelect={() => scenario.scenarioId && setSelectedScenarioId(scenario.scenarioId)}
                />
              ))}
            </div>

            {selectedScenario ? (
              <div className="scenario-summary">
                <SummaryItem label="Status" value={selectedScenarioState} />
                <SummaryItem label="Duration" value={`${Math.round(selectedScenario.durationSeconds / 60)} min`} />
                <SummaryItem label="Objects" value={totalObjects.toLocaleString("cs-CZ")} />
                <SummaryItem label="Seed" value={selectedScenario.seed.toString()} />
                <SummaryItem label="Tick" value={(data.runtime.tick ?? 0).toString()} />
                <SummaryItem label="Speed" value={`${effectiveSpeedMultiplier}x`} />
                <SummaryItem label="Update" value={`${data.runtime.tickIntervalSeconds ?? 1}s`} />
                <SummaryItem label="Last tick" value={formatTime(data.runtime.lastTickAt)} />
              </div>
            ) : (
              <div className="empty-state">Create the demo scenario to start the pilot runtime.</div>
            )}

            <div className="runtime-options" aria-label="Runtime speed">
              <span>Runtime speed</span>
              <div className="segmented">
                {[1, 5, 10].map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={effectiveSpeedMultiplier === value ? "selected" : ""}
                    disabled={isRunning}
                    onClick={() => setSpeedMultiplier(value)}
                  >
                    {value}x
                  </button>
                ))}
              </div>
            </div>

            {selectedScenario ? (
              <div className="runtime-command-bar">
                <div>
                  <strong>{runtimeCommandTitle(selectedScenario, data.runtime)}</strong>
                  <span>{runtimeCommandDetail(selectedScenario, data.runtime)}</span>
                </div>
                <div className="button-strip runtime-actions">
                  {otherScenarioIsActive ? <span className="command-note">Select the active scenario to control the running runtime.</span> : null}
                  {!isRunning && !isPaused ? (
                    <ActionButton
                      icon={<Play />}
                      label="Start"
                      disabled={loading}
                      onClick={() =>
                        selectedScenario.scenarioId &&
                        runAction("Scenario started. Moving tracks are published every second.", () =>
                          runtimeAction(selectedScenario.scenarioId!, "start", { speedMultiplier, tickIntervalSeconds: 1 })
                        )
                      }
                    />
                  ) : null}
                  {selectedScenarioIsRuntime && isRunning ? (
                    <>
                      <ActionButton
                        icon={<Pause />}
                        label="Pause"
                        disabled={loading}
                        onClick={() => selectedScenario.scenarioId && runAction("Scenario paused.", () => runtimeAction(selectedScenario.scenarioId!, "pause"))}
                      />
                      <ActionButton
                        icon={<Square />}
                        label="Stop"
                        disabled={loading}
                        onClick={() => selectedScenario.scenarioId && runAction("Scenario stopped.", () => runtimeAction(selectedScenario.scenarioId!, "stop"))}
                      />
                      <ActionButton
                        icon={<Zap />}
                        label="Fault"
                        disabled={loading}
                        onClick={() => selectedScenario.scenarioId && runAction("Connectivity fault added.", () => addConnectivityFault(selectedScenario.scenarioId!))}
                      />
                    </>
                  ) : null}
                  {selectedScenarioIsRuntime && isPaused ? (
                    <>
                      <ActionButton
                        icon={<Play />}
                        label="Resume"
                        disabled={loading}
                        onClick={() => selectedScenario.scenarioId && runAction("Scenario resumed.", () => runtimeAction(selectedScenario.scenarioId!, "resume"))}
                      />
                      <ActionButton
                        icon={<Square />}
                        label="Stop"
                        disabled={loading}
                        onClick={() => selectedScenario.scenarioId && runAction("Scenario stopped.", () => runtimeAction(selectedScenario.scenarioId!, "stop"))}
                      />
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}

            {selectedScenario ? (
              <details className="advanced-controls">
                <summary>Advanced controls</summary>
                <div className="button-strip compact">
                  <ActionButton
                    icon={<RotateCcw />}
                    label="Step"
                    disabled={loading || isRunning}
                    onClick={() =>
                      selectedScenario.scenarioId &&
                      runAction("One deterministic movement step generated.", () => runtimeAction(selectedScenario.scenarioId!, "step"))
                    }
                  />
                  <ActionButton
                    icon={<Zap />}
                    label="Fault"
                    disabled={loading || otherScenarioIsActive}
                    onClick={() => selectedScenario.scenarioId && runAction("Connectivity fault added.", () => addConnectivityFault(selectedScenario.scenarioId!))}
                  />
                </div>
              </details>
            ) : null}

            <div id="manifest" className="section-head">
              <div>
                <strong>Scenario manifest</strong>
                <span>{displayedBlocks.filter((block) => block.enabled).length} enabled blocks</span>
              </div>
              <StatusPill label={`${totalObjects} tracks`} tone="active" />
            </div>

            <div className="manifest-table" role="table" aria-label="Scenario manifest">
              <div className="manifest-row manifest-head" role="row">
                <span>Block</span>
                <span>Count</span>
                <span>Movement</span>
                <span>Rate</span>
                <span>Affiliation</span>
              </div>
              {displayedBlocks.map((block) => (
                <div key={block.blockId} className="manifest-row" role="row">
                  <strong>{block.blockId}</strong>
                  <span>{block.objectCount}</span>
                  <span>{block.patterns?.join(", ") ?? "DIRECT"}</span>
                  <span>{formatRate(block.updateRateHz)}</span>
                  <span>{formatAffiliations(block)}</span>
                </div>
              ))}
            </div>
          </section>
          ) : null}

          {activeSection === "flight-data" ? (
          <section id="flight-data" className="panel flight-data-panel">
            <PanelTitle icon={<Plane />} title="Flight Data source" subtitle="Aggregated public or licensed flight tracks prepared for the COP layer." />

            <div className="publisher-status">
              <StatusPill label={data.flightData.health.status} tone={flightDataTone} />
              <StatusPill label={data.flightData.tracks.contractVersion} tone="active" />
              <StatusPill
                label={`${data.flightData.tracks.warnings.length} warnings`}
                tone={data.flightData.tracks.warnings.length > 0 ? "warn" : "neutral"}
              />
            </div>

            <div className="publisher-stats flight-stats">
              <PublisherStat label="Raw observations" value={data.flightData.tracks.summary.rawObservationCount.toLocaleString("cs-CZ")} tone="neutral" />
              <PublisherStat label="Deduplicated tracks" value={data.flightData.tracks.summary.deduplicatedTrackCount.toLocaleString("cs-CZ")} tone="safe" />
              <PublisherStat label="Stale tracks" value={data.flightData.tracks.summary.staleTrackCount.toLocaleString("cs-CZ")} tone={data.flightData.tracks.summary.staleTrackCount > 0 ? "warn" : "neutral"} />
              <PublisherStat label="Dropped positions" value={data.flightData.tracks.summary.droppedWithoutPositionCount.toLocaleString("cs-CZ")} tone={data.flightData.tracks.summary.droppedWithoutPositionCount > 0 ? "danger" : "neutral"} />
            </div>

            <div className="flight-grid">
              <section className="inline-panel">
                <PanelTitle icon={<Settings2 />} title="Current settings" subtitle="Read-only runtime configuration from /srv/sim .env." />
                <div className="settings-grid">
                  <SummaryItem label="Enabled sources" value={data.flightData.config.enabledSources.join(", ") || "-"} />
                  <SummaryItem label="Default area" value={`${formatCoordinate(data.flightData.config.defaultArea.lat)}, ${formatCoordinate(data.flightData.config.defaultArea.lon)}`} />
                  <SummaryItem label="Radius" value={`${data.flightData.config.defaultArea.radiusNm} NM`} />
                  <SummaryItem label="Cache TTL" value={`${data.flightData.config.cacheTtlSeconds}s`} />
                  <SummaryItem label="Stale after" value={`${data.flightData.config.staleAfterSeconds}s`} />
                  <SummaryItem label="Timeout" value={`${data.flightData.config.requestTimeoutMs} ms`} />
                </div>
              </section>

              <section className="inline-panel">
                <PanelTitle icon={<Database />} title="Provider registry" subtitle="License and production suitability are visible before COP consumption." />
                <div className="source-list">
                  {data.flightData.sources.map((source) => (
                    <FlightSourceRow key={source.sourceId} source={source} authConfigured={Boolean(data.flightData.config.providers.find((provider) => provider.sourceId === source.sourceId)?.authConfigured)} />
                  ))}
                  {data.flightData.sources.length === 0 ? <div className="empty-state">Flight source metadata is not available.</div> : null}
                </div>
              </section>
            </div>

            <div className="section-head compact-head">
              <div>
                <strong>COP track preview</strong>
                <span>{data.flightData.tracks.tracks.length} shown from latest aggregate response</span>
              </div>
              <StatusPill label={formatTime(data.flightData.tracks.source.generatedAt)} tone="neutral" />
            </div>

            <div className="flight-track-list">
              {data.flightData.tracks.tracks.map((track) => (
                <FlightTrackRow key={track.trackId} track={track} />
              ))}
              {data.flightData.tracks.tracks.length === 0 ? <div className="empty-state">No flight tracks are available from the configured sources.</div> : null}
            </div>

            {data.flightData.tracks.warnings.length > 0 ? (
              <div className="notice warn">
                <AlertTriangle size={16} />
                <span>{data.flightData.tracks.warnings.join(" ")}</span>
              </div>
            ) : null}
          </section>
          ) : null}

          {activeSection === "situation-data" ? (
          <section id="situation-data" className="panel situation-data-panel">
            <PanelTitle icon={<Layers3 />} title="Situation Data source" subtitle="Aggregated public context layers prepared for the COP map." />

            <div className="publisher-status">
              <StatusPill label={data.situationData.health.status} tone={situationDataTone} />
              <StatusPill label={data.situationData.features.contractVersion} tone="active" />
              <StatusPill
                label={`${data.situationData.features.summary.warningCount} warnings`}
                tone={data.situationData.features.summary.warningCount > 0 ? "warn" : "neutral"}
              />
            </div>

            <div className="publisher-stats situation-stats">
              <PublisherStat label="Features" value={data.situationData.features.summary.featureCount.toLocaleString("cs-CZ")} tone="safe" />
              <PublisherStat label="Sources" value={data.situationData.features.summary.sourceCount.toLocaleString("cs-CZ")} tone="neutral" />
              <PublisherStat label="Stale" value={data.situationData.features.summary.staleFeatureCount.toLocaleString("cs-CZ")} tone={data.situationData.features.summary.staleFeatureCount > 0 ? "warn" : "neutral"} />
              <PublisherStat label="Layers" value={data.situationData.layers.length.toLocaleString("cs-CZ")} tone="active" />
            </div>

            <div className="flight-grid">
              <section className="inline-panel">
                <PanelTitle icon={<Settings2 />} title="Current settings" subtitle="Read-only runtime configuration for public situation layers." />
                <div className="settings-grid">
                  <SummaryItem label="Enabled sources" value={data.situationData.config.enabledSources.join(", ") || "-"} />
                  <SummaryItem label="Default bbox" value={formatBbox(data.situationData.config.defaultBbox)} />
                  <SummaryItem label="Cache TTL" value={`${data.situationData.config.cacheTtlSeconds}s`} />
                  <SummaryItem label="Stale after" value={`${data.situationData.config.staleAfterSeconds}s`} />
                  <SummaryItem label="Timeout" value={`${data.situationData.config.requestTimeoutMs} ms`} />
                  <SummaryItem label="Query limit" value={`${data.situationData.features.query.limit || 0}`} />
                </div>
              </section>

              <section className="inline-panel">
                <PanelTitle icon={<MapPinned />} title="Layer registry" subtitle="COP can toggle these layers independently from flight tracks." />
                <div className="layer-list">
                  {data.situationData.layers.map((layer) => (
                    <SituationLayerRow key={layer.layerId} layer={layer} count={countSituationLayer(data.situationData.features.features, layer.layerId)} />
                  ))}
                  {data.situationData.layers.length === 0 ? <div className="empty-state">Situation layer metadata is not available.</div> : null}
                </div>
              </section>
            </div>

            <div className="flight-grid">
              <section className="inline-panel">
                <PanelTitle icon={<Database />} title="Provider registry" subtitle="License, mode and source coverage for situation data." />
                <div className="source-list">
                  {data.situationData.sources.map((source) => (
                    <SituationSourceRow key={source.sourceId} source={source} authConfigured={Boolean(data.situationData.config.providers.find((provider) => provider.sourceId === source.sourceId)?.authConfigured)} />
                  ))}
                  {data.situationData.sources.length === 0 ? <div className="empty-state">Situation source metadata is not available.</div> : null}
                </div>
              </section>

              <section className="inline-panel">
                <PanelTitle icon={<CloudSun />} title="COP feature preview" subtitle="GeoJSON features returned by /situation-data/api/v1/cop/features." />
                <div className="situation-feature-list">
                  {data.situationData.features.features.map((feature) => (
                    <SituationFeatureRow key={feature.id} feature={feature} />
                  ))}
                  {data.situationData.features.features.length === 0 ? <div className="empty-state">No situation features are available from the configured sources.</div> : null}
                </div>
              </section>
            </div>

            {data.situationData.features.warnings.length > 0 ? (
              <div className="notice warn">
                <AlertTriangle size={16} />
                <span>{data.situationData.features.warnings.join(" ")}</span>
              </div>
            ) : null}
          </section>
          ) : null}

          {activeSection === "publisher" ? (
          <section id="publisher" className="panel publisher-panel">
            <PanelTitle icon={<RadioTower />} title="COP publisher" subtitle="Delivery state and recent canonical events." />
            <div className="publisher-status">
              <StatusPill label={data.publisher.publishingEnabled ? "publishing enabled" : "publishing stopped"} tone={data.publisher.publishingEnabled ? "safe" : "danger"} />
              <StatusPill label={`${data.publisher.deadLetterSize} dead-letter`} tone={data.publisher.deadLetterSize > 0 ? "danger" : "neutral"} />
            </div>

            <div className="publisher-stats">
              <PublisherStat label="Queue" value={data.publisher.queueSize.toLocaleString("cs-CZ")} tone={queueTone} />
              <PublisherStat label="Retained" value={data.queueTotalCount.toLocaleString("cs-CZ")} tone="neutral" />
              <PublisherStat label="Success" value={formatTime(data.publisher.lastSuccessAt)} tone="safe" />
            </div>

            <div className="button-strip compact">
              <button type="button" onClick={() => runAction("Publisher connection checked.", testPublisher)} disabled={loading}>
                <FlaskConical size={16} /> Test connection
              </button>
              <button type="button" onClick={() => runAction("Queue cleared.", clearQueue)} disabled={loading || data.queueTotalCount === 0}>
                <Trash2 size={16} /> Clear queue
              </button>
            </div>

            <div className="section-head compact-head">
              <div>
                <strong>Recent event flow</strong>
                <span>{data.queue.length} shown from {data.queueTotalCount} retained</span>
              </div>
            </div>

            <div className="queue-list">
              {data.queue.map((item) => (
                <QueueRow key={item.queueId} item={item} />
              ))}
              {data.queue.length === 0 ? <div className="empty-state">No queued events yet.</div> : null}
            </div>
          </section>
          ) : null}

          {activeSection === "ai" ? (
          <section id="ai" className="panel ai-panel">
            <PanelTitle icon={<Bot />} title="AI Scenario Assistant" subtitle="Mock provider, structured draft and human accept flow." />
            <textarea value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} rows={5} />
            <div className="button-strip compact">
              <button type="button" disabled={loading} onClick={() => runAction("AI draft generated.", async () => setDraft(await createAiDraft(aiPrompt)))}>
                <Bot size={16} /> Generate draft
              </button>
              <button type="button" disabled={!draft || !draft.policyCheck.allowed || loading} onClick={() => draft && runAction("AI draft accepted as scenario.", () => acceptAiDraft(draft.draftId))}>
                <ShieldCheck size={16} /> Accept draft
              </button>
            </div>
            {draft ? (
              <div className="draft-box">
                <div className="draft-head">
                  <strong>{draft.title}</strong>
                  <StatusPill label={draft.policyCheck.allowed ? "allowed" : "rejected"} tone={draft.policyCheck.allowed ? "safe" : "danger"} />
                </div>
                <p>{draft.explanation}</p>
                <small>{draft.policyCheck.reasons.join(" ")}</small>
              </div>
            ) : (
              <div className="empty-state">Generate a draft to validate the AI guardrail path.</div>
            )}
          </section>
          ) : null}

          {activeSection === "safety" ? (
          <section className="panel">
            <PanelTitle icon={<ShieldCheck />} title="Safety and providers" subtitle="External AI is disabled by default in the pilot." />
            <div className="provider-list">
              {data.providers.map((provider) => (
                <div key={provider.id} className="provider-row">
                  <span>{provider.id}</span>
                  <StatusPill label={provider.enabled ? "enabled" : "disabled"} tone={provider.enabled ? "safe" : "neutral"} />
                  <em>{provider.external ? "external" : "local"}</em>
                </div>
              ))}
            </div>
            <div className="notice">
              <CirclePause size={16} />
              <span>{notice}</span>
            </div>
          </section>
          ) : null}
        </section>
      </section>
    </main>
  );
}

function Metric({ icon, label, value, detail }: { icon: ReactNode; label: string; value: number | string; detail?: string }) {
  return (
    <div className="metric">
      <div className="metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{typeof value === "number" ? value.toLocaleString("cs-CZ") : value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function PanelTitle({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle: string }) {
  return (
    <div className="panel-title">
      <div className="panel-icon">{icon}</div>
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
    </div>
  );
}

function NavButton({
  section,
  activeSection,
  onSelect,
  icon,
  label
}: {
  section: AppSection;
  activeSection: AppSection;
  onSelect: (section: AppSection) => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button type="button" className={`nav-item ${activeSection === section ? "selected" : ""}`} onClick={() => onSelect(section)} aria-current={activeSection === section ? "page" : undefined}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function FlightSourceRow({ source, authConfigured }: { source: FlightDataSource; authConfigured: boolean }) {
  return (
    <div className="source-row">
      <div>
        <strong>{source.label}</strong>
        <span>
          {source.sourceId} · priority {source.priority}
        </span>
      </div>
      <div className="source-tags">
        <StatusPill label={source.enabled ? "enabled" : "disabled"} tone={source.enabled ? "safe" : "neutral"} />
        <StatusPill label={source.mode} tone={source.mode === "live" ? "active" : "neutral"} />
        <StatusPill label={authConfigured ? "auth ok" : "no auth"} tone={authConfigured ? "safe" : "warn"} />
      </div>
      <div className="source-license">
        <span>{source.license.name}</span>
        <StatusPill label={source.license.commercialUse.replaceAll("_", " ")} tone={licenseTone(source.license.commercialUse)} />
      </div>
      <small>{source.license.attribution}</small>
    </div>
  );
}

function FlightTrackRow({ track }: { track: FlightDataTrack }) {
  return (
    <div className={`flight-track-row ${track.quality.stale ? "stale" : ""}`}>
      <div>
        <strong>{formatTrackIdentity(track)}</strong>
        <span>
          {track.icao24} · {track.aircraft?.typeDesignator ?? "type n/a"} · {track.registration ?? "registration n/a"}
        </span>
      </div>
      <div className="flight-track-metrics">
        <span>{formatCoordinate(track.lat)}, {formatCoordinate(track.lon)}</span>
        <span>{formatAltitude(track.altitudeM)}</span>
        <span>{formatMotion(track.speedMps, track.headingDeg)}</span>
        <span>{formatTime(track.lastSeenAt)}</span>
      </div>
      <div className="flight-track-tags">
        <StatusPill label={`${track.deduplication.mergedRecordCount} merged`} tone={track.deduplication.mergedRecordCount > 1 ? "active" : "neutral"} />
        <StatusPill label={track.quality.stale ? "stale" : "current"} tone={track.quality.stale ? "warn" : "safe"} />
      </div>
    </div>
  );
}

function SituationLayerRow({ layer, count }: { layer: SituationDataLayer; count: number }) {
  return (
    <div className="layer-row">
      <div>
        <strong>{layer.label}</strong>
        <span>{layer.description}</span>
      </div>
      <div className="source-tags">
        <StatusPill label={layer.layerId} tone={layer.defaultVisible ? "active" : "neutral"} />
        <StatusPill label={`${count} shown`} tone={count > 0 ? "safe" : "neutral"} />
      </div>
      <small>
        {layer.geometryTypes.join(", ")}
        {layer.expectedCadenceSeconds ? ` · ${formatCadence(layer.expectedCadenceSeconds)}` : ""}
      </small>
    </div>
  );
}

function SituationSourceRow({ source, authConfigured }: { source: SituationDataSource; authConfigured: boolean }) {
  return (
    <div className="source-row">
      <div>
        <strong>{source.label}</strong>
        <span>
          {source.sourceId} · priority {source.priority} · {source.layers.join(", ")}
        </span>
      </div>
      <div className="source-tags">
        <StatusPill label={source.enabled ? "enabled" : "disabled"} tone={source.enabled ? "safe" : "neutral"} />
        <StatusPill label={source.mode} tone={source.mode === "live" ? "active" : "neutral"} />
        <StatusPill label={authConfigured ? "auth ok" : "no auth"} tone={authConfigured ? "safe" : "warn"} />
      </div>
      <div className="source-license">
        <span>{source.license.name}</span>
        <StatusPill label={source.license.commercialUse.replaceAll("_", " ")} tone={licenseTone(source.license.commercialUse)} />
      </div>
      <small>{source.license.attribution}</small>
    </div>
  );
}

function SituationFeatureRow({ feature }: { feature: SituationDataFeature }) {
  return (
    <div className={`situation-feature-row ${feature.properties.severity} ${feature.properties.stale ? "stale" : ""}`}>
      <div>
        <strong>{feature.properties.label}</strong>
        <span>
          {feature.properties.layer} · {feature.properties.category} · {feature.properties.sourceId}
        </span>
      </div>
      <div className="flight-track-metrics">
        <span>{formatGeometry(feature)}</span>
        <span>{formatTime(feature.properties.observedAt)}</span>
        <span>{formatConfidence(feature.properties.confidence)}</span>
        <span>{formatMetrics(feature.properties.metrics)}</span>
      </div>
      <div className="flight-track-tags">
        <StatusPill label={feature.properties.severity} tone={severityTone(feature.properties.severity)} />
        <StatusPill label={feature.properties.stale ? "stale" : "current"} tone={feature.properties.stale ? "warn" : "safe"} />
      </div>
    </div>
  );
}

function StatusPill({ label, tone }: { label: string; tone: Tone }) {
  return <span className={`status-pill ${tone}`}>{label}</span>;
}

function ScenarioCard({
  scenario,
  runtime,
  selected,
  onSelect
}: {
  scenario: Scenario;
  runtime: RuntimeStatus;
  selected: boolean;
  onSelect: () => void;
}) {
  const state = scenarioDisplayState(scenario, runtime);
  const active = isActiveRuntimeScenario(scenario, runtime);
  const objectCount = countScenarioObjects(scenario);

  return (
    <button type="button" className={`scenario-card ${selected ? "selected" : ""} ${active ? "active-runtime" : ""}`} onClick={onSelect}>
      <span className="scenario-card-main">
        <strong>{scenario.name}</strong>
        <span>{scenario.description ?? "Synthetic COP scenario"}</span>
      </span>
      <span className="scenario-card-tags">
        {active ? <StatusPill label="active" tone="active" /> : null}
        <StatusPill label={state} tone={runtimeStateTone(state)} />
      </span>
      <span className="scenario-card-meta">
        <span>{objectCount.toLocaleString("cs-CZ")} tracks</span>
        <span>{formatScenarioDuration(scenario.durationSeconds)}</span>
        <span>seed {scenario.seed}</span>
        <span>{scenario.scenarioId?.slice(0, 8) ?? "new"}</span>
      </span>
    </button>
  );
}

function ActionButton({ icon, label, disabled, onClick }: { icon: ReactNode; label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}>
      {icon} {label}
    </button>
  );
}

function PublisherStat({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className={`publisher-stat ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function QueueRow({ item }: { item: QueueItem }) {
  const affiliation = item.event.payload.affiliation ?? "UNKNOWN";
  return (
    <div className="queue-row">
      <div className="queue-main">
        <div>
          <strong>{item.event.payload.objectId}</strong>
          <span>
            {item.event.eventType} · {item.event.payload.objectType} · {item.event.simulation.blockId}
          </span>
        </div>
        <div className="queue-tags">
          <AffiliationBadge affiliation={affiliation} />
          <StatusPill label={item.state} tone={queueStateTone(item.state)} />
        </div>
      </div>
      <div className="queue-detail">
        <span>{formatGeo(item.event.geo)}</span>
        <span>{formatMotion(item.event.payload.speedMps, item.event.payload.headingDeg)}</span>
        <span>{formatTime(item.updatedAt)}</span>
        <span>{item.attempts} attempts</span>
      </div>
      {item.lastError ? <small className="queue-error">{item.lastError}</small> : null}
    </div>
  );
}

function AffiliationBadge({ affiliation }: { affiliation: string }) {
  const category = classifyAffiliation(affiliation);
  return <span className={`affiliation-badge ${category}`}>{affiliation}</span>;
}

function summarizeAffiliations(blocks: ScenarioBlock[]): AffiliationSummaryItem[] {
  const counts: Record<AffiliationCategory, number> = { own: 0, foreign: 0, other: 0 };

  for (const block of blocks) {
    if (!block.enabled) {
      continue;
    }
    const affiliations = readAffiliations(block);
    if (affiliations.length === 0) {
      counts.other += block.objectCount;
      continue;
    }
    for (let index = 0; index < block.objectCount; index += 1) {
      counts[classifyAffiliation(affiliations[index % affiliations.length] ?? "UNKNOWN")] += 1;
    }
  }

  return [
    { category: "own", label: "Own", value: counts.own, detail: "FRIEND, ASSUMED_FRIEND" },
    { category: "foreign", label: "Foreign", value: counts.foreign, detail: "HOSTILE, SUSPECT" },
    { category: "other", label: "Other", value: counts.other, detail: "UNKNOWN, NEUTRAL, PENDING" }
  ];
}

function readAffiliations(block: ScenarioBlock): string[] {
  const value = block.parameters?.affiliations;
  if (!Array.isArray(value)) {
    return defaultAffiliationsForBlock(block);
  }
  const configured = value.filter((item): item is string => typeof item === "string");
  return configured.length > 0 ? configured : defaultAffiliationsForBlock(block);
}

function defaultAffiliationsForBlock(block: ScenarioBlock): string[] {
  if (block.blockId === "ground-sim-friendly") {
    return ["ASSUMED_FRIEND", "FRIEND", "FRIEND"];
  }
  if (block.blockId === "air-sim-missile") {
    return ["HOSTILE"];
  }
  if (block.blockId === "air-sim-aircraft") {
    return ["FRIEND", "HOSTILE", "ASSUMED_FRIEND", "SUSPECT"];
  }
  if (block.blockId === "air-sim-uav") {
    return ["HOSTILE", "SUSPECT", "FRIEND"];
  }
  return ["UNKNOWN"];
}

function classifyAffiliation(affiliation: string): AffiliationCategory {
  if (ownAffiliations.has(affiliation)) {
    return "own";
  }
  if (foreignAffiliations.has(affiliation)) {
    return "foreign";
  }
  return "other";
}

function scenarioDisplayState(scenario: Scenario | undefined, runtime: RuntimeStatus): string {
  if (scenario && isRuntimeScenario(scenario, runtime)) {
    return runtime.state;
  }
  return scenario?.status ?? "DRAFT";
}

function isActiveRuntimeScenario(scenario: Scenario, runtime: RuntimeStatus): boolean {
  return isRuntimeScenario(scenario, runtime) && (runtime.state === "RUNNING" || runtime.state === "PAUSED");
}

function isRuntimeScenario(scenario: Scenario, runtime: RuntimeStatus): boolean {
  return Boolean(scenario.scenarioId && runtime.scenarioId === scenario.scenarioId);
}

function countScenarioObjects(scenario: Scenario): number {
  return scenario.blocks.reduce((sum, block) => sum + (block.enabled ? block.objectCount : 0), 0);
}

function scenarioCreatedAt(scenario: Scenario): number {
  const createdAt = scenario.metadata?.createdAt;
  return createdAt ? new Date(createdAt).getTime() || 0 : 0;
}

function formatScenarioDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} min`;
}

function runtimeCommandTitle(scenario: Scenario, runtime: RuntimeStatus): string {
  if (isRuntimeScenario(scenario, runtime) && runtime.state === "RUNNING") {
    return "Runtime is publishing";
  }
  if (isRuntimeScenario(scenario, runtime) && runtime.state === "PAUSED") {
    return "Runtime is paused";
  }
  if (runtime.scenarioId && (runtime.state === "RUNNING" || runtime.state === "PAUSED")) {
    return "Another scenario is active";
  }
  return "Ready to start";
}

function runtimeCommandDetail(scenario: Scenario, runtime: RuntimeStatus): string {
  if (isRuntimeScenario(scenario, runtime) && runtime.state === "RUNNING") {
    return "Pause or stop the active feed, or inject a test connectivity fault.";
  }
  if (isRuntimeScenario(scenario, runtime) && runtime.state === "PAUSED") {
    return "Resume live publishing, stop the runtime, or use deterministic step in advanced controls.";
  }
  if (runtime.scenarioId && (runtime.state === "RUNNING" || runtime.state === "PAUSED")) {
    return "The selected scenario is not the one currently controlled by the runtime.";
  }
  return "Start this scenario with the selected runtime speed.";
}

function formatAffiliations(block: ScenarioBlock): string {
  const affiliations = readAffiliations(block);
  return affiliations.length > 0 ? affiliations.join(", ") : "UNKNOWN";
}

function runtimeStateTone(state: string): Tone {
  if (state === "RUNNING") {
    return "active";
  }
  if (state === "ERROR" || state === "UNAVAILABLE") {
    return "danger";
  }
  if (state === "PAUSED" || state === "READY") {
    return "warn";
  }
  return "neutral";
}

function queueStateTone(state: string): Tone {
  if (state === "SENT" || state === "DRY_RUN_VALIDATED") {
    return "safe";
  }
  if (state === "DEAD_LETTER") {
    return "danger";
  }
  if (state === "RETRY_SCHEDULED" || state === "PENDING" || state === "SENDING") {
    return "warn";
  }
  return "neutral";
}

function licenseTone(value: string): Tone {
  if (value === "allowed") {
    return "safe";
  }
  if (value === "allowed_with_obligations") {
    return "warn";
  }
  if (value === "requires_license") {
    return "danger";
  }
  return "neutral";
}

function sectionMeta(section: AppSection): { kicker: string; title: string; description: string } {
  switch (section) {
    case "scenario":
      return {
        kicker: "Scenario control",
        title: "Scenario execution",
        description: "Start, pause and inspect deterministic synthetic movement for COP validation."
      };
    case "flight-data":
      return {
        kicker: "Public flight aggregate",
        title: "Flight Data source",
        description: "Monitor collected flight observations, deduplication, provider licenses and runtime settings."
      };
    case "situation-data":
      return {
        kicker: "Public situation aggregate",
        title: "Situation Data source",
        description: "Monitor weather, ground, mobile and traffic context prepared for COP map layers."
      };
    case "publisher":
      return {
        kicker: "COP integration",
        title: "COP publisher",
        description: "Watch delivery state, retained events, retry queue and ingest failures."
      };
    case "ai":
      return {
        kicker: "Scenario drafting",
        title: "AI Scenario Assistant",
        description: "Generate guarded scenario drafts before human acceptance."
      };
    case "safety":
      return {
        kicker: "Governance",
        title: "Safety and providers",
        description: "Review synthetic-only controls, provider state and current operator notices."
      };
    case "overview":
    default:
      return {
        kicker: "Pilot control station",
        title: "Simulator overview",
        description: "Compact operational status across runtime, COP publishing and Flight Data."
      };
  }
}

function formatDuration(value: number): string {
  const totalSeconds = Math.max(0, Math.round(value));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatCoordinate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : "-";
}

function formatBbox(bbox: SituationDataConfig["defaultBbox"]): string {
  return `${formatCoordinate(bbox.west)}, ${formatCoordinate(bbox.south)}, ${formatCoordinate(bbox.east)}, ${formatCoordinate(bbox.north)}`;
}

function formatAltitude(value: number | undefined): string {
  return typeof value === "number" ? `${Math.round(value).toLocaleString("cs-CZ")} m` : "altitude n/a";
}

function formatTrackIdentity(track: FlightDataTrack): string {
  return track.callsign || track.registration || track.trackId.replace("flight:icao24:", "");
}

function formatTime(value: string | undefined): string {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat("cs-CZ", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function isAfter(candidate: string | undefined, baseline: string | undefined): boolean {
  if (!candidate) {
    return false;
  }
  if (!baseline) {
    return true;
  }
  return new Date(candidate).getTime() > new Date(baseline).getTime();
}

function formatPercent(part: number, total: number): string {
  if (total <= 0) {
    return "0%";
  }
  return `${Math.round((part / total) * 100)}%`;
}

function formatRate(value: number): string {
  return `${value.toLocaleString("cs-CZ")} Hz`;
}

function formatCadence(seconds: number): string {
  if (seconds >= 3600) {
    return `${Math.round(seconds / 3600)} h cadence`;
  }
  if (seconds >= 60) {
    return `${Math.round(seconds / 60)} min cadence`;
  }
  return `${seconds}s cadence`;
}

function formatGeo(geo: QueueItem["event"]["geo"]): string {
  if (!geo?.lat || !geo?.lon) {
    return "no position";
  }
  return `${geo.lat.toFixed(4)}, ${geo.lon.toFixed(4)}`;
}

function formatGeometry(feature: SituationDataFeature): string {
  if (feature.geometry.type !== "Point" || !Array.isArray(feature.geometry.coordinates)) {
    return feature.geometry.type;
  }
  const [lon, lat] = feature.geometry.coordinates;
  return typeof lon === "number" && typeof lat === "number" ? `${formatCoordinate(lat)}, ${formatCoordinate(lon)}` : "position n/a";
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}% confidence`;
}

function formatMetrics(metrics: SituationDataFeature["properties"]["metrics"]): string {
  if (!metrics) {
    return "metrics n/a";
  }
  const entries = Object.entries(metrics)
    .filter(([key]) => key !== "ageSeconds")
    .slice(0, 2);
  if (entries.length === 0) {
    return "metrics n/a";
  }
  return entries.map(([key, value]) => `${key} ${value}`).join(", ");
}

function formatMotion(speedMps: number | undefined, headingDeg: number | undefined): string {
  const speed = typeof speedMps === "number" ? `${Math.round(speedMps)} m/s (${Math.round(speedMps * 3.6)} km/h)` : "speed n/a";
  const heading = typeof headingDeg === "number" ? `${Math.round(headingDeg)} deg` : "heading n/a";
  return `${speed}, ${heading}`;
}

function countSituationLayer(features: SituationDataFeature[], layerId: SituationLayerId): number {
  return features.filter((feature) => feature.properties.layer === layerId).length;
}

function severityTone(value: SituationDataFeature["properties"]["severity"]): Tone {
  if (value === "critical") {
    return "danger";
  }
  if (value === "warning" || value === "advisory") {
    return "warn";
  }
  return "neutral";
}
