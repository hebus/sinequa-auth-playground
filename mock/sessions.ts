// In-memory session store for the mock Sinequa backend.
//
// A "session" models a server-side authenticated state, and — like the real server — it has a LIFETIME.
// How that lifetime behaves is configurable, because the two real backends observed behave differently
// (see `PRESETS`): one expires a fixed time after sign-in and never tells the client anything (absolute,
// no refresh), the other slides the expiry on each call and renews the client's token on every response.
//
// The token handed to the client is `<43 base64url chars>|<expiry, epoch seconds>`, in the
// `sinequa-jwt-refresh` header (when the refresh policy emits one) and in the `csrfToken` of the
// challenge/login bodies — what real Sinequa backends return (observed). The browser carries the session
// through the session cookie; the @sinequa/atomic client also echoes the token back as the
// `Sinequa-csrf-token` request header. Either proves authentication here.

/** Cookie name on an HTTPS deployment (`HttpOnly; Secure`). Over plain HTTP the real server uses {@link HTTP_SESSION_COOKIE}. */
export const SESSION_COOKIE = "sinequa-web-token-secure";
/** Cookie name over plain HTTP (`HttpOnly`, no `Secure`, no `SameSite`) — observed on a local backend. */
export const HTTP_SESSION_COOKIE = "sinequa-web-token";
/** The session cookie name for a request, by the scheme the browser used. Both names are always read. */
export const sessionCookieName = (secure: boolean) => (secure ? SESSION_COOKIE : HTTP_SESSION_COOKIE);
export const SCENARIO_COOKIE = "mock-scenario";
export const IDP_COOKIE = "mock-idp";

type Session = { base: string; issuedAt: number; expiresAt: number; expired: boolean };

const sessions = new Map<string, Session>();
// Identity-provider sessions, modelled separately from the app session: an OAuth/SAML logout
// terminates the IdP session, so the next provider handshake can no longer authenticate silently.
const idpSessions = new Set<string>();
let counter = 0;

// ---- Configuration ---------------------------------------------------------

/** When the server tells the client its token was renewed (`sinequa-jwt-refresh`). */
export type RefreshPolicy =
  /** Never: the client keeps the token it got at sign-in (observed on a local credentials backend). */
  | { kind: "never" }
  /** On every authenticated response (observed on an OAuth demo backend). */
  | { kind: "always" }
  /** Only once the remaining lifetime drops below `belowMs`. The real threshold, if any, is unknown. */
  | { kind: "below"; belowMs: number };

type MockConfig = {
  /** Session lifetime. */
  ttlMs: number;
  /** `true`: each authenticated request pushes the expiry to `now + ttl`. `false`: it is fixed at sign-in. */
  sliding: boolean;
  refresh: RefreshPolicy;
  /** Whether tokens carry the `|<epoch>` suffix. Off = a backend that sends bare tokens. */
  suffix: boolean;
  /** Whether login/challenge BODIES carry the bare token while the header stays dated. */
  bodyBare: boolean;
};

const LOCAL_TTL_MS = 30 * 60_000;

/**
 * The two backends observed so far. `local` is the default: a local Sinequa with credentials login —
 * expiry absolute 30 min after sign-in, no refresh header ever, no cookie renewal (measured over 33 min:
 * an active session still died at 30.0 min). `oauth-demo`: an OAuth demo backend — ~168 h, renewed on
 * each response.
 */
const LOCAL_PRESET: Pick<MockConfig, "ttlMs" | "sliding" | "refresh"> = { ttlMs: LOCAL_TTL_MS, sliding: false, refresh: { kind: "never" } };

export const PRESETS: Record<string, Partial<MockConfig>> = {
  local: LOCAL_PRESET,
  "oauth-demo": { ttlMs: 168 * 3_600_000, sliding: true, refresh: { kind: "always" } },
};

const DEFAULTS = (): MockConfig => ({ ...LOCAL_PRESET, refresh: { ...LOCAL_PRESET.refresh }, suffix: true, bodyBare: false });
const config: MockConfig = DEFAULTS();

let clock: () => number = () => Date.now();

/** Test seam: replaces the clock used for expiry. */
export function setClock(fn: () => number): void {
  clock = fn;
}

export function setMockConfig(patch: Partial<MockConfig>): void {
  Object.assign(config, patch);
}

export function resetMockConfig(): void {
  Object.assign(config, DEFAULTS());
}

export function getMockConfig(): MockConfig {
  return { ...config, refresh: { ...config.refresh } };
}

/** Parses `never` | `always` | `below:<seconds>`; `undefined` when it is none of them. */
export function parseRefreshPolicy(value: string): RefreshPolicy | undefined {
  if (value === "never" || value === "always") return { kind: value };
  const m = /^below:(\d+(?:\.\d+)?)$/.exec(value);
  return m ? { kind: "below", belowMs: Number(m[1]) * 1000 } : undefined;
}

// ---- Tokens ----------------------------------------------------------------

function rand(prefix: string): string {
  counter += 1;
  // Deterministic-enough, unique per process. No Math.random/Date needed.
  return `${prefix}-${counter}-${(counter * 2654435761) >>> 0}`;
}

/** base64url of raw bytes, isomorphic across Node and the browser/Service Worker (no Buffer). */
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 deterministic pseudo-random bytes → 43 base64url characters, the length of a real token. */
function opaque43(seed: number): string {
  const bytes = new Uint8Array(32);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < bytes.length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    bytes[i] = x & 0xff;
  }
  return b64url(bytes);
}

const jsonB64 = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

const baseOf = (token: string) => token.split("|")[0];

