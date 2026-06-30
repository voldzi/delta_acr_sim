import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  CirclePause,
  CirclePlay,
  CloudSun,
  Cpu,
  Database,
  Download,
  ExternalLink,
  FlaskConical,
  Gauge,
  Info,
  KeyRound,
  Layers3,
  LockKeyhole,
  LogOut,
  MapPinned,
  Network,
  Pause,
  Plane,
  Play,
  Plus,
  RadioTower,
  RotateCcw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Signal,
  Settings2,
  Square,
  TimerReset,
  Trash2,
  TrendingUp,
  X,
  Zap
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from "react";
import {
  acceptAiDraft,
  addConnectivityFault,
  clearQueue,
  clearSimApiToken,
  createAiDraft,
  createScenario,
  demoScenario,
  denseDemoScenario,
  hasSimAuthorizationToken,
  hasSimApiToken,
  loadDashboard,
  onSimApiAuthChange,
  runtimeAction,
  setSimAuthorizationTokenProvider,
  setSimManualTokenUsageEnabled,
  setSimApiToken,
  testPublisher,
  ukraineAirDefenseDemoScenario
} from "./api";
import {
  beginLogin,
  createInitialAuthSession,
  endSession,
  initializeAuth,
  isOidcEnabled,
  readAuthConfig,
  type AuthSession,
  type SimRole
} from "./auth";
import type {
  AiDraft,
  DashboardObservability,
  OperationsSummary,
  OperationsSummaryService,
  ServiceObservability,
  CacheObservability,
  FlightDataConfig,
  FlightDataHealth,
  FlightDataSource,
  FlightDataTrack,
  FlightDataTrackResponse,
  PublisherStatus,
  QueueItem,
  RuntimeStatus,
  SafetyDataConfig,
  SafetyDataFeature,
  SafetyDataFeatureResponse,
  SafetyDataHealth,
  SafetyDataLayer,
  SafetyDataSource,
  SafetyLayerId,
  Scenario,
  ScenarioBlock,
  SituationDataConfig,
  SituationDataFeature,
  SituationDataFeatureResponse,
  SituationDataHealth,
  SituationDataLayer,
  SituationDataSource,
  SituationLayerId,
  TakGatewayConfig,
  TakGatewayFeature,
  TakGatewayFeatureResponse,
  TakGatewayHealth,
  TakGatewayLayer,
  TakGatewaySource,
  TakLayerId
} from "./types";
import { readInitialUiLanguage, storeUiLanguage, translateUi, type UiLanguage } from "./i18n";

type Tone = "safe" | "danger" | "active" | "neutral" | "warn";
type AffiliationCategory = "own" | "foreign" | "other";
type AppSection = "overview" | "scenario" | "flight-data" | "situation-data" | "tak-gateway" | "publisher" | "ai" | "safety";

interface DashboardData {
  operations: OperationsSummary;
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
  safetyData: {
    health: SafetyDataHealth;
    layers: SafetyDataLayer[];
    sources: SafetyDataSource[];
    config: SafetyDataConfig;
    features: SafetyDataFeatureResponse;
  };
  takGateway: {
    health: TakGatewayHealth;
    layers: TakGatewayLayer[];
    sources: TakGatewaySource[];
    config: TakGatewayConfig;
    features: TakGatewayFeatureResponse;
  };
  observability: DashboardObservability;
  warnings: string[];
}

interface AffiliationSummaryItem {
  category: AffiliationCategory;
  label: string;
  value: number;
  detail: string;
}

interface LiveTelemetry {
  generatedPerMinute: number;
  publishedPerMinute: number;
  dataDeltaPerMinute: number;
  loadPercent: number;
  trend: "warming" | "steady" | "active";
}

interface TelemetrySample {
  at: number;
  generatedEvents: number;
  publishedEvents: number;
  dataProducts: number;
}

interface OverviewChannel {
  id: string;
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  load: number;
  tone: Tone;
}

interface CacheDisplay {
  coalescedHits?: number;
  entries?: number;
  errors?: number;
  evictions?: number;
  hitRate?: number;
  hits?: number;
  inflight?: number;
  lastErrorAt?: string;
  lastSuccessAt?: string;
  maxEntries?: number;
  misses?: number;
  pressure?: number;
  refreshes?: number;
  staleHits?: number;
  state?: string;
}

interface NoticeState {
  params?: Record<string, string>;
  source: string;
}

const copDisplayUrl = import.meta.env.VITE_COP_DISPLAY_URL ?? "https://cop.zeleznalady.cz";
const ownAffiliations = new Set(["FRIEND", "ASSUMED_FRIEND"]);
const foreignAffiliations = new Set(["HOSTILE", "SUSPECT"]);
const operatorTokenRequiredNotice = "Operator token required. Enter the SIM API token in the top bar to start, stop or create scenarios.";
const invalidOperatorTokenNotice = "Operator token is missing or invalid. Check Keycloak role or SIM fallback token.";
const simRoleLabels: Record<SimRole, string> = {
  SIM_ADMIN: "Admin",
  SIM_OPERATOR: "Operator",
  SIM_VIEWER: "Viewer",
  SIM_AI_USER: "AI user",
  SIM_AI_ADMIN: "AI admin"
};

function createNotice(source: string, params?: Record<string, string>): NoticeState {
  return { source, params };
}

function renderNotice(notice: NoticeState, tr: (source: string) => string): string {
  let message = tr(notice.source);
  for (const [key, value] of Object.entries(notice.params ?? {})) {
    message = message.replaceAll(`{${key}}`, value);
  }
  return message;
}

function noticeFromError(error: unknown, fallbackSource = "Operation failed."): NoticeState {
  if (!(error instanceof Error)) {
    return createNotice(fallbackSource);
  }
  if (error.message.includes("Missing or invalid bearer token")) {
    return createNotice(invalidOperatorTokenNotice);
  }
  return createNotice(error.message || fallbackSource);
}

const UiLanguageContext = createContext<UiLanguage>("cs");
const NumberLocaleContext = createContext<string>("cs-CZ");

function useUiText(): (source: string) => string {
  const language = useContext(UiLanguageContext);
  return useCallback((source: string) => translateUi(language, source), [language]);
}

function useUiLanguage(): UiLanguage {
  return useContext(UiLanguageContext);
}

