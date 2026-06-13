// In-memory session store for the mock Sinequa backend.
//
// A "session" models a server-side authenticated state. The browser carries it via the
// `sinequa-web-token` cookie; the @sinequa/atomic client also echoes the issued token back as the
// `Sinequa-csrf-token` request header. Either proves authentication here.

export const SESSION_COOKIE = "sinequa-web-token";
export const SCENARIO_COOKIE = "mock-scenario";
export const IDP_COOKIE = "mock-idp";

type Session = { token: string; expired: boolean };

const sessions = new Map<string, Session>();
// Identity-provider sessions, modelled separately from the app session: an OAuth/SAML logout
// terminates the IdP session, so the next provider handshake can no longer authenticate silently.
const idpSessions = new Set<string>();
let counter = 0;

function rand(prefix: string): string {
  counter += 1;
  // Deterministic-enough, unique per process. No Math.random/Date needed.
  return `${prefix}-${counter}-${(counter * 2654435761) >>> 0}`;
}

/** Create a fresh authenticated session. Returns the session id (cookie) and CSRF token. */
export function issueSession(): { id: string; token: string } {
  const id = rand("sess");
  const token = rand("csrf");
  sessions.set(id, { token, expired: false });
  return { id, token };
}

/** A request is authenticated if its cookie session OR its csrf header maps to a live session. */
export function isAuthed(cookies: Record<string, string>, csrfHeader?: string | null): boolean {
  const id = cookies[SESSION_COOKIE];
  if (id) {
    const s = sessions.get(id);
    if (s && !s.expired) return true;
  }
  if (csrfHeader) {
    for (const s of sessions.values()) {
      if (!s.expired && s.token === csrfHeader) return true;
    }
  }
  return false;
}

/** Current token for an authenticated request (used to refresh the client token). */
export function tokenFor(cookies: Record<string, string>, csrfHeader?: string | null): string | null {
  const id = cookies[SESSION_COOKIE];
  if (id) {
    const s = sessions.get(id);
    if (s && !s.expired) return s.token;
  }
  if (csrfHeader) {
    for (const s of sessions.values()) {
      if (!s.expired && s.token === csrfHeader) return s.token;
    }
  }
  return null;
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
  const id = cookies[SESSION_COOKIE];
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
  return {
    sessions: [...sessions.entries()].map(([id, s]) => ({ id, expired: s.expired })),
  };
}
