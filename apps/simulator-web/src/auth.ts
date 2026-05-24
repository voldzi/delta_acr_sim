export type AuthMode = "token" | "hybrid" | "oidc";
export type AuthStatus = "anonymous" | "authenticating" | "authenticated" | "error";

export interface AuthConfig {
  clientId: string;
  issuer: string;
  mode: AuthMode;
  scope: string;
}

export interface AuthProfile {
  email?: string;
  name: string;
  subjectId?: string;
  username: string;
}

export interface AuthSession {
  accessToken?: string;
  error?: string;
  expiresAt?: number;
  idToken?: string;
  profile?: AuthProfile;
  refreshToken?: string;
  status: AuthStatus;
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  id_token?: string;
  refresh_token?: string;
}

interface StoredAuthSession {
  accessToken: string;
  expiresAt: number;
  idToken?: string;
  profile?: AuthProfile;
  refreshToken?: string;
}

const callbackStateKey = "csm-sim.oidc.callback.v1";
const sessionKey = "csm-sim.oidc.session.v1";

export function readAuthConfig(): AuthConfig {
  return {
    clientId: import.meta.env.VITE_SIM_OIDC_CLIENT_ID ?? "csm-sim-web",
    issuer: normalizeIssuer(import.meta.env.VITE_SIM_OIDC_ISSUER ?? ""),
    mode: readAuthMode(import.meta.env.VITE_SIM_AUTH_MODE),
    scope: import.meta.env.VITE_SIM_OIDC_SCOPE ?? "openid profile email"
  };
}

export function createInitialAuthSession(config: AuthConfig): AuthSession {
  if (!isOidcEnabled(config)) {
    return { status: "anonymous" };
  }
  const stored = readStoredSession();
  if (stored && stored.expiresAt > Date.now() + 30_000) {
    return { ...stored, status: "authenticated" };
  }
  return { status: "anonymous" };
}

export function isOidcEnabled(config: AuthConfig): boolean {
  return config.mode !== "token" && Boolean(config.issuer && config.clientId);
}

export async function initializeAuth(config: AuthConfig): Promise<AuthSession> {
  if (!isOidcEnabled(config)) {
    return createInitialAuthSession(config);
  }

  const callback = readCallbackParams();
  if (callback.error) {
    clearCallbackState();
    removeCallbackParams();
    return { status: "error", error: callback.error };
  }
  if (callback.code && callback.state) {
    return exchangeAuthorizationCode(config, callback.code, callback.state);
  }

  const stored = readStoredSession();
  if (!stored) {
    return { status: "anonymous" };
  }
  if (stored.expiresAt > Date.now() + 30_000) {
    return { ...stored, status: "authenticated" };
  }
  if (stored.refreshToken) {
    const refreshed = await refreshSession(config, stored.refreshToken);
    if (refreshed) {
      return refreshed;
    }
  }
  clearStoredSession();
  return { status: "anonymous" };
}

