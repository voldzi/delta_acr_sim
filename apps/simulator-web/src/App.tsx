import {
  Activity,
  Bot,
  CirclePause,
  CirclePlay,
  Database,
  FlaskConical,
  Gauge,
  Pause,
  Play,
  Plus,
  RadioTower,
  RotateCcw,
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
  loadDashboard,
  runtimeAction,
  testPublisher
} from "./api";
import type { AiDraft, PublisherStatus, QueueItem, RuntimeStatus, Scenario, ScenarioBlock } from "./types";

interface DashboardData {
  scenarios: Scenario[];
  runtime: RuntimeStatus;
  publisher: PublisherStatus;
  queue: QueueItem[];
  blocks: ScenarioBlock[];
  providers: Array<{ id: string; enabled: boolean; external: boolean; healthy: boolean }>;
}

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
    blocks: [],
    providers: []
  });
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>("");
  const [aiPrompt, setAiPrompt] = useState("Create a 15 minute synthetic air situation latency test with aircraft, UAV and missile tracks.");
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const [notice, setNotice] = useState<string>("Ready in dry-run mode.");
  const [loading, setLoading] = useState(false);

  const selectedScenario = useMemo(
    () => data.scenarios.find((scenario) => scenario.scenarioId === selectedScenarioId) ?? data.scenarios[0],
    [data.scenarios, selectedScenarioId]
  );

  const refresh = useCallback(async () => {
    const next = await loadDashboard();
    setData(next);
    if (!selectedScenarioId && next.scenarios[0]?.scenarioId) {
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
      await action();
      setNotice(message);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Operation failed.");
    } finally {
      setLoading(false);
    }
  }

  const totalObjects = selectedScenario?.blocks.reduce((sum, block) => sum + (block.enabled ? block.objectCount : 0), 0) ?? 0;
  const syntheticQueueCount = data.queue.filter((item) => item.event.classification.handlingCaveats.includes("SYNTHETIC")).length;

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
          <a href="#dashboard">
            <Gauge size={17} /> Dashboard
          </a>
          <a href="#scenario">
            <Activity size={17} /> Scenario Control
          </a>
          <a href="#publisher">
            <RadioTower size={17} /> Publisher Monitor
          </a>
          <a href="#ai">
            <Bot size={17} /> AI Assistant
          </a>
        </nav>

        <div className="safety-panel">
          <ShieldCheck size={18} />
          <div>
            <strong>Synthetic-only gate</strong>
            <span>Publisher rejects events without SYNTHETIC marking.</span>
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>Simulator runtime</h1>
            <p>Standalone pilot for reproducible COP ingest tests.</p>
          </div>
          <div className="topbar-actions">
            <StatusPill label={data.publisher.mode} tone={data.publisher.mode === "LIVE" ? "danger" : "safe"} />
            <StatusPill label={data.runtime.state} tone={data.runtime.state === "RUNNING" ? "active" : "neutral"} />
          </div>
        </header>

        <section id="dashboard" className="metrics-grid" aria-label="Runtime metrics">
          <Metric icon={<Activity />} label="Generated events" value={data.runtime.generatedEvents} />
          <Metric icon={<RadioTower />} label="Published / validated" value={data.runtime.publishedEvents} />
          <Metric icon={<Database />} label="Publisher queue" value={data.publisher.queueSize} />
          <Metric icon={<ShieldCheck />} label="Synthetic queued" value={syntheticQueueCount} />
        </section>

        <section className="main-grid">
          <section id="scenario" className="panel scenario-panel">
            <PanelTitle icon={<CirclePlay />} title="Scenario control" subtitle="Create, run, step and fault-inject synthetic scenarios." />

            <div className="control-row">
              <select value={selectedScenario?.scenarioId ?? ""} onChange={(event) => setSelectedScenarioId(event.target.value)}>
                {data.scenarios.length === 0 ? <option>No scenarios yet</option> : null}
                {data.scenarios.map((scenario) => (
                  <option key={scenario.scenarioId} value={scenario.scenarioId}>
                    {scenario.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() =>
                  runAction("Demo scenario created.", async () => {
                    const created = await createScenario(demoScenario);
                    setSelectedScenarioId(created.scenarioId);
                  })
                }
                disabled={loading}
              >
                <Plus size={16} /> Demo
              </button>
            </div>

            {selectedScenario ? (
              <div className="scenario-summary">
                <div>
                  <span>Name</span>
                  <strong>{selectedScenario.name}</strong>
                </div>
                <div>
                  <span>Duration</span>
                  <strong>{Math.round(selectedScenario.durationSeconds / 60)} min</strong>
                </div>
                <div>
                  <span>Objects</span>
                  <strong>{totalObjects}</strong>
                </div>
                <div>
                  <span>Seed</span>
                  <strong>{selectedScenario.seed}</strong>
                </div>
              </div>
            ) : (
              <div className="empty-state">Create the demo scenario to start the pilot runtime.</div>
            )}

            <div className="button-strip">
              <ActionButton icon={<Play />} label="Start" disabled={!selectedScenario || loading} onClick={() => selectedScenario?.scenarioId && runAction("Scenario started in dry-run mode.", () => runtimeAction(selectedScenario.scenarioId!, "start"))} />
              <ActionButton icon={<Pause />} label="Pause" disabled={!selectedScenario || loading} onClick={() => selectedScenario?.scenarioId && runAction("Scenario paused.", () => runtimeAction(selectedScenario.scenarioId!, "pause"))} />
              <ActionButton icon={<Play />} label="Resume" disabled={!selectedScenario || loading} onClick={() => selectedScenario?.scenarioId && runAction("Scenario resumed.", () => runtimeAction(selectedScenario.scenarioId!, "resume"))} />
              <ActionButton icon={<Square />} label="Stop" disabled={!selectedScenario || loading} onClick={() => selectedScenario?.scenarioId && runAction("Scenario stopped.", () => runtimeAction(selectedScenario.scenarioId!, "stop"))} />
              <ActionButton icon={<RotateCcw />} label="Step" disabled={!selectedScenario || loading} onClick={() => selectedScenario?.scenarioId && runAction("One deterministic step generated.", () => runtimeAction(selectedScenario.scenarioId!, "step"))} />
              <ActionButton icon={<Zap />} label="Fault" disabled={!selectedScenario || loading} onClick={() => selectedScenario?.scenarioId && runAction("Connectivity fault added.", () => addConnectivityFault(selectedScenario.scenarioId!))} />
            </div>

            <div className="block-list">
              {data.blocks.map((block) => (
                <div key={block.blockId} className="block-row">
                  <span>{block.blockId}</span>
                  <strong>{block.objectCount} objects</strong>
                  <em>{block.updateRateHz} Hz</em>
                </div>
              ))}
            </div>
          </section>

          <section id="publisher" className="panel">
            <PanelTitle icon={<RadioTower />} title="Publisher monitor" subtitle="Dry-run validation, queue state and synthetic payload preview." />
            <div className="publisher-status">
              <StatusPill label={data.publisher.publishingEnabled ? "publishing enabled" : "publishing stopped"} tone={data.publisher.publishingEnabled ? "safe" : "danger"} />
              <span>{data.publisher.deadLetterSize} dead-letter</span>
            </div>
            <div className="button-strip compact">
              <button type="button" onClick={() => runAction("Publisher connection checked.", testPublisher)} disabled={loading}>
                <FlaskConical size={16} /> Test connection
              </button>
              <button type="button" onClick={() => runAction("Queue cleared.", clearQueue)} disabled={loading || data.queue.length === 0}>
                <Trash2 size={16} /> Clear queue
              </button>
            </div>
            <div className="queue-list">
              {data.queue.slice(0, 8).map((item) => (
                <div key={item.queueId} className="queue-row">
                  <div>
                    <strong>{item.event.payload.objectId}</strong>
                    <span>{item.event.eventType} · {item.event.simulation.blockId}</span>
                  </div>
                  <StatusPill label={item.state} tone={item.state === "DEAD_LETTER" ? "danger" : "neutral"} />
                </div>
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

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return (
    <div className="metric">
      <div className="metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value.toLocaleString("cs-CZ")}</strong>
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

function StatusPill({ label, tone }: { label: string; tone: "safe" | "danger" | "active" | "neutral" }) {
  return <span className={`status-pill ${tone}`}>{label}</span>;
}

function ActionButton({ icon, label, disabled, onClick }: { icon: ReactNode; label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}>
      {icon} {label}
    </button>
  );
}