function useNumberLocale(): string {
  return useContext(NumberLocaleContext);
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

const emptyFlightTracks: FlightDataTrackResponse = {
  contractVersion: "flight-track-response-v1",
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

const emptySafetyFeatures: SafetyDataFeatureResponse = {
  contractVersion: "cop-safety-source-v1",
  type: "FeatureCollection",
  generatedAt: new Date(0).toISOString(),
  source: {
    sourceId: "safety-data-api",
    sourceType: "PUBLIC_SAFETY_AGGREGATE",
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
    advisoryCount: 0,
    warningCount: 0,
    criticalCount: 0
  },
  features: [],
  sources: [],
  warnings: []
};

const emptyTakFeatures: TakGatewayFeatureResponse = {
  contractVersion: "cop-tak-source-v1",
  type: "FeatureCollection",
  generatedAt: new Date(0).toISOString(),
  source: {
    sourceId: "tak-gateway-api",
    sourceType: "TAK_COT_GATEWAY",
    generatedAt: new Date(0).toISOString()
  },
  query: {
    bbox: { west: 0, south: 0, east: 0, north: 0 },
    layers: [],
    limit: 0
  },
  summary: {
    eventCount: 0,
    featureCount: 0,
    sourceCount: 0,
    staleFeatureCount: 0,
    warningCount: 0,
    affiliationCounts: {
      friend: 0,
      hostile: 0,
      neutral: 0,
      unknown: 0
    }
  },
  features: [],
  sources: [],
  warnings: []
};

const emptyObservability: DashboardObservability = {
  generatedAt: new Date(0).toISOString(),
  loadDurationMs: 0,
  flightData: emptyTimedObservability("flight-data-api"),
  situationData: emptyTimedObservability("situation-data-api"),
  safetyData: emptyTimedObservability("safety-data-api"),
  takGateway: emptyTimedObservability("tak-gateway-api")
};

const emptyOperations: OperationsSummary = {
  alerts: [],
  contractVersion: "sim-operations-summary-v1",
  deployment: {
    adapterVersion: "-",
    publisherMode: "DRY_RUN",
    sourceSystemId: "-"
  },
  generatedAt: new Date(0).toISOString(),
  publisher: emptyPublisher,
  runtime: emptyRuntime,
  scenarios: {
    active: 0,
    draft: 0,
    paused: 0,
    ready: 0,
    running: 0,
    stopped: 0,
    total: 0
  },
  services: [],
  status: "unknown"
};

export function App() {
  const authConfig = useMemo(() => readAuthConfig(), []);
  const oidcEnabled = isOidcEnabled(authConfig);
  const manualTokenLoginAllowed = !oidcEnabled || authConfig.allowManualTokenLogin;
  const [authSession, setAuthSession] = useState<AuthSession>(() => createInitialAuthSession(authConfig));
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>(() => readInitialUiLanguage());
  const tr = useCallback((source: string) => translateUi(uiLanguage, source), [uiLanguage]);
  const numberLocale = uiLanguage === "cs" ? "cs-CZ" : "en-US";
  const [data, setData] = useState<DashboardData>({
    operations: emptyOperations,
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
        staleIfErrorSeconds: 0,
        cacheMaxEntries: 0,
        staleAfterSeconds: 0,
        requestTimeoutMs: 0,
        providers: []
      },
      tracks: emptyFlightTracks
    },
    situationData: {
      health: { status: "unknown", enabledSources: [], sourceHealth: [] },
      layers: [],
      sources: [],
      config: {
        enabledSources: [],
        defaultBbox: { west: 0, south: 0, east: 0, north: 0 },
        cacheTtlSeconds: 0,
        staleIfErrorSeconds: 0,
        cacheMaxEntries: 0,
        sharedCache: { enabled: false, backend: "memory", keyPrefix: "-", connectTimeoutMs: 0 },
        bboxCachePaddingDegrees: 0,
        staleAfterSeconds: 0,
        requestTimeoutMs: 0,
        sourceCacheTtlSeconds: {
          openMeteo: 0,
          metNorway: 0,
          mobileNetwork: 0,
          mobileCoverage: 0,
          osmPostgis: 0,
          osmOverpass: 0,
          ctuStationaryMobile: 0,
          pidGtfsRt: 0,
          pidGtfsStatic: 0,
          publicTransitStatic: 0,
          idsjmkVehiclePositions: 0,
          spravaZeleznicTrains: 0,
          roadSrtiLod: 0,
          safetyData: 0,
          aviationWeather: 0,
          chmiAirQuality: 0,
          chmiWeatherStations: 0,
          chmiWeatherRadar: 0,
          chmiWeatherWebcams: 0,
          ardosPartner: 0,
          radioPlanning: 0
        },
        providers: []
      },
      features: emptySituationFeatures
    },
    safetyData: {
      health: { status: "unknown", enabledSources: [] },
      layers: [],
      sources: [],
      config: {
        enabledSources: [],
        defaultBbox: { west: 0, south: 0, east: 0, north: 0 },
        cacheTtlSeconds: 0,
        staleIfErrorSeconds: 0,
        cacheMaxEntries: 0,
        staleAfterSeconds: 0,
        requestTimeoutMs: 0,
        hydroMaxStations: 0,
        providers: []
      },
      features: emptySafetyFeatures
    },
    takGateway: {
      health: {
        status: "unknown",
        ingestAuthConfigured: false,
        readAuthConfigured: false,
        publicRead: false,
        currentEvents: 0,
        staleEvents: 0
      },
      layers: [],
      sources: [],
      config: {
        defaultBbox: { west: 0, south: 0, east: 0, north: 0 },
        staleAfterSeconds: 0,
        retentionSeconds: 0,
        maxEvents: 0,
        exposeRaw: false,
        ingestAuthConfigured: false,
        readAuthConfigured: false,
        publicRead: false,
        sourceLabel: ""
      },
      features: emptyTakFeatures
    },
    observability: emptyObservability,
    warnings: []
  });
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>("");
  const [activeSection, setActiveSection] = useState<AppSection>("overview");
  const [aiPrompt, setAiPrompt] = useState("Create a 15 minute synthetic air situation latency test with aircraft, UAV and missile tracks.");
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const [notice, setNotice] = useState<NoticeState>(() => createNotice("Ready for continuous synthetic movement."));
  const changeUiLanguage = useCallback((language: UiLanguage) => {
    setUiLanguage(language);
    storeUiLanguage(language);
  }, []);
  const [loading, setLoading] = useState(false);
  const [speedMultiplier, setSpeedMultiplier] = useState(1);
  const [lastRefreshAt, setLastRefreshAt] = useState<string>();
  const [apiTokenConfigured, setApiTokenConfigured] = useState(() => Boolean(authSession.accessToken) || (manualTokenLoginAllowed && hasSimAuthorizationToken()));
  const [manualTokenConfigured, setManualTokenConfigured] = useState(() => manualTokenLoginAllowed && hasSimApiToken());
  const [apiTokenInput, setApiTokenInput] = useState("");
  const [mobileNetworkInfoOpen, setMobileNetworkInfoOpen] = useState(false);
  const telemetrySampleRef = useRef<TelemetrySample | undefined>(undefined);
  const [liveTelemetry, setLiveTelemetry] = useState<LiveTelemetry>({
    generatedPerMinute: 0,
    publishedPerMinute: 0,
    dataDeltaPerMinute: 0,
    loadPercent: 0,
    trend: "steady"
  });

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
  const tokenAccessReady = manualTokenLoginAllowed && apiTokenConfigured && (!oidcEnabled || authSession.status !== "authenticated");
  const authenticatedRoles = authSession.status === "authenticated" ? authSession.roles ?? [] : [];
  const hasViewerRole = roleAllows(authenticatedRoles, "SIM_VIEWER");
  const hasOperatorRole = roleAllows(authenticatedRoles, "SIM_OPERATOR");
  const hasAdminRole = roleAllows(authenticatedRoles, "SIM_ADMIN");
  const hasAiRole = roleAllows(authenticatedRoles, "SIM_AI_USER");
  const hasAiAdminRole = roleAllows(authenticatedRoles, "SIM_AI_ADMIN");
  const protectedSectionsUnlocked = oidcEnabled ? hasViewerRole || tokenAccessReady : apiTokenConfigured;
  const canReadDashboard = authConfig.publicReadEnabled || protectedSectionsUnlocked;
  const canManageScenarios = tokenAccessReady || hasOperatorRole || hasAdminRole;
  const canAdministerPublisher = tokenAccessReady || hasAdminRole;
  const canUseAiAssistant = tokenAccessReady || hasAiRole || hasAiAdminRole || hasAdminRole;
  const visibleSection = protectedSectionsUnlocked ? activeSection : "overview";
  const protectedSectionNoticeSource = oidcEnabled
    ? "Sign in with Keycloak using a SIM viewer, operator or admin role to access protected details."
    : "Enter a valid SIM API token to access scenario control and source details.";
  const operatorAuthRequiredNoticeSource = oidcEnabled
    ? "Login with Keycloak using csm-sim-operator or csm-sim-admin role."
    : operatorTokenRequiredNotice;
  const protectedSectionNotice = tr(protectedSectionNoticeSource);
  const operatorAuthRequiredNotice = tr(operatorAuthRequiredNoticeSource);
  const renderedNotice = renderNotice(notice, tr);
  const noticeIsWarning = /required|invalid|failed|degraded|missing|error|vyžad|neplat|selhal|zhorš|chyb|varov/i.test(renderedNotice);
  const activePublishFailure = isAfter(data.publisher.lastFailureAt, data.publisher.lastSuccessAt);
  const flightDataTone: Tone = data.flightData.health.status === "ok" ? (data.flightData.tracks.warnings.length > 0 ? "warn" : "safe") : "danger";
  const situationDataTone: Tone =
    data.situationData.health.status === "ok" ? (data.situationData.features.warnings.length > 0 ? "warn" : "safe") : "danger";
  const osmPostgisHealth = data.situationData.health.sourceHealth?.find((source) => source.sourceId === "osm_postgis");
  const safetyDataTone: Tone =
    data.safetyData.health.status === "ok" ? (data.safetyData.features.warnings.length > 0 ? "warn" : "safe") : "danger";
  const takGatewayTone: Tone =
    data.takGateway.health.status === "ok"
      ? data.takGateway.features.warnings.length > 0 || data.takGateway.health.staleEvents > 0
        ? "warn"
        : "safe"
      : "danger";
  const operatorActionDisabled = loading || !canManageScenarios || !apiTokenConfigured;
  const elevatedSafetyCount =
    data.safetyData.features.summary.advisoryCount +
    data.safetyData.features.summary.warningCount +
    data.safetyData.features.summary.criticalCount;
  const safetyLastResult = data.observability.safetyData.payload.lastResult;
  const safetyGeneratedAgeSeconds = safetyLastResult?.generatedAgeSeconds ?? secondsSinceIso(data.safetyData.features.generatedAt);
  const safetyLayerCounts = {
    weather_alerts:
      (safetyLastResult?.layerCounts?.weather_alerts ?? countSafetyLayer(data.safetyData.features.features, "weather_alerts")) +
      (safetyLastResult?.layerCounts?.warnings ?? countSafetyLayer(data.safetyData.features.features, "warnings")),
    fire: safetyLastResult?.layerCounts?.fire ?? countSafetyLayer(data.safetyData.features.features, "fire"),
    flood: safetyLastResult?.layerCounts?.flood ?? countSafetyLayer(data.safetyData.features.features, "flood"),
    boundary_admin: safetyLastResult?.layerCounts?.boundary_admin ?? countSafetyLayer(data.safetyData.features.features, "boundary_admin")
  };
  const safetyResponseWarningCount = safetyLastResult?.responseWarningCount ?? data.safetyData.features.warnings.length;
  const safetySourceCacheSummary = summarizeCacheObservability((data.observability.safetyData.payload.sourceCaches ?? []).map((item) => item.cache));
  const safetySourceCacheChannels: Array<{ label: string; value: string; detail: string; load: number; tone: Tone }> = (data.observability.safetyData.payload.sourceCaches ?? []).map((item) => {
    const source = data.safetyData.sources.find((candidate) => candidate.sourceId === item.sourceId);
    return {
      label: source?.label ?? item.sourceId,
      value: formatPercentValue(item.cache.hitRate),
      detail: `${item.cache.hits.toLocaleString(numberLocale)} ${tr("hits")}, ${item.cache.misses.toLocaleString(numberLocale)} ${tr("misses")}, ${item.cache.errors.toLocaleString(numberLocale)} ${tr("errors")}`,
      load: item.cache.hitRate * 100,
      tone: item.cache.errors > 0 ? "danger" : item.cache.hitRate >= 0.75 ? "safe" : item.cache.misses > 0 ? "warn" : "neutral"
    };
  });
  const safetyCacheChannels =
    safetySourceCacheChannels.length > 0
      ? safetySourceCacheChannels
      : [
          {
            label: "Source cache",
            value: "cold",
            detail: tr("source-level cache will warm after the first non-mock query"),
            load: 12,
            tone: "neutral" as Tone
          }
        ];
  const liveDataProducts =
    data.flightData.tracks.summary.deduplicatedTrackCount +
    data.situationData.features.summary.featureCount +
    data.safetyData.features.summary.featureCount +
    data.takGateway.features.summary.featureCount +
    data.takGateway.health.currentEvents;
  const enabledSourceCount =
    data.flightData.sources.filter((source) => source.enabled).length +
    data.situationData.sources.filter((source) => source.enabled).length +
    data.safetyData.sources.filter((source) => source.enabled).length +
    data.takGateway.sources.filter((source) => source.enabled).length;
  const healthyProviderCount =
    data.providers.filter((provider) => provider.enabled && provider.healthy).length +
    (data.flightData.health.status === "ok" ? 1 : 0) +
    (data.situationData.health.status === "ok" ? 1 : 0) +
    (data.safetyData.health.status === "ok" ? 1 : 0) +
    (data.takGateway.health.status === "ok" ? 1 : 0);
  const warningCount =
    data.warnings.length +
    data.flightData.tracks.warnings.length +
    data.situationData.features.warnings.length +
    data.safetyData.features.warnings.length +
    data.takGateway.features.warnings.length +
    (data.situationData.health.sourceHealth ?? []).reduce((sum, source) => sum + source.warnings.length, 0);
  const cacheMaxEntries = data.flightData.config.cacheMaxEntries + data.situationData.config.cacheMaxEntries + data.safetyData.config.cacheMaxEntries;
  const cacheTtlValues = [
    data.flightData.config.cacheTtlSeconds,
    data.situationData.config.cacheTtlSeconds,
    data.safetyData.config.cacheTtlSeconds,
    ...Object.values(data.situationData.config.sourceCacheTtlSeconds)
  ].filter((value) => value > 0);
  const cacheProtectionScore = estimateCacheProtectionScore(cacheMaxEntries, cacheTtlValues);
  const aggregateCacheSummary = summarizeCacheObservability([
    data.observability.flightData.payload.cache,
    data.observability.situationData.payload.cache,
    data.observability.safetyData.payload.cache
  ]);
  const sourceCacheSummary = summarizeCacheObservability([
    ...(data.observability.flightData.payload.sourceCaches ?? []).map((item) => item.cache),
    ...(data.observability.flightData.payload.referenceCaches ?? []).map((item) => item.cache),
    ...(data.observability.situationData.payload.sourceCaches ?? []).map((item) => item.cache),
    ...(data.observability.safetyData.payload.sourceCaches ?? []).map((item) => item.cache)
  ]);
  const effectiveCacheHitRate = Math.max(aggregateCacheSummary.hitRate, sourceCacheSummary.hitRate);
  const sharedCache = data.observability.situationData.payload.sharedCache;
  const sharedCacheTone: Tone =
    sharedCache?.enabled && sharedCache.available && sharedCache.errors === 0 ? "safe" : sharedCache?.enabled ? "warn" : "neutral";
  const sharedCacheValue = sharedCache?.enabled ? (sharedCache.available ? tr("available") : tr("degraded")) : tr("local only");
  const observabilityLatencies = [
    data.observability.flightData.latencyMs,
    data.observability.situationData.latencyMs,
    data.observability.safetyData.latencyMs,
    data.observability.takGateway.latencyMs
  ].filter((value) => value > 0);
  const maxObservabilityLatencyMs = observabilityLatencies.length > 0 ? Math.max(...observabilityLatencies) : data.observability.loadDurationMs;
  const importFreshness = summarizeImportFreshness([
    data.observability.flightData.payload,
    data.observability.situationData.payload,
    data.observability.safetyData.payload,
    data.observability.takGateway.payload
  ]);
  const telemetryChannels = [
    {
      label: "Cache hit-rate",
      value: formatPercentValue(effectiveCacheHitRate),
      detail: `${aggregateCacheSummary.requests.toLocaleString(numberLocale)} ${tr("aggregate")} / ${sourceCacheSummary.requests.toLocaleString(numberLocale)} ${tr("source requests")}`,
      load: effectiveCacheHitRate * 100,
      tone: effectiveCacheHitRate >= 0.75 ? "safe" : effectiveCacheHitRate >= 0.35 ? "warn" : "neutral"
    },
    {
      label: "Overview latency",
      value: formatLatencyMs(data.observability.loadDurationMs),
      detail: `${tr("slowest probe")} ${formatLatencyMs(maxObservabilityLatencyMs)}`,
      load: 100 - boundedPercent(maxObservabilityLatencyMs, 1800),
      tone: maxObservabilityLatencyMs <= 500 ? "safe" : maxObservabilityLatencyMs <= 1500 ? "warn" : "danger"
    },
    {
      label: "Import freshness",
      value: importFreshness.value,
      detail: importFreshness.detail,
      load: importFreshness.load,
      tone: importFreshness.tone
    },
    {
      label: "Shared cache",
      value: sharedCacheValue,
      detail: sharedCache ? `${formatPercentValue(sharedCache.hitRate)} ${tr("hit-rate")}, ${sharedCache.writes.toLocaleString(numberLocale)} ${tr("writes")}` : tr("no shared cache configured"),
      load: sharedCache?.enabled ? (sharedCache.available ? 92 : 45) : 28,
      tone: sharedCacheTone
    }
  ] satisfies Array<{ label: string; value: string; detail: string; load: number; tone: Tone }>;
  const overviewChannels: OverviewChannel[] = [
    {
      id: "flight",
      icon: <Plane />,
      label: "Flight stream",
      value: `${data.flightData.tracks.summary.deduplicatedTrackCount.toLocaleString(numberLocale)} ${tr("tracks")}`,
      detail: `${data.flightData.health.enabledSources.length} ${tr("enabled sources")}`,
      load: boundedPercent(data.flightData.tracks.summary.deduplicatedTrackCount, 80),
      tone: flightDataTone
    },
    {
      id: "situation",
      icon: <Layers3 />,
      label: "Situation feed",
      value: `${data.situationData.features.summary.featureCount.toLocaleString(numberLocale)} ${tr("features")}`,
      detail: `${data.situationData.health.enabledSources.length} ${tr("enabled sources")} · ${formatLatencyMs(data.observability.situationData.latencyMs)}`,
      load: boundedPercent(data.situationData.features.summary.featureCount, 120),
      tone: situationDataTone
    },
    {
      id: "safety",
      icon: <ShieldAlert />,
      label: "Safety feed",
      value: `${data.safetyData.features.summary.featureCount.toLocaleString(numberLocale)} ${tr("features")}`,
      detail: `${elevatedSafetyCount.toLocaleString(numberLocale)} ${tr("elevated signals")}`,
      load: boundedPercent(elevatedSafetyCount + data.safetyData.features.summary.featureCount, 80),
      tone: safetyDataTone
    },
    {
      id: "tak",
      icon: <RadioTower />,
      label: "TAK gateway",
      value: `${data.takGateway.health.currentEvents.toLocaleString(numberLocale)} ${tr("events")}`,
      detail: `${data.takGateway.health.staleEvents.toLocaleString(numberLocale)} ${tr("stale events")}`,
      load: boundedPercent(data.takGateway.health.currentEvents, Math.max(1, data.takGateway.config.maxEvents || 100)),
      tone: takGatewayTone
    },
    {
      id: "publisher",
      icon: <Signal />,
      label: "COP publisher",
      value: `${data.publisher.queueSize.toLocaleString(numberLocale)} ${tr("queued")}`,
      detail: `${deliveryRate} ${tr("delivery")}, ${formatDeadLetterCount(data.publisher.deadLetterSize, numberLocale, tr)}`,
      load: Math.max(boundedPercent(data.publisher.queueSize, 80), data.publisher.deadLetterSize > 0 ? 82 : 0),
      tone: queueTone
    }
  ];
  const cacheChannels = [
    {
      label: "Aggregate cache",
      value: formatPercentValue(aggregateCacheSummary.hitRate),
      detail: `${aggregateCacheSummary.hits.toLocaleString(numberLocale)} ${tr("hits")}, ${aggregateCacheSummary.misses.toLocaleString(numberLocale)} ${tr("misses")}`,
      load: aggregateCacheSummary.hitRate * 100,
      tone: aggregateCacheSummary.hitRate >= 0.75 ? "safe" : aggregateCacheSummary.hitRate >= 0.35 ? "warn" : "neutral"
    },
    {
      label: "Source cache",
      value: formatPercentValue(sourceCacheSummary.hitRate),
      detail: `${sourceCacheSummary.hits.toLocaleString(numberLocale)} ${tr("hits")}, ${sourceCacheSummary.misses.toLocaleString(numberLocale)} ${tr("misses")}`,
      load: sourceCacheSummary.hitRate * 100,
      tone: sourceCacheSummary.hitRate >= 0.75 ? "safe" : sourceCacheSummary.hitRate >= 0.35 ? "warn" : "neutral"
    },
    {
      label: "Stale-if-error",
      value: `${Math.max(data.flightData.config.staleIfErrorSeconds, data.situationData.config.staleIfErrorSeconds, data.safetyData.config.staleIfErrorSeconds).toLocaleString(numberLocale)}s`,
      detail: "continues serving cached data during upstream outage",
      load: boundedPercent(Math.max(data.flightData.config.staleIfErrorSeconds, data.situationData.config.staleIfErrorSeconds, data.safetyData.config.staleIfErrorSeconds), 1800),
      tone: "safe"
    },
    {
      label: "Cache capacity",
      value: `${cacheProtectionScore}% ${tr("shield")}`,
      detail: `${cacheMaxEntries.toLocaleString(numberLocale)} ${tr("configured entries")}, ${cacheTtlValues.length} ${tr("TTL guards")}`,
      load: cacheProtectionScore,
      tone: cacheProtectionScore >= 75 ? "safe" : cacheProtectionScore >= 45 ? "warn" : "danger"
    }
  ] satisfies Array<{ label: string; value: string; detail: string; load: number; tone: Tone }>;
  const activeSectionMeta = sectionMeta(visibleSection, tr);
  const authRoleSummary =
    authSession.status === "authenticated"
      ? authenticatedRoles.length > 0
        ? authenticatedRoles.map((role) => tr(simRoleLabels[role])).join(" / ")
        : tr("No SIM role")
      : authConfig.publicReadEnabled
        ? tr("Public read")
        : tr("Login required");
  const showTopbarOidcAction = oidcEnabled && (authSession.status === "authenticated" || canReadDashboard);

  const readinessItems = [
    {
      icon: <CirclePlay />,
      label: "Runtime",
      value: data.runtime.state,
      tone: runtimeTone,
      detail: `${data.runtime.tick ?? 0} ${tr("ticks")}, ${simulationClock} ${tr("elapsed")}`
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
      value: `${data.publisher.queueSize} ${tr("active")}`,
      tone: queueTone,
      detail: `${formatDeadLetterCount(data.publisher.deadLetterSize, numberLocale, tr)}, ${data.queueTotalCount} ${tr("retained")}`
    },
    {
      icon: activePublishFailure ? <AlertTriangle /> : <CheckCircle2 />,
      label: "Last publish",
      value: formatTime(data.publisher.lastSuccessAt),
      tone: activePublishFailure ? "danger" : data.publisher.lastSuccessAt ? "safe" : "neutral",
      detail: activePublishFailure
        ? `${tr("failure")} ${formatTime(data.publisher.lastFailureAt)}`
        : data.publisher.lastSuccessAt
          ? "latest delivery succeeded"
          : "no publish attempts yet"
    },
    {
      icon: <Plane />,
      label: "Flight Data",
      value: data.flightData.health.status.toUpperCase(),
      tone: flightDataTone,
      detail: `${data.flightData.tracks.summary.deduplicatedTrackCount} ${tr("dedup tracks")}, ${data.flightData.config.enabledSources.join(", ") || tr("no source")}`
    },
    {
      icon: <Layers3 />,
      label: "Situation Data",
      value: data.situationData.health.status.toUpperCase(),
      tone: situationDataTone,
      detail: `${data.situationData.features.summary.featureCount} ${tr("features")}, ${data.situationData.config.enabledSources.join(", ") || tr("no source")}`
    },
    {
      icon: <ShieldAlert />,
      label: "Safety Data",
      value: data.safetyData.health.status.toUpperCase(),
      tone: safetyDataTone,
      detail: `${data.safetyData.features.summary.featureCount} ${tr("features")}, ${data.safetyData.config.enabledSources.join(", ") || tr("no source")}`
    },
    {
      icon: <RadioTower />,
      label: "TAK Gateway",
      value: data.takGateway.health.status.toUpperCase(),
      tone: takGatewayTone,
      detail: `${data.takGateway.health.currentEvents} CoT ${tr("events")}, ${data.takGateway.health.staleEvents} ${tr("stale")}`
    }
  ];
  const operationsTone = operationsStatusTone(data.operations.status);
  const operationsCriticalCount = data.operations.alerts.filter((alert) => alert.severity === "critical").length;
  const operationsWarningCount = data.operations.alerts.filter((alert) => alert.severity === "warning").length;
  const operationsNoticeCount = data.operations.alerts.filter((alert) => alert.severity === "info" || alert.category === "data_quality").length;
  const productionReadinessServices = data.operations.services.filter((service) => service.productionReadiness !== false);
  const operationsRollupServices = productionReadinessServices.length > 0 ? productionReadinessServices : data.operations.services;
  const operationsHealthyServices = operationsRollupServices.filter((service) => service.status === "ok").length;
  const operationsReadinessServiceCount = operationsRollupServices.length || 3;
  const operationsFutureServiceCount = data.operations.services.filter((service) => service.productionReadiness === false).length;
  const operationsDataObjects = operationsRollupServices.reduce((sum, service) => sum + (service.objectCount ?? 0), 0);
  const operationsEnabledSources = operationsRollupServices.reduce((sum, service) => sum + service.enabledSources.length, 0);
  const operationsCache = summarizeOperationsCache(operationsRollupServices);
  const operationsFreshness = summarizeOperationsFreshness(operationsRollupServices);
  const operationsServicesOkDetail =
    operationsFutureServiceCount > 0
      ? `${operationsEnabledSources} ${tr("enabled feeds")} · ${operationsFutureServiceCount} ${tr("future modules excluded")}`
      : `${operationsEnabledSources} ${tr("enabled feeds")}`;
  const operationalCheckStatus = data.operations.operationalCheck?.status ?? "not reported";
  const operationalCheckTone: Tone = operationalCheckStatus === "ok" ? "safe" : operationalCheckStatus === "failed" ? "danger" : "neutral";
  const operationalCheckDetail = data.operations.operationalCheck?.finishedAt
    ? `${tr("last check")} ${formatTime(data.operations.operationalCheck.finishedAt)}`
    : tr("No external check report.");
  const operationsObservabilityByService: Record<string, ServiceObservability> = {
    "flight-data-api": data.observability.flightData.payload,
    "situation-data-api": data.observability.situationData.payload,
    "safety-data-api": data.observability.safetyData.payload,
    "tak-gateway-api": data.observability.takGateway.payload
  };
  const activeOperationAlert = data.operations.alerts.find((alert) => alert.severity !== "info") ?? data.operations.alerts[0];
  const activeOperationAlertTitle = activeOperationAlert
    ? localizedOperatorText(uiLanguage, activeOperationAlert.title, activeOperationAlert.localized?.title)
    : tr("Provider output is ready for COP server-side consumption.");

  const refresh = useCallback(async (preferredScenarioId?: string) => {
    if (!canReadDashboard) {
      return;
    }
    const includeDetails = protectedSectionsUnlocked && activeSection !== "overview";
    const next = await loadDashboard({ includeDetails, includeObservabilityDetails: true });
    setData(next);
    setLastRefreshAt(new Date().toISOString());
    if (next.warnings.length > 0) {
      const warning = next.warnings[0];
      setNotice(warning ? createNotice("Dashboard degraded: {warning}", { warning }) : createNotice("Dashboard degraded."));
    }
    const nextSelection = preferredScenarioId || selectedScenarioId || next.runtime.scenarioId;
    if (nextSelection && next.scenarios.some((scenario) => scenario.scenarioId === nextSelection)) {
      setSelectedScenarioId(nextSelection);
    } else if (next.scenarios[0]?.scenarioId) {
      setSelectedScenarioId(next.scenarios[0].scenarioId);
    }
  }, [activeSection, canReadDashboard, protectedSectionsUnlocked, selectedScenarioId, tr]);

  useEffect(() => {
    document.documentElement.lang = uiLanguage;
  }, [uiLanguage]);

  useEffect(() => {
    const now = Date.now();
    const nextSample: TelemetrySample = {
      at: now,
      generatedEvents: data.runtime.generatedEvents,
      publishedEvents: data.runtime.publishedEvents,
      dataProducts: liveDataProducts
    };
    const previous = telemetrySampleRef.current;
    if (previous) {
      const previousWasEmpty = previous.generatedEvents === 0 && previous.publishedEvents === 0 && previous.dataProducts === 0;
      const nextHasHydratedData = nextSample.generatedEvents > 0 || nextSample.publishedEvents > 0 || nextSample.dataProducts > 0;
      if (previousWasEmpty && nextHasHydratedData) {
        const loadPercent = estimateLiveLoadPercent({
          generatedPerMinute: 0,
          publishedPerMinute: 0,
          dataDeltaPerMinute: 0,
          queueSize: data.publisher.queueSize,
          deadLetterSize: data.publisher.deadLetterSize,
          liveDataProducts,
          running: isRunning,
          warningCount
        });
        setLiveTelemetry({
          generatedPerMinute: 0,
          publishedPerMinute: 0,
          dataDeltaPerMinute: 0,
          loadPercent,
          trend: loadPercent >= 62 ? "active" : loadPercent >= 24 ? "warming" : "steady"
        });
        telemetrySampleRef.current = nextSample;
        return;
      }
      const elapsedMinutes = Math.max((now - previous.at) / 60_000, 1 / 60);
      const generatedPerMinute = Math.max(0, (nextSample.generatedEvents - previous.generatedEvents) / elapsedMinutes);
      const publishedPerMinute = Math.max(0, (nextSample.publishedEvents - previous.publishedEvents) / elapsedMinutes);
      const dataDeltaPerMinute = Math.max(0, (nextSample.dataProducts - previous.dataProducts) / elapsedMinutes);
      const loadPercent = estimateLiveLoadPercent({
        generatedPerMinute,
        publishedPerMinute,
        dataDeltaPerMinute,
        queueSize: data.publisher.queueSize,
        deadLetterSize: data.publisher.deadLetterSize,
        liveDataProducts,
        running: isRunning,
        warningCount
      });
      setLiveTelemetry({
        generatedPerMinute,
        publishedPerMinute,
        dataDeltaPerMinute,
        loadPercent,
        trend: loadPercent >= 62 || generatedPerMinute > 0 || publishedPerMinute > 0 ? "active" : loadPercent >= 24 ? "warming" : "steady"
      });
    } else {
      setLiveTelemetry((current) => ({
        ...current,
        loadPercent: estimateLiveLoadPercent({
          generatedPerMinute: 0,
          publishedPerMinute: 0,
          dataDeltaPerMinute: 0,
          queueSize: data.publisher.queueSize,
          deadLetterSize: data.publisher.deadLetterSize,
          liveDataProducts,
          running: isRunning,
          warningCount
        })
      }));
    }
    telemetrySampleRef.current = nextSample;
  }, [
    data.publisher.deadLetterSize,
    data.publisher.queueSize,
    data.runtime.generatedEvents,
    data.runtime.publishedEvents,
    isRunning,
    liveDataProducts,
    warningCount
  ]);

  useEffect(() => {
    let cancelled = false;
    void initializeAuth(authConfig)
      .then((session) => {
        if (cancelled) {
          return;
        }
        setAuthSession(session);
        if (session.status === "authenticated") {
          setNotice(createNotice("Signed in as {username}.", { username: session.profile?.username ?? "Keycloak user" }));
        } else if (session.status === "error") {
          setNotice(createNotice(session.error ?? "Keycloak sign-in failed."));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setNotice(noticeFromError(error, "Keycloak initialization failed."));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [authConfig]);

  useEffect(() => {
    setSimManualTokenUsageEnabled(manualTokenLoginAllowed);
    setSimAuthorizationTokenProvider(() => authSession.accessToken);
    setApiTokenConfigured(Boolean(authSession.accessToken) || (manualTokenLoginAllowed && hasSimAuthorizationToken()));
    setManualTokenConfigured(manualTokenLoginAllowed && hasSimApiToken());
    return () => setSimAuthorizationTokenProvider(undefined);
  }, [authSession.accessToken, manualTokenLoginAllowed]);

  useEffect(() => {
    if (!canReadDashboard) {
      return undefined;
    }
    void refresh().catch((error) => setNotice(noticeFromError(error, "Dashboard load failed.")));
    const interval = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [canReadDashboard, refresh]);

  useEffect(() => {
    if (authSession.status === "authenticated") {
      void refresh().catch((error) => setNotice(noticeFromError(error, "Dashboard load failed.")));
    }
  }, [authSession.status, authSession.accessToken, refresh]);

  useEffect(() => {
    if (!protectedSectionsUnlocked && activeSection !== "overview") {
      setActiveSection("overview");
      return;
    }
    if (activeSection === "ai" && protectedSectionsUnlocked && !canUseAiAssistant) {
      setActiveSection("overview");
      setNotice(createNotice("AI Assistant requires csm-sim-ai-user, csm-sim-ai-admin or csm-sim-admin role."));
    }
    if (activeSection === "publisher" && protectedSectionsUnlocked && !canAdministerPublisher) {
      setActiveSection("overview");
      setNotice(createNotice("Publisher administration requires csm-sim-admin role."));
    }
  }, [activeSection, canAdministerPublisher, canUseAiAssistant, protectedSectionsUnlocked]);

  useEffect(
    () =>
      onSimApiAuthChange(() => {
        setApiTokenConfigured(Boolean(authSession.accessToken) || (manualTokenLoginAllowed && hasSimAuthorizationToken()));
        setManualTokenConfigured(manualTokenLoginAllowed && hasSimApiToken());
      }),
    [authSession.accessToken, manualTokenLoginAllowed]
  );

  async function saveApiToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!manualTokenLoginAllowed) {
      setNotice(createNotice("Fallback SIM token login is disabled for this deployment."));
      return;
    }
    setSimApiToken(apiTokenInput);
    setApiTokenInput("");
    setApiTokenConfigured(hasSimAuthorizationToken());
    setManualTokenConfigured(manualTokenLoginAllowed && hasSimApiToken());
    setNotice(createNotice("SIM fallback token saved."));
    await refresh().catch((error) => setNotice(noticeFromError(error, "Dashboard load failed.")));
  }

  async function forgetApiToken() {
    clearSimApiToken();
    setApiTokenConfigured(Boolean(authSession.accessToken) || (manualTokenLoginAllowed && hasSimAuthorizationToken()));
    setManualTokenConfigured(false);
    setNotice(createNotice(authConfig.publicReadEnabled ? "SIM fallback token cleared. Read-only monitoring remains available." : "SIM fallback token cleared."));
    await refresh().catch(() => undefined);
  }

  function requireOperatorToken(): boolean {
    if (canManageScenarios && apiTokenConfigured) {
      return true;
    }
    setNotice(createNotice(protectedSectionsUnlocked ? operatorAuthRequiredNoticeSource : protectedSectionNoticeSource));
    return false;
  }

  async function loginWithKeycloak() {
    setAuthSession((session) => ({ ...session, status: "authenticating" }));
    await beginLogin(authConfig);
  }

  function logoutFromKeycloak() {
    setAuthSession({ status: "anonymous" });
    setActiveSection("overview");
    setSimAuthorizationTokenProvider(undefined);
    endSession(authConfig, authSession);
  }

  function selectSection(section: AppSection): void {
    if (section !== "overview" && !protectedSectionsUnlocked) {
      setActiveSection("overview");
      setNotice(createNotice(protectedSectionNoticeSource));
      return;
    }
    if (section === "publisher" && !canAdministerPublisher) {
      setActiveSection("overview");
      setNotice(createNotice("Publisher administration requires csm-sim-admin role."));
      return;
    }
    if (section === "ai" && !canUseAiAssistant) {
      setActiveSection("overview");
      setNotice(createNotice("AI Assistant requires csm-sim-ai-user, csm-sim-ai-admin or csm-sim-admin role."));
      return;
    }
    setActiveSection(section);
  }

  async function runAction<T>(messageSource: string, action: () => Promise<T>) {
    setLoading(true);
    try {
      const result = await action();
      setNotice(createNotice(messageSource));
      await refresh(typeof result === "string" ? result : undefined);
    } catch (error) {
      setNotice(noticeFromError(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <UiLanguageContext.Provider value={uiLanguage}>
      <NumberLocaleContext.Provider value={numberLocale}>
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">SIM</div>
          <div>
            <strong>CSM SIM</strong>
            <span>{tr("Data provider pilot")}</span>
          </div>
        </div>

        <nav className="nav-list" aria-label={tr("Primary")}>
          <NavButton section="overview" activeSection={visibleSection} onSelect={selectSection} icon={<Gauge size={17} />} label="Overview" />
          <NavButton section="scenario" activeSection={visibleSection} onSelect={selectSection} icon={<Activity size={17} />} label="Scenario" locked={!protectedSectionsUnlocked} lockReason={protectedSectionNotice} />
          <NavButton section="flight-data" activeSection={visibleSection} onSelect={selectSection} icon={<Plane size={17} />} label="Flight data" locked={!protectedSectionsUnlocked} lockReason={protectedSectionNotice} />
          <NavButton section="situation-data" activeSection={visibleSection} onSelect={selectSection} icon={<Layers3 size={17} />} label="Situation data" locked={!protectedSectionsUnlocked} lockReason={protectedSectionNotice} />
          <NavButton section="tak-gateway" activeSection={visibleSection} onSelect={selectSection} icon={<RadioTower size={17} />} label="TAK gateway" locked={!protectedSectionsUnlocked} lockReason={protectedSectionNotice} />
          <NavButton section="publisher" activeSection={visibleSection} onSelect={selectSection} icon={<RadioTower size={17} />} label="Publisher" locked={!canAdministerPublisher} lockReason="Publisher administration requires csm-sim-admin role." />
          <NavButton section="ai" activeSection={visibleSection} onSelect={selectSection} icon={<Bot size={17} />} label="AI Assistant" locked={!canUseAiAssistant} lockReason="AI Assistant requires csm-sim-ai-user, csm-sim-ai-admin or csm-sim-admin role." />
          <NavButton section="safety" activeSection={visibleSection} onSelect={selectSection} icon={<ShieldAlert size={17} />} label="Safety data" locked={!protectedSectionsUnlocked} lockReason={protectedSectionNotice} />
        </nav>

        <div className={`safety-panel ${canReadDashboard ? "ready" : "locked"}`}>
          {canReadDashboard ? <ShieldCheck size={18} /> : <LockKeyhole size={18} />}
          <div>
            <strong>{canReadDashboard ? tr("Safety gate active") : tr("Keycloak gate")}</strong>
            <span>{canReadDashboard ? tr("Only synthetic payloads are accepted by the CSM publisher.") : tr("SIM requires assigned Keycloak roles for internet access.")}</span>
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
            <div className="language-switch" aria-label={tr("Language")}>
              <button type="button" className={uiLanguage === "cs" ? "selected" : ""} aria-pressed={uiLanguage === "cs"} onClick={() => changeUiLanguage("cs")}>
                CS
              </button>
              <button type="button" className={uiLanguage === "en" ? "selected" : ""} aria-pressed={uiLanguage === "en"} onClick={() => changeUiLanguage("en")}>
                EN
              </button>
            </div>
            {showTopbarOidcAction ? (
              authSession.status === "authenticated" ? (
                <button type="button" className="token-button operator-button" onClick={logoutFromKeycloak}>
                  <LogOut size={15} /> {authSession.profile?.username ?? "Keycloak"}
                </button>
              ) : (
                <button type="button" className="token-button operator-button primary-auth" disabled={authSession.status === "authenticating"} onClick={() => void loginWithKeycloak()}>
                  <KeyRound size={15} /> {authSession.status === "authenticating" ? tr("Signing in") : tr("Keycloak login")}
                </button>
              )
            ) : null}
            {manualTokenLoginAllowed && manualTokenConfigured ? (
              <button type="button" className="token-button" onClick={() => void forgetApiToken()}>
                <LogOut size={15} /> {tr("Fallback token")}
              </button>
            ) : null}
            {manualTokenLoginAllowed && !manualTokenConfigured && authSession.status !== "authenticated" ? (
              <form className="api-auth-form" onSubmit={(event) => void saveApiToken(event)}>
                <input
                  type="password"
                  value={apiTokenInput}
                  placeholder={oidcEnabled ? tr("Fallback SIM token") : tr("SIM API token")}
                  aria-label={oidcEnabled ? tr("Fallback SIM token") : tr("SIM API token")}
                  autoComplete="off"
                  onChange={(event) => setApiTokenInput(event.target.value)}
                />
                <button type="submit" disabled={!apiTokenInput.trim()}>
                  <KeyRound size={15} /> {tr("Auth")}
                </button>
              </form>
            ) : null}
            <a className="external-link" href={copDisplayUrl} target="_blank" rel="noreferrer">
              {tr("COP display")} <ExternalLink size={15} />
            </a>
            <StatusPill label={authRoleSummary} tone={canReadDashboard ? "safe" : "warn"} />
            <StatusPill label={data.publisher.mode} tone={publisherTone} />
            <StatusPill label={data.runtime.state} tone={runtimeTone} />
          </div>
        </header>

        <div className={`notice notice-global ${noticeIsWarning ? "warn" : ""}`} role="status">
          {noticeIsWarning ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
          <span>{renderedNotice}</span>
        </div>

        {!canReadDashboard ? (
          <LoginGate
            authSession={authSession}
            oidcEnabled={oidcEnabled}
            onLogin={() => void loginWithKeycloak()}
            onLogout={logoutFromKeycloak}
          />
        ) : null}

        {canReadDashboard && visibleSection === "overview" ? (
          <>
            <section id="dashboard" className={`operations-command ${operationsTone}`} aria-label="SIM operations command center">
              <div className="operations-command-main">
                <div>
                  <span className="ops-kicker">{tr("Operations center")}</span>
                  <h2>{tr(operationsStatusTitle(data.operations.status))}</h2>
                  <p>
                    {tr("Read-only management snapshot for COP-facing feeds, provider health, cache posture and scenario runtime.")}
                  </p>
                </div>
                <div className="operations-status-stack">
                  <StatusPill label={data.operations.status} tone={operationsTone} />
                  <StatusPill label={`${tr("summary")} ${formatTime(data.operations.generatedAt)}`} tone="neutral" />
                  <StatusPill label={`${tr("refresh")} ${formatTime(lastRefreshAt)}`} tone="neutral" />
                </div>
              </div>

              <div className="operations-metrics">
                <OperationsMetricCard icon={<ShieldAlert />} label="Active alerts" value={`${operationsCriticalCount}/${operationsWarningCount}/${operationsNoticeCount}`} detail="critical / warning / notice" tone={operationsCriticalCount > 0 ? "danger" : operationsWarningCount > 0 ? "warn" : operationsNoticeCount > 0 ? "neutral" : "safe"} />
                <OperationsMetricCard icon={<Server />} label="Services OK" value={`${operationsHealthyServices}/${operationsReadinessServiceCount}`} detail={operationsServicesOkDetail} tone={operationsHealthyServices === operationsReadinessServiceCount ? "safe" : operationsHealthyServices > 0 ? "warn" : "danger"} />
                <OperationsMetricCard icon={<Database />} label="Data objects" value={operationsDataObjects.toLocaleString(numberLocale)} detail="latest provider inventory" tone="active" />
                <OperationsMetricCard icon={<TimerReset />} label="Cache hit-rate" value={formatPercentValue(operationsCache.hitRate)} detail={`${operationsCache.errors} ${tr("cache errors")}`} tone={operationsCache.errors > 0 ? "warn" : operationsCache.hitRate >= 0.75 ? "safe" : "neutral"} />
                <OperationsMetricCard icon={<Cpu />} label="Slowest probe" value={formatLatencyMs(Math.max(...operationsRollupServices.map((service) => service.latencyMs), 0))} detail={`${tr("oldest import")} ${operationsFreshness.value}`} tone={operationsFreshness.tone} />
              </div>
            </section>

            <section className="operations-layout" aria-label={tr("Operations workbench")}>
              <section className="ops-panel alert-inbox">
                <PanelTitle icon={<AlertTriangle />} title="Alert inbox" subtitle={`${operationsCriticalCount} ${tr("critical")} · ${operationsWarningCount} ${tr("warning")} · ${operationsNoticeCount} ${tr("notice")}`} />
                {data.operations.alerts.length > 0 ? (
                  <div className="alert-list">
                    {data.operations.alerts.slice(0, 6).map((alert) => (
                      <OperationsAlertRow key={`${alert.code}-${alert.serviceId ?? "sim"}`} alert={alert} />
                    ))}
                  </div>
                ) : (
                  <div className="empty-state calm">
                    <CheckCircle2 size={18} />
                    <span>{tr("No active operational alerts.")}</span>
                  </div>
                )}
              </section>

              <section className="ops-panel service-matrix">
                <PanelTitle icon={<Network />} title="Provider services" subtitle="Health, freshness and cache posture without heavy feature preview payloads." />
                <div className="service-table" role="table" aria-label="Provider services">
                  <div className="service-row service-head" role="row">
                    <span>{tr("Service")}</span>
                    <span>{tr("Status")}</span>
                    <span>{tr("Latency")}</span>
                    <span>{tr("Objects")}</span>
                    <span>{tr("Cache")}</span>
                    <span>{tr("Freshness")}</span>
                    <span>{tr("Detail")}</span>
                  </div>
                  {data.operations.services.map((service) => (
                    <OperationsServiceRow key={service.serviceId} service={service} observability={operationsObservabilityByService[service.serviceId]} />
                  ))}
                  {data.operations.services.length === 0 ? <div className="empty-state">{tr("Operations summary is not available.")}</div> : null}
                </div>
              </section>
            </section>

            <section className="operations-layout secondary" aria-label={tr("Runtime and feed readiness")}>
              <section className="ops-panel readiness-panel">
                <PanelTitle icon={<ShieldCheck />} title="Runtime and publisher" subtitle={`Runtime ${data.operations.runtime.state} · publisher ${data.operations.publisher.mode}`} />
                <div className="readiness-list compact">
                  <ReadinessItem icon={<CirclePlay />} label="Runtime" value={data.operations.runtime.state} detail={`${data.operations.runtime.tick ?? 0} ${tr("ticks")}, ${formatDuration(data.operations.runtime.elapsedSeconds ?? 0)} ${tr("elapsed")}`} tone={runtimeStateTone(data.operations.runtime.state)} />
                  <ReadinessItem icon={<RadioTower />} label="Publisher" value={data.operations.publisher.mode} detail={data.operations.publisher.publishingEnabled ? "adapter enabled" : "adapter stopped"} tone={publisherTone} />
                  <ReadinessItem icon={<Database />} label="Queue" value={`${data.operations.publisher.queueSize} ${tr("active")}`} detail={formatDeadLetterCount(data.operations.publisher.deadLetterSize, numberLocale, tr)} tone={queueTone} />
                  <ReadinessItem icon={<Layers3 />} label="Scenarios" value={`${data.operations.scenarios.total}`} detail={`${data.operations.scenarios.active} ${tr("active")}, ${data.operations.scenarios.draft} ${tr("draft")}`} tone={data.operations.scenarios.active > 0 ? "active" : "neutral"} />
                  <ReadinessItem icon={<ShieldCheck />} label="Operational check" value={operationalCheckStatus} detail={operationalCheckDetail} tone={operationalCheckTone} />
                </div>
              </section>

              <section className="ops-panel feed-readiness-panel">
                <PanelTitle icon={<Signal />} title="COP data plane" subtitle={activeOperationAlertTitle} />
                <div className="feed-signal-grid">
                  <FeedSignal label="Flight" service={data.operations.services.find((service) => service.serviceId === "flight-data-api")} icon={<Plane />} />
                  <FeedSignal label="Situation" service={data.operations.services.find((service) => service.serviceId === "situation-data-api")} icon={<Layers3 />} />
                  <FeedSignal label="Safety" service={data.operations.services.find((service) => service.serviceId === "safety-data-api")} icon={<ShieldAlert />} />
                  <FeedSignal label="TAK" service={data.operations.services.find((service) => service.serviceId === "tak-gateway-api")} icon={<RadioTower />} />
                </div>
                <MobileNetworkStatusPanel onOpen={() => setMobileNetworkInfoOpen(true)} />
              </section>
            </section>
          </>
        ) : null}

        <section className="section-layout">
          {visibleSection === "scenario" ? (
          <section id="scenario" className="panel scenario-panel">
            <PanelTitle icon={<CirclePlay />} title="Scenario execution" subtitle="Deterministic moving tracks for COP display validation." />

            <div className="scenario-toolbar">
              <div>
                <strong>{tr("Scenario library")}</strong>
                <span>{data.scenarios.length.toLocaleString(numberLocale)} {tr("prepared scenarios")}</span>
              </div>
              <button
                type="button"
                onClick={() =>
                  requireOperatorToken() &&
                  runAction("Demo scenario created.", async () => {
                    const created = await createScenario(demoScenario);
                    setSelectedScenarioId(created.scenarioId);
                    return created.scenarioId;
                  })
                }
                disabled={operatorActionDisabled}
                title={apiTokenConfigured ? tr("Create demo scenario") : operatorAuthRequiredNotice}
              >
                <Plus size={16} /> Demo
              </button>
              <button
                type="button"
                onClick={() =>
                  requireOperatorToken() &&
                  runAction("High-density demo scenario created.", async () => {
                    const created = await createScenario(denseDemoScenario);
                    setSelectedScenarioId(created.scenarioId);
                    return created.scenarioId;
                  })
                }
                disabled={operatorActionDisabled}
                title={apiTokenConfigured ? tr("Create high-density demo scenario") : operatorAuthRequiredNotice}
              >
                <Database size={16} /> 300 tracks
              </button>
              <button
                type="button"
                onClick={() =>
                  requireOperatorToken() &&
                  runAction("Ukraine air-defense demo scenario created.", async () => {
                    const created = await createScenario(ukraineAirDefenseDemoScenario);
                    setSelectedScenarioId(created.scenarioId);
                    return created.scenarioId;
                  })
                }
                disabled={operatorActionDisabled}
                title={apiTokenConfigured ? tr("Create Ukraine demo scenario") : operatorAuthRequiredNotice}
              >
                <ShieldAlert size={16} /> Ukraine demo
              </button>
            </div>

            <div className="scenario-picker" aria-label={tr("Scenario library")}>
              {scenarioList.length === 0 ? <div className="empty-state">{tr("Create the demo scenario to start the pilot runtime.")}</div> : null}
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
                <SummaryItem label="Objects" value={totalObjects.toLocaleString(numberLocale)} />
                <SummaryItem label="Seed" value={selectedScenario.seed.toString()} />
                <SummaryItem label="Tick" value={(data.runtime.tick ?? 0).toString()} />
                <SummaryItem label="Speed" value={`${effectiveSpeedMultiplier}x`} />
                <SummaryItem label="Update" value={`${data.runtime.tickIntervalSeconds ?? 1}s`} />
                <SummaryItem label="Last tick" value={formatTime(data.runtime.lastTickAt)} />
              </div>
            ) : (
              <div className="empty-state">{tr("Create the demo scenario to start the pilot runtime.")}</div>
            )}

            <div className="runtime-options" aria-label={tr("Runtime speed")}>
              <span>{tr("Runtime speed")}</span>
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
                  <strong>{tr(runtimeCommandTitle(selectedScenario, data.runtime))}</strong>
                  <span>{tr(runtimeCommandDetail(selectedScenario, data.runtime))}</span>
                </div>
                <div className="button-strip runtime-actions">
                  {!apiTokenConfigured ? <span className="command-note">{tr("Operator token required for runtime control.")}</span> : null}
                  {otherScenarioIsActive ? <span className="command-note">{tr("Select the active scenario to control the running runtime.")}</span> : null}
                  {!isRunning && !isPaused ? (
                    <ActionButton
                      icon={<Play />}
                      label="Start"
                      disabled={operatorActionDisabled}
                      title={apiTokenConfigured ? tr("Start selected scenario") : operatorAuthRequiredNotice}
                      onClick={() =>
                        selectedScenario.scenarioId &&
                        requireOperatorToken() &&
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
                        disabled={operatorActionDisabled}
                        title={apiTokenConfigured ? tr("Pause active scenario") : operatorAuthRequiredNotice}
                        onClick={() =>
                          selectedScenario.scenarioId &&
                          requireOperatorToken() &&
                          runAction("Scenario paused.", () => runtimeAction(selectedScenario.scenarioId!, "pause"))
                        }
                      />
                      <ActionButton
                        icon={<Square />}
                        label="Stop"
                        disabled={operatorActionDisabled}
                        title={apiTokenConfigured ? tr("Stop active scenario") : operatorAuthRequiredNotice}
                        onClick={() =>
                          selectedScenario.scenarioId &&
                          requireOperatorToken() &&
                          runAction("Scenario stopped.", () => runtimeAction(selectedScenario.scenarioId!, "stop"))
                        }
                      />
                      <ActionButton
                        icon={<Zap />}
                        label="Fault"
                        disabled={operatorActionDisabled}
                        title={apiTokenConfigured ? tr("Add connectivity fault") : operatorAuthRequiredNotice}
                        onClick={() =>
                          selectedScenario.scenarioId &&
                          requireOperatorToken() &&
                          runAction("Connectivity fault added.", () => addConnectivityFault(selectedScenario.scenarioId!))
                        }
                      />
                    </>
                  ) : null}
                  {selectedScenarioIsRuntime && isPaused ? (
                    <>
                      <ActionButton
                        icon={<Play />}
                        label="Resume"
                        disabled={operatorActionDisabled}
                        title={apiTokenConfigured ? tr("Resume active scenario") : operatorAuthRequiredNotice}
                        onClick={() =>
                          selectedScenario.scenarioId &&
                          requireOperatorToken() &&
                          runAction("Scenario resumed.", () => runtimeAction(selectedScenario.scenarioId!, "resume"))
                        }
                      />
                      <ActionButton
                        icon={<Square />}
                        label="Stop"
                        disabled={operatorActionDisabled}
                        title={apiTokenConfigured ? tr("Stop active scenario") : operatorAuthRequiredNotice}
                        onClick={() =>
                          selectedScenario.scenarioId &&
                          requireOperatorToken() &&
                          runAction("Scenario stopped.", () => runtimeAction(selectedScenario.scenarioId!, "stop"))
                        }
                      />
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}

            {selectedScenario ? (
              <details className="advanced-controls">
                <summary>{tr("Advanced controls")}</summary>
                <div className="button-strip compact">
                  <ActionButton
                    icon={<RotateCcw />}
                    label="Step"
                    disabled={operatorActionDisabled || isRunning}
                    title={apiTokenConfigured ? tr("Generate one deterministic step") : operatorAuthRequiredNotice}
                    onClick={() =>
                      selectedScenario.scenarioId &&
                      requireOperatorToken() &&
                      runAction("One deterministic movement step generated.", () => runtimeAction(selectedScenario.scenarioId!, "step"))
                    }
                  />
                  <ActionButton
                    icon={<Zap />}
                    label="Fault"
                    disabled={operatorActionDisabled || otherScenarioIsActive}
                    title={apiTokenConfigured ? tr("Add connectivity fault") : operatorAuthRequiredNotice}
                    onClick={() =>
                      selectedScenario.scenarioId &&
                      requireOperatorToken() &&
                      runAction("Connectivity fault added.", () => addConnectivityFault(selectedScenario.scenarioId!))
                    }
                  />
                </div>
              </details>
            ) : null}

            <div id="manifest" className="section-head">
              <div>
                <strong>{tr("Scenario manifest")}</strong>
                <span>{displayedBlocks.filter((block) => block.enabled).length} {tr("enabled blocks")}</span>
              </div>
              <StatusPill label={`${totalObjects} ${tr("tracks")}`} tone="active" />
            </div>

            <div className="manifest-table" role="table" aria-label={tr("Scenario manifest")}>
              <div className="manifest-row manifest-head" role="row">
                <span>{tr("Block")}</span>
                <span>{tr("Count")}</span>
                <span>{tr("Movement")}</span>
                <span>{tr("Rate")}</span>
                <span>{tr("Affiliation")}</span>
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

          {visibleSection === "flight-data" ? (
          <section id="flight-data" className="panel flight-data-panel">
            <PanelTitle icon={<Plane />} title="Flight Data source" subtitle="Aggregated public or licensed flight tracks prepared for COP." />

            <div className="publisher-status">
              <StatusPill label={data.flightData.health.status} tone={flightDataTone} />
              <StatusPill label={data.flightData.tracks.contractVersion} tone="active" />
              <StatusPill
                label={`${data.flightData.tracks.warnings.length} ${tr("warnings")}`}
                tone={data.flightData.tracks.warnings.length > 0 ? "warn" : "neutral"}
              />
            </div>

            <div className="publisher-stats flight-stats">
              <PublisherStat label="Raw observations" value={data.flightData.tracks.summary.rawObservationCount.toLocaleString(numberLocale)} tone="neutral" />
              <PublisherStat label="Deduplicated tracks" value={data.flightData.tracks.summary.deduplicatedTrackCount.toLocaleString(numberLocale)} tone="safe" />
              <PublisherStat label="Stale tracks" value={data.flightData.tracks.summary.staleTrackCount.toLocaleString(numberLocale)} tone={data.flightData.tracks.summary.staleTrackCount > 0 ? "warn" : "neutral"} />
              <PublisherStat label="Dropped positions" value={data.flightData.tracks.summary.droppedWithoutPositionCount.toLocaleString(numberLocale)} tone={data.flightData.tracks.summary.droppedWithoutPositionCount > 0 ? "danger" : "neutral"} />
            </div>

            <div className="flight-grid">
              <section className="inline-panel">
                <PanelTitle icon={<Settings2 />} title="Current settings" subtitle="Read-only runtime configuration from /srv/sim .env." />
                <div className="settings-grid">
                  <SummaryItem label="Enabled sources" value={data.flightData.config.enabledSources.join(", ") || "-"} />
                  <SummaryItem label="Default area" value={`${formatCoordinate(data.flightData.config.defaultArea.lat)}, ${formatCoordinate(data.flightData.config.defaultArea.lon)}`} />
                  <SummaryItem label="Radius" value={`${data.flightData.config.defaultArea.radiusNm} NM`} />
                  <SummaryItem label="Cache TTL" value={`${data.flightData.config.cacheTtlSeconds}s`} />
                  <SummaryItem label="Stale fallback" value={`${data.flightData.config.staleIfErrorSeconds}s`} />
                  <SummaryItem label="Cache entries" value={`${data.flightData.config.cacheMaxEntries}`} />
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
                  {data.flightData.sources.length === 0 ? <div className="empty-state">{tr("Flight source metadata is not available.")}</div> : null}
                </div>
              </section>
            </div>

            <div className="section-head compact-head">
              <div>
                <strong>{tr("Flight track preview")}</strong>
                <span>{data.flightData.tracks.tracks.length} {tr("shown from latest aggregate response")}</span>
              </div>
              <StatusPill label={formatTime(data.flightData.tracks.source.generatedAt)} tone="neutral" />
            </div>

            <div className="flight-track-list">
              {data.flightData.tracks.tracks.map((track) => (
                <FlightTrackRow key={track.trackId} track={track} />
              ))}
              {data.flightData.tracks.tracks.length === 0 ? <div className="empty-state">{tr("No flight tracks are available from the configured sources.")}</div> : null}
            </div>

            {data.flightData.tracks.warnings.length > 0 ? (
              <div className="notice warn">
                <AlertTriangle size={16} />
                <span>{data.flightData.tracks.warnings.join(" ")}</span>
              </div>
            ) : null}
          </section>
          ) : null}

          {visibleSection === "situation-data" ? (
          <section id="situation-data" className="panel situation-data-panel">
            <PanelTitle icon={<Layers3 />} title="Situation Data source" subtitle="Aggregated public context layers prepared for the COP map." />

            <div className="publisher-status">
              <StatusPill label={data.situationData.health.status} tone={situationDataTone} />
              <StatusPill label={data.situationData.features.contractVersion} tone="active" />
              <StatusPill
                label={`${data.situationData.features.summary.warningCount} ${tr("warnings")}`}
                tone={data.situationData.features.summary.warningCount > 0 ? "warn" : "neutral"}
              />
            </div>

            <div className="publisher-stats situation-stats">
              <PublisherStat label="Features" value={data.situationData.features.summary.featureCount.toLocaleString(numberLocale)} tone="safe" />
              <PublisherStat label="Sources" value={data.situationData.features.summary.sourceCount.toLocaleString(numberLocale)} tone="neutral" />
              <PublisherStat label="Stale" value={data.situationData.features.summary.staleFeatureCount.toLocaleString(numberLocale)} tone={data.situationData.features.summary.staleFeatureCount > 0 ? "warn" : "neutral"} />
              <PublisherStat label="Layers" value={data.situationData.layers.length.toLocaleString(numberLocale)} tone="active" />
            </div>

            <div className="flight-grid">
              <section className="inline-panel">
                <PanelTitle icon={<Settings2 />} title="Current settings" subtitle="Read-only runtime configuration for public situation layers." />
                <div className="settings-grid">
                  <SummaryItem label="Enabled sources" value={data.situationData.config.enabledSources.join(", ") || "-"} />
                  <SummaryItem label="Default bbox" value={formatBbox(data.situationData.config.defaultBbox)} />
                  <SummaryItem label="Cache TTL" value={`${data.situationData.config.cacheTtlSeconds}s`} />
                  <SummaryItem label="Stale fallback" value={`${data.situationData.config.staleIfErrorSeconds}s`} />
                  <SummaryItem label="Cache entries" value={`${data.situationData.config.cacheMaxEntries}`} />
                  <SummaryItem
                    label="Shared cache"
                    value={`${data.situationData.config.sharedCache.backend} ${data.situationData.config.sharedCache.enabled ? tr("enabled") : tr("local only")}`}
                  />
                  <SummaryItem label="BBox padding" value={`${data.situationData.config.bboxCachePaddingDegrees} deg`} />
                  <SummaryItem label="Stale after" value={`${data.situationData.config.staleAfterSeconds}s`} />
                  <SummaryItem label="Timeout" value={`${data.situationData.config.requestTimeoutMs} ms`} />
                  <SummaryItem label="Source TTLs" value={formatSituationSourceTtls(data.situationData.config.sourceCacheTtlSeconds)} />
                  <SummaryItem label="OSM backend" value={osmPostgisHealth?.backend ?? data.situationData.config.providers.find((provider) => provider.sourceId === "osm_postgis")?.backend ?? "-"} />
                  <SummaryItem label="OSM objects" value={typeof osmPostgisHealth?.objectCount === "number" ? osmPostgisHealth.objectCount.toLocaleString(numberLocale) : "-"} />
                  <SummaryItem label="OSM import age" value={formatImportAge(osmPostgisHealth?.lastImportAgeSeconds)} />
                  <SummaryItem label="Query limit" value={`${data.situationData.features.query.limit || 0}`} />
                </div>
              </section>

              <section className="inline-panel">
                <PanelTitle icon={<MapPinned />} title="Layer registry" subtitle="COP can toggle these layers independently from flight tracks." />
                <div className="layer-list">
                  {data.situationData.layers.map((layer) => (
                    <SituationLayerRow key={layer.layerId} layer={layer} count={countSituationLayer(data.situationData.features.features, layer.layerId)} />
                  ))}
                  {data.situationData.layers.length === 0 ? <div className="empty-state">{tr("Situation layer metadata is not available.")}</div> : null}
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
                  {data.situationData.sources.length === 0 ? <div className="empty-state">{tr("Situation source metadata is not available.")}</div> : null}
                </div>
              </section>

              <section className="inline-panel">
                <PanelTitle icon={<CloudSun />} title="Provider feature preview" subtitle="GeoJSON features returned by /situation-data/api/v1/features." />
                <div className="situation-feature-list">
                  {data.situationData.features.features.map((feature) => (
                    <SituationFeatureRow key={feature.id} feature={feature} />
                  ))}
                  {data.situationData.features.features.length === 0 ? <div className="empty-state">{tr("No situation features are available from the configured sources.")}</div> : null}
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

          {visibleSection === "tak-gateway" ? (
          <section id="tak-gateway" className="panel situation-data-panel">
            <PanelTitle icon={<RadioTower />} title="TAK Gateway" subtitle="Cursor-on-Target ingest and normalized COP feature projection for ARDOS/TAK partner data." />

            <div className="publisher-status">
              <StatusPill label={data.takGateway.health.status} tone={takGatewayTone} />
              <StatusPill label={data.takGateway.features.contractVersion} tone="active" />
              <StatusPill label={data.takGateway.health.ingestAuthConfigured ? "ingest protected" : "ingest open"} tone={data.takGateway.health.ingestAuthConfigured ? "safe" : "danger"} />
              <StatusPill
                label={`${data.takGateway.features.warnings.length} ${tr("warnings")}`}
                tone={data.takGateway.features.warnings.length > 0 ? "warn" : "neutral"}
              />
            </div>

            <div className="publisher-stats situation-stats">
              <PublisherStat label="Current events" value={data.takGateway.health.currentEvents.toLocaleString(numberLocale)} tone="safe" />
              <PublisherStat label="Provider features" value={data.takGateway.features.summary.featureCount.toLocaleString(numberLocale)} tone="active" />
              <PublisherStat label="Stale" value={data.takGateway.health.staleEvents.toLocaleString(numberLocale)} tone={data.takGateway.health.staleEvents > 0 ? "warn" : "neutral"} />
              <PublisherStat label="Last ingest" value={formatTime(data.takGateway.health.lastIngestAt)} tone={data.takGateway.health.lastIngestAt ? "safe" : "neutral"} />
            </div>

            <div className="flight-grid">
              <section className="inline-panel">
                <PanelTitle icon={<Settings2 />} title="Current settings" subtitle="Read-only runtime settings for CoT retention and COP projection." />
                <div className="settings-grid">
                  <SummaryItem label="Source label" value={data.takGateway.config.sourceLabel || "-"} />
                  <SummaryItem label="Default bbox" value={formatBbox(data.takGateway.config.defaultBbox)} />
                  <SummaryItem label="Stale after" value={`${data.takGateway.config.staleAfterSeconds}s`} />
                  <SummaryItem label="Retention" value={`${data.takGateway.config.retentionSeconds}s`} />
                  <SummaryItem label="Max events" value={`${data.takGateway.config.maxEvents}`} />
                  <SummaryItem label="Raw CoT exposure" value={data.takGateway.config.exposeRaw ? "enabled" : "disabled"} />
                  <SummaryItem label="Ingest auth" value={data.takGateway.config.ingestAuthConfigured ? "configured" : "missing"} />
                  <SummaryItem label="Read mode" value={data.takGateway.config.publicRead ? "public" : "token"} />
                  <SummaryItem label="Read auth" value={data.takGateway.config.readAuthConfigured ? "configured" : "missing"} />
                  <SummaryItem label="Query limit" value={`${data.takGateway.features.query.limit || 0}`} />
                </div>
              </section>

              <section className="inline-panel">
                <PanelTitle icon={<MapPinned />} title="Layer registry" subtitle="COP can render TAK Gateway layers independently from public open-data sources." />
                <div className="layer-list">
                  {data.takGateway.layers.map((layer) => (
                    <TakLayerRow key={layer.layerId} layer={layer} count={countTakLayer(data.takGateway.features.features, layer.layerId)} />
                  ))}
                  {data.takGateway.layers.length === 0 ? <div className="empty-state">{tr("TAK Gateway layer metadata is not available.")}</div> : null}
                </div>
              </section>
            </div>

            <div className="flight-grid">
              <section className="inline-panel">
                <PanelTitle icon={<Database />} title="Partner source" subtitle="TAK/ARDOS data is partner-provided and requires COP-side authorization." />
                <div className="source-list">
                  {data.takGateway.sources.map((source) => (
                    <TakSourceRow key={source.sourceId} source={source} />
                  ))}
                  {data.takGateway.sources.length === 0 ? <div className="empty-state">{tr("TAK Gateway source metadata is not available.")}</div> : null}
                </div>
              </section>

              <section className="inline-panel">
                <PanelTitle icon={<RadioTower />} title="Provider feature preview" subtitle="GeoJSON features returned by /tak-gateway/api/v1/features." />
                <div className="situation-feature-list">
                  {data.takGateway.features.features.map((feature) => (
                    <TakFeatureRow key={feature.id} feature={feature} />
                  ))}
                  {data.takGateway.features.features.length === 0 ? <div className="empty-state">{tr("No TAK/CoT events have been ingested yet.")}</div> : null}
                </div>
              </section>
            </div>

            {data.takGateway.features.warnings.length > 0 ? (
              <div className="notice warn">
                <AlertTriangle size={16} />
                <span>{data.takGateway.features.warnings.join(" ")}</span>
              </div>
            ) : null}
          </section>
          ) : null}

          {visibleSection === "publisher" ? (
          <section id="publisher" className="panel publisher-panel">
            <PanelTitle icon={<RadioTower />} title="COP publisher" subtitle="Delivery state and recent canonical events." />
            <div className="publisher-status">
              <StatusPill label={data.publisher.publishingEnabled ? "publishing enabled" : "publishing stopped"} tone={data.publisher.publishingEnabled ? "safe" : "danger"} />
              <StatusPill label={formatDeadLetterCount(data.publisher.deadLetterSize, numberLocale, tr)} tone={data.publisher.deadLetterSize > 0 ? "danger" : "neutral"} />
            </div>

            <div className="publisher-stats">
              <PublisherStat label="Queue" value={data.publisher.queueSize.toLocaleString(numberLocale)} tone={queueTone} />
              <PublisherStat label="Retained" value={data.queueTotalCount.toLocaleString(numberLocale)} tone="neutral" />
              <PublisherStat label="Success" value={formatTime(data.publisher.lastSuccessAt)} tone="safe" />
            </div>

            <div className="button-strip compact">
              <button type="button" onClick={() => runAction("Publisher connection checked.", testPublisher)} disabled={loading || !canAdministerPublisher}>
                <FlaskConical size={16} /> {tr("Test connection")}
              </button>
              <button type="button" onClick={() => runAction("Queue cleared.", clearQueue)} disabled={loading || !canAdministerPublisher || data.queueTotalCount === 0}>
                <Trash2 size={16} /> {tr("Clear queue")}
              </button>
            </div>

            <div className="section-head compact-head">
              <div>
                <strong>{tr("Recent event flow")}</strong>
                <span>{data.queue.length} {tr("shown from")} {data.queueTotalCount} {tr("retained")}</span>
              </div>
            </div>

            <div className="queue-list">
              {data.queue.map((item) => (
                <QueueRow key={item.queueId} item={item} />
              ))}
              {data.queue.length === 0 ? <div className="empty-state">{tr("No queued events yet.")}</div> : null}
            </div>
          </section>
          ) : null}

          {visibleSection === "ai" ? (
          <section id="ai" className="panel ai-panel">
            <PanelTitle icon={<Bot />} title="AI Scenario Assistant" subtitle="Mock provider, structured draft and human accept flow." />
            <textarea value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} rows={5} />
            <div className="button-strip compact">
              <button type="button" disabled={loading || !canUseAiAssistant} onClick={() => runAction("AI draft generated.", async () => setDraft(await createAiDraft(aiPrompt)))}>
                <Bot size={16} /> {tr("Generate draft")}
              </button>
              <button type="button" disabled={!draft || !draft.policyCheck.allowed || loading || !canUseAiAssistant} onClick={() => draft && runAction("AI draft accepted as scenario.", () => acceptAiDraft(draft.draftId))}>
                <ShieldCheck size={16} /> {tr("Accept draft")}
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
              <div className="empty-state">{tr("Generate a draft to validate the AI guardrail path.")}</div>
            )}
          </section>
          ) : null}

          {visibleSection === "safety" ? (
          <section id="safety-data" className="panel safety-data-panel">
            <PanelTitle icon={<ShieldAlert />} title="Safety Data source" subtitle="Official public warnings and hydrological observations prepared for COP map layers." />

            <div className="publisher-status">
              <StatusPill label={data.safetyData.health.status} tone={safetyDataTone} />
              <StatusPill label={data.safetyData.features.contractVersion} tone="active" />
              <StatusPill
                label={`${elevatedSafetyCount} ${tr("elevated")}`}
                tone={data.safetyData.features.summary.criticalCount > 0 ? "danger" : elevatedSafetyCount > 0 ? "warn" : "neutral"}
              />
            </div>

            <div className="publisher-stats safety-stats">
              <PublisherStat label="Features" value={data.safetyData.features.summary.featureCount.toLocaleString(numberLocale)} tone="safe" />
              <PublisherStat label="Advisory" value={data.safetyData.features.summary.advisoryCount.toLocaleString(numberLocale)} tone={data.safetyData.features.summary.advisoryCount > 0 ? "warn" : "neutral"} />
              <PublisherStat label="Warnings" value={data.safetyData.features.summary.warningCount.toLocaleString(numberLocale)} tone={data.safetyData.features.summary.warningCount > 0 ? "warn" : "neutral"} />
              <PublisherStat label="Critical" value={data.safetyData.features.summary.criticalCount.toLocaleString(numberLocale)} tone={data.safetyData.features.summary.criticalCount > 0 ? "danger" : "neutral"} />
              <PublisherStat label="Stale" value={data.safetyData.features.summary.staleFeatureCount.toLocaleString(numberLocale)} tone={data.safetyData.features.summary.staleFeatureCount > 0 ? "warn" : "neutral"} />
            </div>

            <div className="flight-grid">
              <section className="inline-panel">
                <PanelTitle icon={<Settings2 />} title="Current settings" subtitle="Read-only runtime configuration for public safety feeds." />
                <div className="settings-grid">
                  <SummaryItem label="Enabled sources" value={data.safetyData.config.enabledSources.join(", ") || "-"} />
                  <SummaryItem label="Default bbox" value={formatBbox(data.safetyData.config.defaultBbox)} />
                  <SummaryItem label="Cache TTL" value={`${data.safetyData.config.cacheTtlSeconds}s`} />
                  <SummaryItem label="Stale fallback" value={`${data.safetyData.config.staleIfErrorSeconds}s`} />
                  <SummaryItem label="Cache entries" value={`${data.safetyData.config.cacheMaxEntries}`} />
                  <SummaryItem label="Stale after" value={`${data.safetyData.config.staleAfterSeconds}s`} />
                  <SummaryItem label="Timeout" value={`${data.safetyData.config.requestTimeoutMs} ms`} />
                  <SummaryItem label="Hydro station cap" value={`${data.safetyData.config.hydroMaxStations}`} />
                  <SummaryItem label="Source hit-rate" value={formatPercentValue(safetySourceCacheSummary.hitRate)} />
                  <SummaryItem label="Last result age" value={formatImportAge(safetyGeneratedAgeSeconds)} />
                  <SummaryItem label="Quality signals" value={`${safetyResponseWarningCount}`} />
                </div>
              </section>

              <section className="inline-panel">
                <PanelTitle icon={<MapPinned />} title="Layer registry" subtitle="COP can ingest these layers through /safety-data or projected situation-data." />
                <div className="layer-list">
                  {data.safetyData.layers.map((layer) => (
                    <SafetyLayerRow key={layer.layerId} layer={layer} count={countSafetyLayer(data.safetyData.features.features, layer.layerId)} />
                  ))}
                  {data.safetyData.layers.length === 0 ? <div className="empty-state">{tr("Safety layer metadata is not available.")}</div> : null}
                </div>
              </section>
            </div>

            <div className="flight-grid">
              <section className="inline-panel">
                <PanelTitle icon={<Database />} title="Provider registry" subtitle="License, cadence and production suitability for safety data." />
                <div className="source-list">
                  {data.safetyData.sources.map((source) => (
                    <SafetySourceRow key={source.sourceId} source={source} authConfigured={Boolean(data.safetyData.config.providers.find((provider) => provider.sourceId === source.sourceId)?.authConfigured)} />
                  ))}
                  {data.safetyData.sources.length === 0 ? <div className="empty-state">{tr("Safety source metadata is not available.")}</div> : null}
                </div>
              </section>

              <section className="inline-panel">
                <PanelTitle icon={<ShieldCheck />} title="Provider feature preview" subtitle="GeoJSON features returned by /safety-data/api/v1/features." />
                <div className="situation-feature-list">
                  {data.safetyData.features.features.map((feature) => (
                    <SafetyFeatureRow key={feature.id} feature={feature} />
                  ))}
                  {data.safetyData.features.features.length === 0 ? <div className="empty-state">{tr("No safety features are available from the configured sources.")}</div> : null}
                </div>
              </section>
            </div>

            {data.safetyData.features.warnings.length > 0 ? (
              <div className="notice warn">
                <AlertTriangle size={16} />
                <span>{data.safetyData.features.warnings.join(" ")}</span>
              </div>
            ) : null}

            <div className="notice">
              <CirclePause size={16} />
              <span>{renderedNotice}</span>
            </div>
          </section>
          ) : null}
        </section>
      </section>
      {mobileNetworkInfoOpen ? <MobileNetworkInfoDialog onClose={() => setMobileNetworkInfoOpen(false)} /> : null}
    </main>
      </NumberLocaleContext.Provider>
    </UiLanguageContext.Provider>
  );
}

function Metric({ icon, label, value, detail }: { icon: ReactNode; label: string; value: number | string; detail?: string }) {
  const tr = useUiText();
  const numberLocale = useNumberLocale();
  return (
    <div className="metric">
      <div className="metric-icon">{icon}</div>
      <span>{tr(label)}</span>
      <strong>{typeof value === "number" ? value.toLocaleString(numberLocale) : tr(value)}</strong>
      {detail ? <small>{tr(detail)}</small> : null}
    </div>
  );
}

function emptyTimedObservability(serviceId: string): DashboardObservability["flightData"] {
  return {
    latencyMs: 0,
    payload: {
      serviceId,
      generatedAt: new Date(0).toISOString(),
      status: "unavailable",
      dataFreshness: {
        sourceCount: 0,
        sourcesWithImportAge: 0,
        newestImportAgeSeconds: -1,
        oldestImportAgeSeconds: -1,
        degradedSourceCount: 0,
        warningCount: 0
      }
    }
  };
}

function CommandStat({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) {
  const tr = useUiText();
  return (
    <div className="command-stat">
      <div className="command-stat-icon">{icon}</div>
      <span>{tr(label)}</span>
      <strong>{tr(value)}</strong>
      <small>{tr(detail)}</small>
    </div>
  );
}

function FlowNode({ icon, label, tone }: { icon: ReactNode; label: string; tone: Tone }) {
  const tr = useUiText();
  return (
    <div className={`flow-node ${tone}`}>
      <div>{icon}</div>
      <span>{tr(label)}</span>
    </div>
  );
}

function FlowArrow() {
  return (
    <div className="flow-arrow" aria-hidden="true">
      <span />
      <ArrowRight size={15} />
    </div>
  );
}

function LiveChannelRow({ channel }: { channel: OverviewChannel }) {
  const tr = useUiText();
  return (
    <div className={`channel-row ${channel.tone}`}>
      <div className="channel-icon">{channel.icon}</div>
      <div className="channel-main">
        <div>
          <strong>{tr(channel.label)}</strong>
          <span>{tr(channel.detail)}</span>
        </div>
        <em>{tr(channel.value)}</em>
      </div>
      <ProgressBar value={channel.load} tone={channel.tone} />
    </div>
  );
}

function CacheChannel({ channel }: { channel: { label: string; value: string; detail: string; load: number; tone: Tone } }) {
  const tr = useUiText();
  return (
    <div className={`cache-channel ${channel.tone}`}>
      <div>
        <span>{tr(channel.label)}</span>
        <strong>{tr(channel.value)}</strong>
        <small>{tr(channel.detail)}</small>
      </div>
      <ProgressBar value={channel.load} tone={channel.tone} />
    </div>
  );
}

function LoginGate({
  authSession,
  oidcEnabled,
  onLogin,
  onLogout
}: {
  authSession: AuthSession;
  oidcEnabled: boolean;
  onLogin: () => void;
  onLogout: () => void;
}) {
  const tr = useUiText();
  const authenticatedWithoutRole = authSession.status === "authenticated";
  return (
    <section className="login-gate" aria-label={tr("SIM access gate")}>
      <div className="login-gate-dialog">
        <div className="login-gate-icon">
          <LockKeyhole />
        </div>
        <div className="login-gate-copy">
          <span>{tr("Internet access protected")}</span>
          <h2>{authenticatedWithoutRole ? tr("Keycloak account does not grant SIM console access") : tr("Sign in to CSM SIM")}</h2>
          <p>
            {tr("SIM is an operational provider console. Internet access requires Keycloak authentication and an assigned SIM role.")}
          </p>
        </div>
        <div className="login-benefit-list">
          <span><ShieldCheck size={15} /> {tr("csm-sim-viewer opens operational overview and provider details.")}</span>
          <span><Activity size={15} /> {tr("csm-sim-operator enables scenario runtime controls.")}</span>
          <span><Settings2 size={15} /> {tr("csm-sim-admin enables publisher administration.")}</span>
        </div>
        {authenticatedWithoutRole ? (
          <div className="login-required-note">
            <AlertTriangle size={15} />
            <span>{tr("Ask the Keycloak administrator to assign a SIM role, then sign in again.")}</span>
          </div>
        ) : null}
        <div className="login-gate-actions">
          {oidcEnabled ? (
            authenticatedWithoutRole ? (
              <button type="button" onClick={onLogout}>
                <LogOut size={16} /> {tr("Sign out")}
              </button>
            ) : (
              <button type="button" className="primary-auth" disabled={authSession.status === "authenticating"} onClick={onLogin}>
                <KeyRound size={16} /> {authSession.status === "authenticating" ? tr("Signing in") : tr("Keycloak login")}
              </button>
            )
          ) : (
            <div className="login-required-note">
              <AlertTriangle size={15} />
              <span>{tr("OIDC is not configured. Use an internal deployment profile or enable VITE_SIM_AUTH_MODE=oidc.")}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function OperationsMetricCard({ icon, label, value, detail, tone }: { icon: ReactNode; label: string; value: string; detail: string; tone: Tone }) {
  const tr = useUiText();
  return (
    <div className={`operations-metric ${tone}`}>
      <div className="operations-metric-icon">{icon}</div>
      <span>{tr(label)}</span>
      <strong>{value}</strong>
      <small>{tr(detail)}</small>
    </div>
  );
}

function OperationsAlertRow({ alert }: { alert: OperationsSummary["alerts"][number] }) {
  const language = useUiLanguage();
  const tr = useUiText();
  const tone: Tone = alert.severity === "critical" ? "danger" : alert.severity === "warning" ? "warn" : "neutral";
  const title = localizedOperatorText(language, alert.title, alert.localized?.title);
  const detail = localizedOperatorText(language, alert.detail, alert.localized?.detail);
  const impact = localizedOperatorText(language, alert.impact ?? "", alert.localized?.impact);
  const action = localizedOperatorText(language, alert.action ?? "", alert.localized?.action);
  return (
    <div className={`alert-row ${tone}`}>
      <div className="alert-row-icon">{alert.severity === "critical" ? <AlertTriangle /> : alert.severity === "warning" ? <ShieldAlert /> : <Info />}</div>
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
        {impact ? (
          <small>
            <b>{tr("Impact")}:</b> {impact}
          </small>
        ) : null}
        {action ? (
          <small>
            <b>{tr("Recommended action")}:</b> {action}
          </small>
        ) : null}
      </div>
      <div className="alert-row-tags">
        <StatusPill label={operationAlertCategoryLabel(alert.category)} tone={tone} />
        <StatusPill label={alert.serviceId ?? "sim"} tone={tone} />
      </div>
    </div>
  );
}

function MobileNetworkStatusPanel({ onOpen }: { onOpen: () => void }) {
  const tr = useUiText();
  return (
    <div className="bts-status-panel">
      <div className="bts-status-icon">
        <Signal />
      </div>
      <div className="bts-status-copy">
        <strong>{tr("BTS live status")}</strong>
        <span>{tr("SIM currently provides terrain-aware mobile signal estimates. Authorized live BTS/NOC status is not connected.")}</span>
        <div className="bts-status-tags">
          <StatusPill label="estimated" tone="warn" />
          <StatusPill label="terrain-aware" tone="active" />
          <StatusPill label="future live feed" tone="neutral" />
        </div>
      </div>
      <div className="bts-status-actions">
        <button type="button" onClick={onOpen}>
          <Info size={15} /> {tr("Open status detail")}
        </button>
        <a className="external-link" href="/docs/sim-bts-live-openapi.json" download>
          <Download size={15} /> {tr("Download OpenAPI")}
        </a>
      </div>
    </div>
  );
}

function MobileNetworkInfoDialog({ onClose }: { onClose: () => void }) {
  const tr = useUiText();
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-window bts-info-dialog" role="dialog" aria-modal="true" aria-labelledby="bts-info-title">
        <div className="modal-head">
          <div>
            <span className="ops-kicker">{tr("Mobile network source status")}</span>
            <h2 id="bts-info-title">{tr("BTS live status")}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label={tr("Close")}>
            <X size={15} /> {tr("Close")}
          </button>
        </div>

        <div className="bts-info-grid">
          <div className="bts-info-card warn">
            <span>{tr("Current state")}</span>
            <strong>{tr("Modelled estimate")}</strong>
            <p>{tr("SIM does not receive an authorized live BTS/NOC operator status feed. Current mobile layers are estimates from public measurements, DEM, line-of-sight and infrastructure hints.")}</p>
          </div>
          <div className="bts-info-card active">
            <span>{tr("COP can display now")}</span>
            <strong>{tr("Coverage and line-of-sight estimate")}</strong>
            <p>{tr("COP may show signal quality, technology, estimated coverage, terrain assumptions and a visible data-quality notice. It must not present this as confirmed BTS outage or operator state.")}</p>
          </div>
          <div className="bts-info-card neutral">
            <span>{tr("Future live feed")}</span>
            <strong>{tr("Operator/NOC OpenAPI contract")}</strong>
            <p>{tr("The proposed contract accepts site/cell id, operator, technology, observed status, confidence, outage reason and validity time. When connected, SIM can replace estimates with authoritative live status.")}</p>
          </div>
        </div>

        <div className="modal-actions">
          <a className="external-link" href="/docs/sim-bts-live-openapi.json" download>
            <Download size={15} /> {tr("Download OpenAPI")}
          </a>
          <button type="button" onClick={onClose}>{tr("Close")}</button>
        </div>
      </section>
    </div>
  );
}

function OperationsServiceRow({ service, observability }: { service: OperationsSummaryService; observability?: ServiceObservability }) {
  const tr = useUiText();
  const language = useUiLanguage();
  const tone = service.status === "ok" && service.qualityWarningCount > 0 ? "warn" : operationsStatusTone(service.status);
  const numberLocale = useNumberLocale();
  const cache = observability?.cache ?? service.cache;
  const sourceCaches = [
    ...(observability?.sourceCaches ?? []).map((item) => ({ ...item, kind: "Source cache" })),
    ...(observability?.referenceCaches ?? []).map((item) => ({ ...item, kind: "Reference cache" }))
  ];
  const cacheTone = cacheDisplayTone(cache);
  const openByDefault = (service.productionReadiness !== false && (service.status !== "ok" || service.warningCount > 0)) || service.qualityWarningCount > 0;
  const lifecycleLabel = service.productionReadiness === false ? ` · ${tr("future module")}` : "";
  return (
    <details className={`service-detail ${tone}`} open={openByDefault}>
      <summary className={`service-row ${tone}`} role="row">
        <div>
          <strong>{service.label}</strong>
          <span>
            {service.serviceId}
            {lifecycleLabel}
            {service.qualityWarningCount > 0 ? ` · ${service.qualityWarningCount} ${tr("notice")}` : ""}
          </span>
        </div>
        <StatusPill label={service.status} tone={operationsStatusTone(service.status)} />
        <span>{formatLatencyMs(service.latencyMs)}</span>
        <span>{typeof service.objectCount === "number" ? service.objectCount.toLocaleString(numberLocale) : "-"}</span>
        <span className={`service-cache-summary ${cacheTone}`}>{cache ? `${formatPercentValue(cache.hitRate ?? 0)} · ${tr(cache.state ?? "cache")}` : "-"}</span>
        <span>{freshnessLabel(service)}</span>
        <span className="service-detail-trigger">
          <Info size={14} /> {tr("Detail")}
        </span>
      </summary>

      <div className="service-detail-body">
        <div className="service-detail-grid" aria-label={tr("Provider diagnostics")}>
          <ServiceDiagnosticItem
            icon={<Database />}
            label="Aggregate state"
            value={cache ? tr(cache.state ?? "unknown") : "-"}
            detail={cacheStateExplanation(cache, tr)}
            tone={cacheTone}
          />
          <ServiceDiagnosticItem
            icon={<CheckCircle2 />}
            label="Last success"
            value={formatTime(cache?.lastSuccessAt)}
            detail={cache?.lastSuccessAt ? formatImportAge(secondsSinceIso(cache.lastSuccessAt)) : tr("No successful refresh reported.")}
            tone={cache?.lastSuccessAt ? "safe" : "neutral"}
          />
          <ServiceDiagnosticItem
            icon={<AlertTriangle />}
            label="Last error"
            value={formatTime(cache?.lastErrorAt)}
            detail={cache?.lastErrorAt ? formatImportAge(secondsSinceIso(cache.lastErrorAt)) : tr("No cache error reported.")}
            tone={isCacheCurrentlyFailing(cache) ? "danger" : "neutral"}
          />
          <ServiceDiagnosticItem
            icon={<Gauge />}
            label="Pressure"
            value={formatPercentValue(cache?.pressure ?? 0)}
            detail={cacheCapacityLabel(cache, numberLocale, tr)}
            tone={cache?.state === "pressure" ? "warn" : "neutral"}
          />
        </div>

        {service.warnings.length > 0 ? (
          <ServiceMessageList title="Technical messages" tone="warn" messages={service.warnings.map((message) => localizedServiceWarning(message, language))} />
        ) : null}

        {service.qualityWarnings.length > 0 ? (
          <div className="service-message-list neutral">
            <strong>{tr("Quality notices")}</strong>
            {service.qualityWarnings.map((warning) => {
              const title = localizedOperatorText(language, warning.title, warning.localized?.title);
              const detail = localizedOperatorText(language, warning.detail, warning.localized?.detail);
              const impact = localizedOperatorText(language, warning.impact, warning.localized?.impact);
              const action = localizedOperatorText(language, warning.action, warning.localized?.action);
              return (
                <div className="service-message-row" key={warning.code}>
                  <span>{title}</span>
                  <small>{detail}</small>
                  {impact ? <small>{`${tr("Impact")}: ${impact}`}</small> : null}
                  {action ? <small>{`${tr("Recommended action")}: ${action}`}</small> : null}
                </div>
              );
            })}
          </div>
        ) : null}

        <div className="source-cache-section">
          <div className="service-detail-caption">
            <strong>{tr("Source caches")}</strong>
            <span>{sourceCaches.length > 0 ? `${sourceCaches.length} ${tr("channels")}` : tr("No source-level cache is reported.")}</span>
          </div>
          {sourceCaches.length > 0 ? (
            <div className="source-cache-grid">
              {sourceCaches.map((item) => (
                <SourceCacheRow key={`${item.kind}-${item.sourceId}`} sourceId={item.sourceId} kind={item.kind} cache={item.cache} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </details>
  );
}

function ServiceDiagnosticItem({ icon, label, value, detail, tone }: { icon: ReactNode; label: string; value: string; detail: string; tone: Tone }) {
  const tr = useUiText();
  return (
    <div className={`service-diagnostic-item ${tone}`}>
      <div className="service-diagnostic-icon">{icon}</div>
      <div>
        <span>{tr(label)}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}

function ServiceMessageList({ title, tone, messages }: { title: string; tone: Tone; messages: string[] }) {
  const tr = useUiText();
  return (
    <div className={`service-message-list ${tone}`}>
      <strong>{tr(title)}</strong>
      {messages.map((message) => (
        <div className="service-message-row" key={message}>
          <span>{message}</span>
        </div>
      ))}
    </div>
  );
}

function SourceCacheRow({ sourceId, kind, cache }: { sourceId: string; kind: string; cache: CacheObservability }) {
  const tr = useUiText();
  const numberLocale = useNumberLocale();
  const tone = cacheDisplayTone(cache);
  return (
    <div className={`source-cache-row ${tone}`}>
      <div>
        <strong>{sourceId}</strong>
        <span>{tr(kind)}</span>
      </div>
      <StatusPill label={tr(cache.state)} tone={tone} />
      <span>{formatPercentValue(cache.hitRate)}</span>
      <span>{`${cache.errors.toLocaleString(numberLocale)} ${tr("errors")}`}</span>
      <span>{cacheLastEventLabel(cache)}</span>
    </div>
  );
}

function localizedOperatorText(language: UiLanguage, fallback: string, localized?: { cs: string; en: string }): string {
  return localized?.[language] ?? fallback;
}

function operationAlertCategoryLabel(category: OperationsSummary["alerts"][number]["category"]): string {
  switch (category) {
    case "data_quality":
      return "data quality";
    case "operational_check":
      return "operational check";
    case "simulation":
      return "simulation";
    case "technical":
    default:
      return "technical";
  }
}

function localizedServiceWarning(message: string, language: UiLanguage): string {
  if (language !== "cs") {
    return message;
  }
  if (message === "The operation was aborted due to timeout") {
    return "operace byla ukončena kvůli timeoutu";
  }
  const healthStatus = message.match(/^health status (.+)$/);
  if (healthStatus?.[1]) {
    return `health stav ${localizedStatusCs(healthStatus[1])}`;
  }
  const observabilityStatus = message.match(/^observability status (.+)$/);
  if (observabilityStatus?.[1]) {
    return `observability stav ${localizedStatusCs(observabilityStatus[1])}`;
  }
  const sourceStatus = message.match(/^(.+) status (.+)$/);
  if (sourceStatus?.[1] && sourceStatus[2]) {
    return `${sourceStatus[1]} stav ${localizedStatusCs(sourceStatus[2])}`;
  }
  const cacheState = message.match(/^(.+) cache state (.+)$/);
  if (cacheState?.[1] && cacheState[2]) {
    return `${cacheState[1]} cache stav ${localizedStatusCs(cacheState[2])}`;
  }
  const cacheErrors = message.match(/^(.+) cache has ([0-9]+) errors?$/);
  if (cacheErrors) {
    return `${cacheErrors[1]} cache hlásí ${cacheErrors[2]} chyb`;
  }
  return message;
}

function localizedStatusCs(status: string): string {
  switch (status) {
    case "critical":
      return "kritický";
    case "cold":
      return "studený";
    case "degraded":
      return "degradovaný";
    case "failed":
      return "selhal";
    case "ok":
      return "v pořádku";
    case "pressure":
      return "pod tlakem";
    case "warm":
      return "zahřátý";
    default:
      return status;
  }
}

function ReadinessItem({ icon, label, value, detail, tone }: { icon: ReactNode; label: string; value: string; detail: string; tone: Tone }) {
  const tr = useUiText();
  return (
    <div className={`readiness-item ${tone}`}>
      <div className="readiness-icon">{icon}</div>
      <div>
        <span>{tr(label)}</span>
        <strong>{tr(value)}</strong>
        <small>{tr(detail)}</small>
      </div>
    </div>
  );
}

function FeedSignal({ icon, label, service }: { icon: ReactNode; label: string; service?: OperationsSummaryService }) {
  const isFuture = service?.productionReadiness === false;
  const tone = isFuture ? "neutral" : service?.status === "ok" && (service.qualityWarningCount ?? 0) > 0 ? "warn" : operationsStatusTone(service?.status ?? "unknown");
  const tr = useUiText();
  const qualityDetail = service && service.qualityWarningCount > 0 ? ` · ${service.qualityWarningCount} ${tr("notice")}` : "";
  const statusLabel = isFuture ? "future" : service?.status ?? "unknown";
  const diagnosticDetail = isFuture && service ? ` · ${tr("diagnostic")} ${tr(service.status)}` : "";
  return (
    <div className={`feed-signal ${tone}`}>
      <div>{icon}</div>
      <span>{tr(label)}</span>
      <strong>{tr(statusLabel)}</strong>
      <small>{service ? `${service.enabledSources.length} ${tr("feeds")} · ${formatLatencyMs(service.latencyMs)}${qualityDetail}${diagnosticDetail}` : tr("not reported")}</small>
    </div>
  );
}

function ProgressBar({ value, tone }: { value: number; tone: Tone }) {
  return (
    <div className={`progress-bar ${tone}`} aria-label={`${Math.round(value)} percent`}>
      <span style={{ width: `${Math.max(4, Math.min(100, value))}%` }} />
    </div>
  );
}

function PanelTitle({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle: string }) {
  const tr = useUiText();
  return (
    <div className="panel-title">
      <div className="panel-icon">{icon}</div>
      <div>
        <h2>{tr(title)}</h2>
        <p>{tr(subtitle)}</p>
      </div>
    </div>
  );
}

function NavButton({
  section,
  activeSection,
  onSelect,
  icon,
  label,
  locked = false,
  lockReason
}: {
  section: AppSection;
  activeSection: AppSection;
  onSelect: (section: AppSection) => void;
  icon: ReactNode;
  label: string;
  locked?: boolean;
  lockReason?: string;
}) {
  const tr = useUiText();
  return (
    <button
      type="button"
      className={`nav-item ${activeSection === section ? "selected" : ""} ${locked ? "locked" : ""}`}
      disabled={locked}
      title={locked ? tr(lockReason ?? "") : undefined}
      onClick={() => onSelect(section)}
      aria-current={activeSection === section ? "page" : undefined}
    >
      {icon}
      <span>{tr(label)}</span>
      {locked ? <LockKeyhole className="nav-lock" size={13} /> : null}
    </button>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  const tr = useUiText();
  return (
    <div>
      <span>{tr(label)}</span>
      <strong>{tr(value)}</strong>
    </div>
  );
}

function FlightSourceRow({ source, authConfigured }: { source: FlightDataSource; authConfigured: boolean }) {
  const tr = useUiText();
  return (
    <div className="source-row">
      <div>
        <strong>{source.label}</strong>
        <span>
          {source.sourceId} · {tr("priority")} {source.priority}
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
  const tr = useUiText();
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
        <StatusPill label={`${track.deduplication.mergedRecordCount} ${tr("merged")}`} tone={track.deduplication.mergedRecordCount > 1 ? "active" : "neutral"} />
        <StatusPill label={track.quality.stale ? "stale" : "current"} tone={track.quality.stale ? "warn" : "safe"} />
      </div>
    </div>
  );
}

function SituationLayerRow({ layer, count }: { layer: SituationDataLayer; count: number }) {
  const tr = useUiText();
  return (
    <div className="layer-row">
      <div>
        <strong>{layer.label}</strong>
        <span>{layer.description}</span>
      </div>
      <div className="source-tags">
        <StatusPill label={layer.layerId} tone={layer.defaultVisible ? "active" : "neutral"} />
        <StatusPill label={`${count} ${tr("shown")}`} tone={count > 0 ? "safe" : "neutral"} />
      </div>
      <small>
        {layer.geometryTypes.join(", ")}
        {layer.expectedCadenceSeconds ? ` · ${formatCadence(layer.expectedCadenceSeconds)}` : ""}
      </small>
    </div>
  );
}

function SituationSourceRow({ source, authConfigured }: { source: SituationDataSource; authConfigured: boolean }) {
  const tr = useUiText();
  return (
    <div className="source-row">
      <div>
        <strong>{source.label}</strong>
        <span>
          {source.sourceId} · {tr("priority")} {source.priority} · {source.layers.join(", ")}
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

function SafetyLayerRow({ layer, count }: { layer: SafetyDataLayer; count: number }) {
  const tr = useUiText();
  return (
    <div className="layer-row">
      <div>
        <strong>{layer.label}</strong>
        <span>{layer.description}</span>
      </div>
      <div className="source-tags">
        <StatusPill label={layer.layerId} tone={layer.defaultVisible ? "active" : "neutral"} />
        <StatusPill label={`${count} ${tr("shown")}`} tone={count > 0 ? "safe" : "neutral"} />
      </div>
      <small>
        {layer.geometryTypes.join(", ")}
        {layer.expectedCadenceSeconds ? ` · ${formatCadence(layer.expectedCadenceSeconds)}` : ""}
      </small>
    </div>
  );
}

function SafetySourceRow({ source, authConfigured }: { source: SafetyDataSource; authConfigured: boolean }) {
  const tr = useUiText();
  return (
    <div className="source-row">
      <div>
        <strong>{source.label}</strong>
        <span>
          {source.sourceId} · {tr("priority")} {source.priority} · {source.layers.join(", ")}
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

function SafetyFeatureRow({ feature }: { feature: SafetyDataFeature }) {
  return (
    <div className={`situation-feature-row ${feature.properties.severity} ${feature.properties.stale ? "stale" : ""}`}>
      <div>
        <strong>{feature.properties.headline}</strong>
        <span>
          {feature.properties.layer} · {feature.properties.category} · {feature.properties.sourceId}
        </span>
      </div>
      <div className="flight-track-metrics">
        <span>{formatSafetyGeometry(feature)}</span>
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

function TakLayerRow({ layer, count }: { layer: TakGatewayLayer; count: number }) {
  const tr = useUiText();
  return (
    <div className="layer-row">
      <div>
        <strong>{layer.label}</strong>
        <span>{layer.description}</span>
      </div>
      <div className="source-tags">
        <StatusPill label={layer.layerId} tone={layer.defaultVisible ? "active" : "neutral"} />
        <StatusPill label={`${count} ${tr("shown")}`} tone={count > 0 ? "safe" : "neutral"} />
      </div>
      <small>
        {layer.geometryTypes.join(", ")}
        {layer.expectedCadenceSeconds ? ` · ${formatCadence(layer.expectedCadenceSeconds)}` : ""}
      </small>
    </div>
  );
}

function TakSourceRow({ source }: { source: TakGatewaySource }) {
  const tr = useUiText();
  return (
    <div className="source-row">
      <div>
        <strong>{source.label}</strong>
        <span>
          {source.sourceId} · {tr("priority")} {source.priority} · {source.layers.join(", ")}
        </span>
      </div>
      <div className="source-tags">
        <StatusPill label={source.enabled ? "enabled" : "disabled"} tone={source.enabled ? "safe" : "neutral"} />
        <StatusPill label={source.mode} tone={source.mode === "live" ? "active" : "neutral"} />
        <StatusPill label="partner data" tone="warn" />
      </div>
      <div className="source-license">
        <span>{source.license.name}</span>
        <StatusPill label={source.license.commercialUse.replaceAll("_", " ")} tone={licenseTone(source.license.commercialUse)} />
      </div>
      <small>{source.license.attribution}</small>
    </div>
  );
}

function TakFeatureRow({ feature }: { feature: TakGatewayFeature }) {
  return (
    <div className={`situation-feature-row ${feature.properties.stale ? "stale" : ""}`}>
      <div>
        <strong>{feature.properties.label}</strong>
        <span>
          {feature.properties.layer} · {feature.properties.category} · {feature.properties.sourceId}
        </span>
      </div>
      <div className="flight-track-metrics">
        <span>{formatTakGeometry(feature)}</span>
        <span>{formatTime(feature.properties.observedAt)}</span>
        <span>{formatConfidence(feature.properties.confidence)}</span>
        <span>{formatMetrics(feature.properties.metrics)}</span>
      </div>
      <div className="flight-track-tags">
        <StatusPill label={feature.properties.affiliation} tone={takAffiliationTone(feature.properties.affiliation)} />
        <StatusPill label={feature.properties.stale ? "stale" : "current"} tone={feature.properties.stale ? "warn" : "safe"} />
      </div>
    </div>
  );
}

function StatusPill({ label, tone }: { label: string; tone: Tone }) {
  const tr = useUiText();
  return <span className={`status-pill ${tone}`}>{tr(label)}</span>;
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
  const tr = useUiText();
  const numberLocale = useNumberLocale();

  return (
    <button type="button" className={`scenario-card ${selected ? "selected" : ""} ${active ? "active-runtime" : ""}`} onClick={onSelect}>
      <span className="scenario-card-main">
        <strong>{scenario.name}</strong>
        <span>{scenario.description ?? tr("Synthetic COP scenario")}</span>
      </span>
      <span className="scenario-card-tags">
        {active ? <StatusPill label="active" tone="active" /> : null}
        <StatusPill label={state} tone={runtimeStateTone(state)} />
      </span>
      <span className="scenario-card-meta">
        <span>{objectCount.toLocaleString(numberLocale)} {tr("tracks")}</span>
        <span>{formatScenarioDuration(scenario.durationSeconds)}</span>
        <span>{tr("seed")} {scenario.seed}</span>
        <span>{scenario.scenarioId?.slice(0, 8) ?? tr("new")}</span>
      </span>
    </button>
  );
}

function ActionButton({
  icon,
  label,
  disabled,
  title,
  onClick
}: {
  icon: ReactNode;
  label: string;
  disabled: boolean;
  title?: string;
  onClick: () => void;
}) {
  const tr = useUiText();
  return (
    <button type="button" disabled={disabled} title={title} onClick={onClick}>
      {icon} {tr(label)}
    </button>
  );
}

function PublisherStat({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  const tr = useUiText();
  return (
    <div className={`publisher-stat ${tone}`}>
      <span>{tr(label)}</span>
      <strong>{value}</strong>
    </div>
  );
}

function QueueRow({ item }: { item: QueueItem }) {
  const affiliation = item.event.payload.affiliation ?? "UNKNOWN";
  const tr = useUiText();
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
        <span>{item.attempts} {tr("attempts")}</span>
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

function operationsStatusTone(status: string): Tone {
  if (status === "ok") {
    return "safe";
  }
  if (status === "critical") {
    return "danger";
  }
  if (status === "degraded") {
    return "warn";
  }
  return "neutral";
}

function isCacheCurrentlyFailing(cache: CacheDisplay | undefined): boolean {
  if (!cache) {
    return false;
  }
  return cache.state === "degraded" || isAfter(cache.lastErrorAt, cache.lastSuccessAt);
}

function cacheDisplayTone(cache: CacheDisplay | undefined): Tone {
  if (!cache) {
    return "neutral";
  }
  if (isCacheCurrentlyFailing(cache)) {
    return "danger";
  }
  if (cache.state === "pressure") {
    return "warn";
  }
  if (cache.state === "warm" || cache.state === "ok") {
    return "safe";
  }
  return "neutral";
}

function cacheStateExplanation(cache: CacheDisplay | undefined, tr: (source: string) => string): string {
  if (!cache) {
    return tr("No cache telemetry reported.");
  }
  if (isCacheCurrentlyFailing(cache)) {
    return tr("Current failure: last error is newer than last successful refresh.");
  }
  if (cache.state === "pressure" || (cache.pressure ?? 0) >= 0.95) {
    return tr("Capacity pressure only; service remains available.");
  }
  if (cache.state === "cold") {
    return tr("Cold cache; it warms after the next request.");
  }
  return tr("Cache serving normally.");
}

function cacheCapacityLabel(cache: CacheDisplay | undefined, numberLocale: string, tr: (source: string) => string): string {
  if (!cache) {
    return "-";
  }
  const entries = cache.entries ?? 0;
  const maxEntries = cache.maxEntries;
  if (typeof maxEntries === "number" && maxEntries > 0) {
    return `${entries.toLocaleString(numberLocale)} / ${maxEntries.toLocaleString(numberLocale)} ${tr("entries")}`;
  }
  return `${entries.toLocaleString(numberLocale)} ${tr("entries")}`;
}

function cacheLastEventLabel(cache: CacheDisplay): string {
  if (isCacheCurrentlyFailing(cache) && cache.lastErrorAt) {
    return formatTime(cache.lastErrorAt);
  }
  return cache.lastSuccessAt ? formatTime(cache.lastSuccessAt) : "-";
}

function formatDeadLetterCount(count: number, numberLocale: string, tr: (source: string) => string): string {
  return `${count.toLocaleString(numberLocale)} ${tr("dead-letter events")}`;
}

function operationsStatusTitle(status: string): string {
  if (status === "ok") {
    return "SIM is operational";
  }
  if (status === "critical") {
    return "Action required";
  }
  if (status === "degraded") {
    return "Degraded but serving";
  }
  return "Operations summary unavailable";
}

function summarizeOperationsCache(services: OperationsSummaryService[]): { hitRate: number; errors: number } {
  const caches = services.map((service) => service.cache).filter((cache): cache is NonNullable<OperationsSummaryService["cache"]> => Boolean(cache));
  if (caches.length === 0) {
    return { hitRate: 0, errors: 0 };
  }
  const hitRate = caches.reduce((sum, cache) => sum + (cache.hitRate ?? 0), 0) / caches.length;
  const errors = caches.reduce((sum, cache) => sum + (cache.errors ?? 0), 0);
  return { hitRate, errors };
}

function summarizeOperationsFreshness(services: OperationsSummaryService[]): { value: string; tone: Tone } {
  const ages = services
    .map((service) => service.dataFreshness?.oldestImportAgeSeconds)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  if (ages.length === 0) {
    return { value: "n/a", tone: "neutral" };
  }
  const oldest = Math.max(...ages);
  return {
    value: formatImportAge(oldest),
    tone: oldest > 7 * 86_400 ? "warn" : oldest > 24 * 3600 ? "neutral" : "safe"
  };
}

function freshnessLabel(service: OperationsSummaryService): string {
  const oldest = service.dataFreshness?.oldestImportAgeSeconds;
  if (typeof oldest !== "number") {
    return "-";
  }
  return formatImportAge(oldest);
}

function sectionMeta(section: AppSection, tr: (source: string) => string): { kicker: string; title: string; description: string } {
  switch (section) {
    case "scenario":
      return {
        kicker: tr("Scenario control"),
        title: tr("Scenario execution"),
        description: tr("Start, pause and inspect deterministic synthetic movement for COP validation.")
      };
    case "flight-data":
      return {
        kicker: tr("Public flight aggregate"),
        title: tr("Flight Data source"),
        description: tr("Monitor collected flight observations, deduplication, provider licenses and runtime settings.")
      };
    case "situation-data":
      return {
        kicker: tr("Public situation aggregate"),
        title: tr("Situation Data source"),
        description: tr("Monitor weather, ground, mobile and traffic context prepared for COP map layers.")
      };
    case "tak-gateway":
      return {
        kicker: tr("Partner CoT ingest"),
        title: tr("TAK Gateway"),
        description: tr("Monitor Cursor-on-Target ingest, retention, stale state and COP projection readiness.")
      };
    case "publisher":
      return {
        kicker: tr("COP integration"),
        title: tr("COP publisher"),
        description: tr("Watch delivery state, retained events, retry queue and ingest failures.")
      };
    case "ai":
      return {
        kicker: tr("Scenario drafting"),
        title: tr("AI Scenario Assistant"),
        description: tr("Generate guarded scenario drafts before human acceptance.")
      };
    case "safety":
      return {
        kicker: tr("Public safety aggregate"),
        title: tr("Safety Data source"),
        description: tr("Monitor official warnings, flood observations, source licensing and cache settings.")
      };
    case "overview":
    default:
      return {
        kicker: tr("Pilot control station"),
        title: tr("Simulator overview"),
        description: tr("Compact operational status across runtime, COP publishing and external data gateways.")
      };
  }
}

function roleAllows(roles: SimRole[], required: SimRole): boolean {
  return roles.some((role) => {
    if (role === required || role === "SIM_ADMIN") {
      return true;
    }
    if (role === "SIM_OPERATOR" && required === "SIM_VIEWER") {
      return true;
    }
    return role === "SIM_AI_ADMIN" && required === "SIM_AI_USER";
  });
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

function formatBbox(bbox: { west: number; south: number; east: number; north: number }): string {
  return `${formatCoordinate(bbox.west)}, ${formatCoordinate(bbox.south)}, ${formatCoordinate(bbox.east)}, ${formatCoordinate(bbox.north)}`;
}

function formatSituationSourceTtls(ttls: SituationDataConfig["sourceCacheTtlSeconds"]): string {
  return [
    `weather ${ttls.openMeteo}s`,
    `mobile net ${ttls.mobileNetwork}s`,
    `coverage ${ttls.mobileCoverage}s`,
    `aviation ${ttls.aviationWeather}s`,
    `CHMI air ${ttls.chmiAirQuality}s`,
    `CHMI meteo ${ttls.chmiWeatherStations}s`,
    `safety ${ttls.safetyData}s`,
    `OSM DB ${ttls.osmPostgis}s`,
    `Overpass ${ttls.osmOverpass}s`,
    `CTU ${ttls.ctuStationaryMobile}s`,
    `PID RT ${ttls.pidGtfsRt}s`,
    `GTFS stops ${ttls.publicTransitStatic}s`,
    `IDS JMK ${ttls.idsjmkVehiclePositions}s`,
    `SŽ trains ${ttls.spravaZeleznicTrains}s`,
    `roads ${ttls.roadSrtiLod}s`
  ].join(" / ");
}

function formatImportAge(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return "-";
  }
  if (seconds < 0) {
    return "n/a";
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)} min`;
  }
  if (seconds < 86_400) {
    return `${Math.round(seconds / 3600)} h`;
  }
  return `${Math.round(seconds / 86_400)} d`;
}

function secondsSinceIso(value: string | undefined): number {
  if (!value) {
    return -1;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? Math.max(0, Math.round((Date.now() - timestamp) / 1000)) : -1;
}

function summarizeCacheObservability(caches: Array<CacheObservability | undefined>): { hits: number; misses: number; requests: number; hitRate: number; errors: number } {
  const totals = caches.reduce(
    (summary, cache) => {
      if (!cache) {
        return summary;
      }
      summary.hits += cache.hits;
      summary.misses += cache.misses;
      summary.errors += cache.errors;
      return summary;
    },
    { hits: 0, misses: 0, errors: 0 }
  );
  const requests = totals.hits + totals.misses;
  return {
    ...totals,
    requests,
    hitRate: requests > 0 ? totals.hits / requests : 0
  };
}

function summarizeImportFreshness(services: ServiceObservability[]): { value: string; detail: string; load: number; tone: Tone } {
  const freshness = services
    .map((service) => service.dataFreshness)
    .filter((item): item is NonNullable<ServiceObservability["dataFreshness"]> => Boolean(item));
  const newestAges = freshness.map((item) => item.newestImportAgeSeconds).filter((age) => age >= 0);
  const oldestAges = freshness.map((item) => item.oldestImportAgeSeconds).filter((age) => age >= 0);
  const warningCount = freshness.reduce((sum, item) => sum + item.warningCount + item.degradedSourceCount, 0);

  if (newestAges.length === 0) {
    return {
      value: "n/a",
      detail: `${warningCount} quality signals`,
      load: warningCount > 0 ? 45 : 25,
      tone: warningCount > 0 ? "warn" : "neutral"
    };
  }

  const newest = Math.min(...newestAges);
  const oldest = Math.max(...oldestAges);
  const load = Math.max(10, 100 - boundedPercent(oldest, 7 * 24 * 3600));
  return {
    value: formatImportAge(newest),
    detail: `oldest ${formatImportAge(oldest)}, ${warningCount} quality signals`,
    load,
    tone: warningCount > 0 || oldest > 7 * 24 * 3600 ? "warn" : "safe"
  };
}

function formatPercentValue(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0%";
  }
  return `${Math.round(value * 100)}%`;
}

function formatLatencyMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "n/a";
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}s`;
  }
  return `${Math.round(value)} ms`;
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

function boundedPercent(value: number, maxValue: number): number {
  if (maxValue <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round((value / maxValue) * 100)));
}

function estimateCacheProtectionScore(maxEntries: number, ttlValues: number[]): number {
  const capacityScore = boundedPercent(maxEntries, 20_000);
  const ttlScore = ttlValues.length > 0 ? boundedPercent(Math.max(...ttlValues), 21_600) : 0;
  const spreadScore = boundedPercent(ttlValues.length, 10);
  return Math.round(capacityScore * 0.35 + ttlScore * 0.35 + spreadScore * 0.3);
}

function estimateLiveLoadPercent(input: {
  generatedPerMinute: number;
  publishedPerMinute: number;
  dataDeltaPerMinute: number;
  queueSize: number;
  deadLetterSize: number;
  liveDataProducts: number;
  running: boolean;
  warningCount: number;
}): number {
  const runtimeBase = input.running ? 20 : 7;
  const eventPressure = Math.min(26, Math.max(input.generatedPerMinute, input.publishedPerMinute) / 2.4);
  const dataPressure = Math.min(24, input.liveDataProducts / 18);
  const queuePressure = Math.min(22, input.queueSize * 2.2 + input.deadLetterSize * 4.8);
  const warningPressure = Math.min(12, input.warningCount * 1.5);
  const deltaPressure = Math.min(16, input.dataDeltaPerMinute / 3);
  return Math.max(0, Math.min(100, Math.round(runtimeBase + eventPressure + dataPressure + queuePressure + warningPressure + deltaPressure)));
}

function formatRatePerMinute(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0/min";
  }
  if (value < 10) {
    return `${value.toFixed(1)}/min`;
  }
  return `${Math.round(value).toLocaleString("cs-CZ")}/min`;
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

function formatSafetyGeometry(feature: SafetyDataFeature): string {
  if (feature.geometry.type !== "Point" || !Array.isArray(feature.geometry.coordinates)) {
    return feature.geometry.type;
  }
  const [lon, lat] = feature.geometry.coordinates;
  return typeof lon === "number" && typeof lat === "number" ? `${formatCoordinate(lat)}, ${formatCoordinate(lon)}` : "position n/a";
}

function formatTakGeometry(feature: TakGatewayFeature): string {
  const [lon, lat] = feature.geometry.coordinates;
  return `${formatCoordinate(lat)}, ${formatCoordinate(lon)}`;
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

function countSafetyLayer(features: SafetyDataFeature[], layerId: SafetyLayerId): number {
  return features.filter((feature) => feature.properties.layer === layerId).length;
}

function countTakLayer(features: TakGatewayFeature[], layerId: TakLayerId): number {
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

function takAffiliationTone(value: TakGatewayFeature["properties"]["affiliation"]): Tone {
  if (value === "friend") {
    return "safe";
  }
  if (value === "hostile") {
    return "danger";
  }
  if (value === "neutral") {
    return "active";
  }
  return "neutral";
}