export async function beginLogin(config: AuthConfig): Promise<void> {
  if (!isOidcEnabled(config)) {
    return;
  }

  const state = randomBase64Url(24);
  const verifier = randomBase64Url(48);
  const challenge = await sha256Base64Url(verifier);
  const redirectUri = currentRedirectUri();
  writeCallbackState({ redirectUri, returnUrl: currentReturnUrl(), state, verifier });

  const url = new URL(`${config.issuer}/protocol/openid-connect/auth`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", state);
  window.location.assign(url.toString());
}

export function endSession(config: AuthConfig, session: AuthSession): void {
  clearStoredSession();
  clearCallbackState();
  if (!isOidcEnabled(config)) {
    return;
  }

  const url = new URL(`${config.issuer}/protocol/openid-connect/logout`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("post_logout_redirect_uri", currentRedirectUri());
  if (session.idToken) {
    url.searchParams.set("id_token_hint", session.idToken);
  }
  window.location.assign(url.toString());
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) {
    return {};
  }
  try {
    return JSON.parse(decodeBase64Url(payload)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readAuthMode(value: unknown): AuthMode {
  return value === "oidc" || value === "hybrid" ? value : "token";
}

async function exchangeAuthorizationCode(config: AuthConfig, code: string, state: string): Promise<AuthSession> {
  const callbackState = readCallbackState();
  if (!callbackState || callbackState.state !== state) {
    clearCallbackState();
    removeCallbackParams();
    return { status: "error", error: "OIDC callback state does not match." };
  }

  const response = await fetch(`${config.issuer}/protocol/openid-connect/token`, {
    body: new URLSearchParams({
      client_id: config.clientId,
      code,
      code_verifier: callbackState.verifier,
      grant_type: "authorization_code",
      redirect_uri: callbackState.redirectUri
    }),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    method: "POST"
  });

  clearCallbackState();
  removeCallbackParams(callbackState.returnUrl);
  if (!response.ok) {
    return { status: "error", error: `OIDC token exchange failed: ${response.status}` };
  }

  return persistTokenResponse((await response.json()) as TokenResponse);
}

async function refreshSession(config: AuthConfig, refreshToken: string): Promise<AuthSession | null> {
  const response = await fetch(`${config.issuer}/protocol/openid-connect/token`, {
    body: new URLSearchParams({
      client_id: config.clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    }),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    method: "POST"
  });
  if (!response.ok) {
    return null;
  }
  return persistTokenResponse((await response.json()) as TokenResponse);
}

function persistTokenResponse(tokenResponse: TokenResponse): AuthSession {
  const payload = decodeJwtPayload(tokenResponse.access_token);
  const expiresAt = Date.now() + Math.max(30, tokenResponse.expires_in ?? 300) * 1000;
  const stored: StoredAuthSession = {
    accessToken: tokenResponse.access_token,
    expiresAt,
    idToken: tokenResponse.id_token,
    profile: profileFromPayload(payload),
    refreshToken: tokenResponse.refresh_token
  };
  window.sessionStorage.setItem(sessionKey, JSON.stringify(stored));
  return { ...stored, status: "authenticated" };
}

function profileFromPayload(payload: Record<string, unknown>): AuthProfile {
  const preferredUsername = optionalString(payload.preferred_username);
  const name = optionalString(payload.name) ?? preferredUsername ?? optionalString(payload.email) ?? "Operator";
  return {
    email: optionalString(payload.email),
    name,
    subjectId: optionalString(payload.sub),
    username: preferredUsername ?? name
  };
}

function readStoredSession(): StoredAuthSession | null {
  try {
    const raw = window.sessionStorage.getItem(sessionKey);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<StoredAuthSession>;
    return typeof parsed.accessToken === "string" && typeof parsed.expiresAt === "number" && Number.isFinite(parsed.expiresAt)
      ? (parsed as StoredAuthSession)
      : null;
  } catch {
    return null;
  }
}

function clearStoredSession(): void {
  window.sessionStorage.removeItem(sessionKey);
}

function readCallbackParams(): { code?: string; error?: string; state?: string } {
  const params = new URLSearchParams(window.location.search);
  return {
    code: params.get("code") ?? undefined,
    error: params.get("error_description") ?? params.get("error") ?? undefined,
    state: params.get("state") ?? undefined
  };
}

function readCallbackState(): { redirectUri: string; returnUrl: string; state: string; verifier: string } | null {
  try {
    const raw = window.sessionStorage.getItem(callbackStateKey);
    return raw ? (JSON.parse(raw) as { redirectUri: string; returnUrl: string; state: string; verifier: string }) : null;
  } catch {
    return null;
  }
}

function writeCallbackState(value: { redirectUri: string; returnUrl: string; state: string; verifier: string }): void {
  window.sessionStorage.setItem(callbackStateKey, JSON.stringify(value));
}

function clearCallbackState(): void {
  window.sessionStorage.removeItem(callbackStateKey);
}

function removeCallbackParams(returnUrl?: string): void {
  if (returnUrl) {
    window.history.replaceState({}, document.title, returnUrl);
    return;
  }

  const url = new URL(window.location.href);
  ["code", "state", "session_state", "error", "error_description", "iss"].forEach((name) => url.searchParams.delete(name));
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
}

function currentRedirectUri(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

function currentReturnUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return decodeURIComponent(
    Array.from(atob(base64))
      .map((character) => `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join("")
  );
}

function normalizeIssuer(value: string): string {
  return value.replace(/\/+$/u, "");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