/** The token as the client receives it in the `sinequa-jwt-refresh` header (and, by default, the body). */
function dated(session: Session): string {
  return config.suffix ? `${session.base}|${Math.floor(session.expiresAt / 1000)}` : session.base;
}

/** The token as it goes in a response BODY: bare when the mock is told to mimic such a backend. */
export function bodyToken(token: string): string {
  return config.bodyBare ? baseOf(token) : token;
}

let seed = 0;

// ---- Sessions --------------------------------------------------------------

const live = (s: Session) => !s.expired && clock() <= s.expiresAt;

/** The session id carried by a cookie value: a JWT's `sid` claim, or the value itself (legacy cookie). */
function sessionIdFromCookie(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parts = value.split(".");
  if (parts.length !== 3) return value;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.sid === "string" ? payload.sid : undefined;
  } catch {
    return undefined;
  }
}

function sessionIdOf(cookies: Record<string, string>): string | undefined {
  return sessionIdFromCookie(cookies[SESSION_COOKIE] ?? cookies[HTTP_SESSION_COOKIE]);
}

/** Create a fresh authenticated session. Returns the session id and the dated token. */
export function issueSession(): { id: string; token: string } {
  const id = rand("sess");
  seed += 1;
  const issuedAt = clock();
  const session: Session = { base: opaque43(seed), issuedAt, expiresAt: issuedAt + config.ttlMs, expired: false };
  sessions.set(id, session);
  return { id, token: dated(session) };
}

/**
 * The cookie VALUE for a session: a JWT-shaped string `{iss, iat, sid, exp, sub}` with a placeholder
 * signature, like the real session cookie. It is HttpOnly, so no page ever reads it — only the server
 * does, through `sid`. Its `exp` is the value at issue time and is not refreshed, a simplification the
 * page cannot observe.
 */
export function sessionCookieValue(id: string): string {
  const s = sessions.get(id);
  if (!s) return id;
  const header = jsonB64({ typ: "JWT", alg: "HS256" });
  const payload = jsonB64({
    iss: "Sinequa",
    iat: Math.floor(s.issuedAt / 1000),
    sid: id,
    exp: Math.floor(s.expiresAt / 1000),
    sub: "dynamic|admin@mock.local",
  });
  return `${header}.${payload}.${opaque43(counter + 7)}`;
}

/** The cookie's `Expires`: the session's expiry at issue time, equal to the token's epoch (observed). */
export function sessionCookieExpires(id: string): string | undefined {
  const s = sessions.get(id);
  return s ? new Date(Math.floor(s.expiresAt / 1000) * 1000).toUTCString() : undefined;
}

function findSession(cookies: Record<string, string>, csrfHeader?: string | null): Session | null {
  const id = sessionIdOf(cookies);
  if (id) {
    const s = sessions.get(id);
    if (s && live(s)) return s;
  }
  if (csrfHeader) {
    const base = baseOf(csrfHeader);
    for (const s of sessions.values()) {
      if (live(s) && s.base === base) return s;
    }
  }
  return null;
}

/** A request is authenticated if its cookie session OR its csrf header maps to a live session. */
export function isAuthed(cookies: Record<string, string>, csrfHeader?: string | null): boolean {
  return findSession(cookies, csrfHeader) !== null;
}

/** Current dated token of an authenticated request's session, or `null`. Does not move the expiry. */
export function tokenFor(cookies: Record<string, string>, csrfHeader?: string | null): string | null {
  const s = findSession(cookies, csrfHeader);
  return s ? dated(s) : null;
}

/**
 * Called once per authenticated request. With a sliding expiry it pushes the session's expiry to
 * `now + ttl` (`issuedAt` is kept); with an absolute one it does nothing — activity changes nothing.
 */
export function renewSession(cookies: Record<string, string>, csrfHeader?: string | null): void {
  if (!config.sliding) return;
  const s = findSession(cookies, csrfHeader);
  if (s) s.expiresAt = clock() + config.ttlMs;
}

/** Whether the refresh policy says this response must carry `sinequa-jwt-refresh`, given the session's remaining life. */
export function shouldRefresh(cookies: Record<string, string>, csrfHeader?: string | null): boolean {
  const policy = config.refresh;
  if (policy.kind === "never") return false;
  if (policy.kind === "always") return true;
  const s = findSession(cookies, csrfHeader);
  return !!s && s.expiresAt - clock() < policy.belowMs;
}

/** Expire every session — simulates server-side token expiry / revocation. */
export function expireAll(): number {
  let n = 0;
  for (const s of sessions.values()) {
    if (!s.expired) {
      s.expired = true;
      n += 1;
    }
  }
  return n;
}

/** Drop the session referenced by a cookie (logout). */
export function dropSession(cookies: Record<string, string>): void {
  const id = sessionIdOf(cookies);
  if (id) sessions.delete(id);
}

// ---- IdP (provider) session ------------------------------------------------
export function issueIdpSession(): string {
  const id = rand("idp");
  idpSessions.add(id);
  return id;
}
export function hasIdpSession(cookies: Record<string, string>): boolean {
  const id = cookies[IDP_COOKIE];
  return !!id && idpSessions.has(id);
}
export function dropIdpSession(cookies: Record<string, string>): void {
  const id = cookies[IDP_COOKIE];
  if (id) idpSessions.delete(id);
}

export function debugState() {
  const now = clock();
  return {
    config: getMockConfig(),
    sessions: [...sessions.entries()].map(([id, s]) => ({
      id,
      expired: s.expired || now > s.expiresAt,
      expiresInSeconds: Math.round((s.expiresAt - now) / 1000),
    })),
  };
}
