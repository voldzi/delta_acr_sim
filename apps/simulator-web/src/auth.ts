export type AuthMode = "token" | "hybrid" | "oidc";
export type AuthStatus = "anonymous" | "authenticating" | "authenticated" | "error";

export interface AuthConfig {
  allowManualTokenLogin: boolean;
  clientId: string;
  issuer: string;
  mode: AuthMode;
  publicReadEnabled: boolean;
  scope: string;
}

export interface AuthProfile {
  email?: string;
  name: string;
  subjectId?: string;
  username: string;
}

export type SimRole = "SIM_ADMIN" | "SIM_OPERATOR" | "SIM_VIEWER" | "SIM_AI_USER" | "SIM_AI_ADMIN";

export interface AuthSession {
  accessToken?: string;
  error?: string;
  expiresAt?: number;
  idToken?: string;
  profile?: AuthProfile;
  refreshToken?: string;
  roles?: SimRole[];
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
  roles?: SimRole[];
}

const callbackStateKey = "csm-sim.oidc.callback.v1";
const sessionKey = "csm-sim.oidc.session.v1";

export function readAuthConfig(): AuthConfig {
  const mode = readAuthMode(import.meta.env.VITE_SIM_AUTH_MODE);
  return {
    allowManualTokenLogin: readBoolean(import.meta.env.VITE_SIM_ALLOW_TOKEN_LOGIN, mode === "token"),
    clientId: import.meta.env.VITE_SIM_OIDC_CLIENT_ID ?? "csm-sim-web",
    issuer: normalizeIssuer(import.meta.env.VITE_SIM_OIDC_ISSUER ?? ""),
    mode,
    publicReadEnabled: readBoolean(import.meta.env.VITE_SIM_PUBLIC_READ_ENABLED, false),
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

  return persistTokenResponse(config, (await response.json()) as TokenResponse);
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
  return persistTokenResponse(config, (await response.json()) as TokenResponse);
}

function persistTokenResponse(config: AuthConfig, tokenResponse: TokenResponse): AuthSession {
  const payload = decodeJwtPayload(tokenResponse.access_token);
  const expiresAt = Date.now() + Math.max(30, tokenResponse.expires_in ?? 300) * 1000;
  const stored: StoredAuthSession = {
    accessToken: tokenResponse.access_token,
    expiresAt,
    idToken: tokenResponse.id_token,
    profile: profileFromPayload(payload),
    refreshToken: tokenResponse.refresh_token,
    roles: rolesFromPayload(payload, config.clientId)
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

function rolesFromPayload(payload: Record<string, unknown>, clientId: string): SimRole[] {
  const realmRoles = rolesFromUnknown((payload.realm_access as { roles?: unknown } | undefined)?.roles);
  const resourceAccess = payload.resource_access as Record<string, { roles?: unknown }> | undefined;
  const clientRoles = rolesFromUnknown(resourceAccess?.[clientId]?.roles);
  return mapOidcRoles([...realmRoles, ...clientRoles]);
}

function rolesFromUnknown(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((role): role is string => typeof role === "string") : [];
}

function mapOidcRoles(roles: string[]): SimRole[] {
  const mapped = new Set<SimRole>();
  const normalized = new Set(roles.map((role) => role.trim()).filter(Boolean));
  if (hasAnyRole(normalized, ["SIM_ADMIN", "sim_admin", "csm-sim-admin", "cop_admin"])) {
    mapped.add("SIM_ADMIN");
    mapped.add("SIM_VIEWER");
  }
  if (hasAnyRole(normalized, ["SIM_OPERATOR", "sim_operator", "csm-sim-operator", "cop_operator"])) {
    mapped.add("SIM_OPERATOR");
    mapped.add("SIM_VIEWER");
  }
  if (hasAnyRole(normalized, ["SIM_VIEWER", "sim_viewer", "csm-sim-viewer", "cop_user"])) {
    mapped.add("SIM_VIEWER");
  }
  if (hasAnyRole(normalized, ["SIM_AI_ADMIN", "sim_ai_admin", "csm-sim-ai-admin"])) {
    mapped.add("SIM_AI_ADMIN");
    mapped.add("SIM_AI_USER");
  }
  if (hasAnyRole(normalized, ["SIM_AI_USER", "sim_ai_user", "csm-sim-ai-user"])) {
    mapped.add("SIM_AI_USER");
  }
  return Array.from(mapped);
}

function hasAnyRole(actualRoles: Set<string>, acceptedRoles: string[]): boolean {
  return acceptedRoles.some((role) => actualRoles.has(role));
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
  if (crypto.subtle) {
    return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  }
  return bytesToBase64Url(sha256(bytes));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return decodeURIComponent(
    Array.from(atob(base64))
      .map((character) => `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join("")
  );
}

const sha256InitialHash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);

const sha256RoundConstants = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74,
  0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d,
  0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e,
  0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function sha256(input: Uint8Array): Uint8Array {
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 1 + 8) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;

  const paddedView = new DataView(padded.buffer);
  paddedView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  paddedView.setUint32(paddedLength - 4, bitLength >>> 0);

  const hash = new Uint32Array(sha256InitialHash);
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = paddedView.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15]!;
      const word2 = words[index - 2]!;
      const s0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
      const s1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }

    let a = hash[0]!;
    let b = hash[1]!;
    let c = hash[2]!;
    let d = hash[3]!;
    let e = hash[4]!;
    let f = hash[5]!;
    let g = hash[6]!;
    let h = hash[7]!;

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + ch + sha256RoundConstants[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0;
    hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0;
    hash[7] = (hash[7]! + h) >>> 0;
  }

  const output = new Uint8Array(32);
  const outputView = new DataView(output.buffer);
  hash.forEach((value, index) => outputView.setUint32(index * 4, value));
  return output;
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function normalizeIssuer(value: string): string {
  return value.replace(/\/+$/u, "");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }
  return value === "1" || value === "true" || value === "yes";
}
