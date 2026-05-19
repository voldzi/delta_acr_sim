import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  CirclePause,
  CirclePlay,
  Clock3,
  Database,
  ExternalLink,
  FlaskConical,
  Gauge,
  Pause,
  Play,
  Plus,
  RadioTower,
  RotateCcw,
  Route,
  ShieldAlert,
  ShieldCheck,
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
import type { AiDraft, PublisherStatus, QueueItem, RuntimeStatus, Scenario, ScenarioBlock } from "./types";

type Tone = "safe" | "danger" | "active" | "neutral" | "warn";
type AffiliationCategory = "own" | "foreign" | "other";

interface DashboardData {
  scenarios: Scenario[];
  runtime: RuntimeStatus;
  publisher: PublisherStatus;
  queue: QueueItem[];
  queueTotalCount: number;
  blocks: ScenarioBlock[];
  providers: Array<{ id: string; enabled: boolean; external: boolean; healthy: boolean }>;
}

interface AffiliationSummaryItem {
  category: AffiliationCategory;
  label: string;
  value: number;
  detail: string;
}

const copDisplayUrl = "http://docker.home.cz:4311";
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

export function App() {
  const [data, setData] = useState<DashboardData>({
    scenarios: [],
    runtime: emptyRuntime,
    publisher: emptyPublisher,
    queue: [],
    queueTotalCount: 0,
    blocks: [],
    providers: []
  });
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>("");
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
  const activeScenarioName = selectedScenario?.name ?? "No scenario selected";
  const selectedScenarioState = scenarioDisplayState(selectedScenario, data.runtime);
  const activePublishFailure = isAfter(data.publisher.lastFailureAt, data.publisher.lastSuccessAt);

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
      tone: data.publisher.publishingEnabled ? (data.publisher.mode === "LIVE" ? "active" : "safe") : "danger",
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
    }
  ];

  const refresh = useCallback(async (preferredScenarioId?: string) => {
    const next = await loadDashboard();
    setData(next);
    setLastRefreshAt(new Date().toISOString());
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
          <a href="#readiness">
            <Gauge size={17} /> Readiness
          </a>
          <a href="#scenario">
            <Activity size={17} /> Scenario
          </a>
          <a href="#manifest">
            <Route size={17} /> Manifest
          </a>
          <a href="#publisher">
            <RadioTower size={17} /> Publisher
          </a>
          <a href="#ai">
            <Bot size={17} /> AI Assistant
          </a>
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
            <p className="eyebrow">Pilot control station</p>
            <h1>Simulator runtime</h1>
            <p>{activeScenarioName}</p>
          </div>
          <div className="topbar-actions">
            <a className="external-link" href={copDisplayUrl} target="_blank" rel="noreferrer">
              COP display <ExternalLink size={15} />
            </a>
            <StatusPill label={data.publisher.mode} tone={data.publisher.mode === "LIVE" ? "active" : "safe"} />
            <StatusPill label={data.runtime.state} tone={runtimeTone} />
          </div>
        </header>

        <section id="dashboard" className="metrics-grid" aria-label="Runtime metrics">
          <Metric icon={<Activity />} label="Generated events" value={data.runtime.generatedEvents} detail={`${data.runtime.tick ?? 0} ticks`} />
          <Metric icon={<RadioTower />} label="Delivered events" value={data.runtime.publishedEvents} detail={`${deliveryRate} delivery`} />
          <Metric icon={<Database />} label="Active tracks" value={data.runtime.activeObjects ?? totalObjects} detail={`${totalObjects} configured`} />
          <Metric icon={<Clock3 />} label="Simulation time" value={simulationClock} detail={`${effectiveSpeedMultiplier}x runtime speed`} />
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

        <section className="main-grid">
          <section id="scenario" className="panel scenario-panel">
            <PanelTitle icon={<CirclePlay />} title="Scenario execution" subtitle="Deterministic moving tracks for COP display validation." />

            <div className="control-row">
              <select value={selectedScenario?.scenarioId ?? ""} onChange={(event) => setSelectedScenarioId(event.target.value)}>
                {data.scenarios.length === 0 ? <option>No scenarios yet</option> : null}
                {data.scenarios.map((scenario) => (
                  <option key={scenario.scenarioId} value={scenario.scenarioId}>
                    {formatScenarioOption(scenario, data.runtime)}
                  </option>
                ))}
              </select>
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

            <div className="button-strip">
              <ActionButton
                icon={<Play />}
                label="Start"
                disabled={!selectedScenario || loading || isRunning}
                onClick={() =>
                  selectedScenario?.scenarioId &&
                  runAction("Scenario started. Moving tracks are published every second.", () =>
                    runtimeAction(selectedScenario.scenarioId!, "start", { speedMultiplier, tickIntervalSeconds: 1 })
                  )
                }
              />
              <ActionButton
                icon={<Pause />}
                label="Pause"
                disabled={!selectedScenario || loading || !isRunning}
                onClick={() => selectedScenario?.scenarioId && runAction("Scenario paused.", () => runtimeAction(selectedScenario.scenarioId!, "pause"))}
              />
              <ActionButton
                icon={<Play />}
                label="Resume"
                disabled={!selectedScenario || loading || !isPaused}
                onClick={() => selectedScenario?.scenarioId && runAction("Scenario resumed.", () => runtimeAction(selectedScenario.scenarioId!, "resume"))}
              />
              <ActionButton
                icon={<Square />}
                label="Stop"
                disabled={!selectedScenario || loading || (data.runtime.state !== "RUNNING" && data.runtime.state !== "PAUSED")}
                onClick={() => selectedScenario?.scenarioId && runAction("Scenario stopped.", () => runtimeAction(selectedScenario.scenarioId!, "stop"))}
              />
              <ActionButton
                icon={<RotateCcw />}
                label="Step"
                disabled={!selectedScenario || loading || isRunning}
                onClick={() =>
                  selectedScenario?.scenarioId &&
                  runAction("One deterministic movement step generated.", () => runtimeAction(selectedScenario.scenarioId!, "step"))
                }
              />
              <ActionButton
                icon={<Zap />}
                label="Fault"
                disabled={!selectedScenario || loading}
                onClick={() => selectedScenario?.scenarioId && runAction("Connectivity fault added.", () => addConnectivityFault(selectedScenario.scenarioId!))}
              />
            </div>

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

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusPill({ label, tone }: { label: string; tone: Tone }) {
  return <span className={`status-pill ${tone}`}>{label}</span>;
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
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
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

function formatScenarioOption(scenario: Scenario, runtime: RuntimeStatus): string {
  const state = scenarioDisplayState(scenario, runtime);
  const activePrefix = isActiveRuntimeScenario(scenario, runtime) ? "ACTIVE " : "";
  const objectCount = countScenarioObjects(scenario);
  const shortId = scenario.scenarioId ? scenario.scenarioId.slice(0, 8) : "new";
  return `${activePrefix}${state} - ${scenario.name} (${objectCount.toLocaleString("cs-CZ")} tracks, ${shortId})`;
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

function formatAffiliations(block: ScenarioBlock): string {
  const affiliations = readAffiliations(block);
  return affiliations.length > 0 ? affiliations.join(", ") : "UNKNOWN";
}

function runtimeStateTone(state: string): Tone {
  if (state === "RUNNING") {
    return "active";
  }
  if (state === "PAUSED" || state === "READY") {
    return "warn";
  }
  if (state === "ERROR") {
    return "danger";
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

function formatDuration(value: number): string {
  const totalSeconds = Math.max(0, Math.round(value));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
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

function formatGeo(geo: QueueItem["event"]["geo"]): string {
  if (!geo?.lat || !geo?.lon) {
    return "no position";
  }
  return `${geo.lat.toFixed(4)}, ${geo.lon.toFixed(4)}`;
}

function formatMotion(speedMps: number | undefined, headingDeg: number | undefined): string {
  const speed = typeof speedMps === "number" ? `${Math.round(speedMps)} m/s (${Math.round(speedMps * 3.6)} km/h)` : "speed n/a";
  const heading = typeof headingDeg === "number" ? `${Math.round(headingDeg)} deg` : "heading n/a";
  return `${speed}, ${heading}`;
}
