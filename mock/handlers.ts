// Scenario-driven handlers for the mock Sinequa REST API.
// Each handler returns a plain Result; mock-plugin.ts turns it into an HTTP response
// (status, JSON body, Set-Cookie, `sinequa-jwt-refresh` header, or a redirect).

import {
  app,
  isScenario,
  preLogin,
  principal,
  type Scenario,
  userSettings,
} from "./fixtures";
import {
  dropSession,
  expireAll,
  isAuthed,
  issueSession,
  tokenFor,
  debugState,
} from "./sessions";

export type ParsedReq = {
  method: string;
  pathname: string;
  query: URLSearchParams;
  cookies: Record<string, string>;
  csrfHeader: string | null;
  authHeader: string | null;
  overrideUser: string | null;
  overrideDomain: string | null;
  body: Record<string, unknown>;
};

export type Result = {
  status: number;
  json?: unknown;
  html?: string;
  redirectTo?: string;
  refreshToken?: string;
  setSession?: string;
  clearSession?: boolean;
  setScenario?: string;
  setIdp?: string;
  clearIdp?: boolean;
  /** Value of the `WWW-Authenticate` response header (e.g. `Bearer realm="sinequa"`). */
  wwwAuthenticate?: string;
};

import {
  dropIdpSession,
  hasIdpSession,
  issueIdpSession,
  SCENARIO_COOKIE,
} from "./sessions";

function resolveScenario(req: ParsedReq): Scenario {
  const fromQuery = req.query.get("app");
  const fromBody = typeof req.body.app === "string" ? (req.body.app as string) : undefined;
  const fromCookie = req.cookies[SCENARIO_COOKIE];
  const candidate = fromQuery || fromBody || fromCookie || "creds";
  return isScenario(candidate) ? candidate : "creds";
}

function json(status: number, body: unknown): Result {
  return { status, json: body };
}

/**
 * Scenarios whose unauthenticated `401`s should advertise a Bearer challenge. A real Sinequa
 * server in credentials/bearer mode answers the auth probe with `WWW-Authenticate: Bearer …`,
 * which the client reads (regex `^Bearer ?`) to detect the scheme before submitting the web token.
 */
const BEARER_CHALLENGE = 'Bearer realm="sinequa"';

function bearerChallengeFor(scenario: Scenario): string | undefined {
  return scenario === "creds" ||
    scenario === "creds-legacy" ||
    scenario === "bearer" ||
    scenario === "oidc-expired"
    ? BEARER_CHALLENGE
    : undefined;
}

/** Handle `/api/v1/*`. Returns null for unknown endpoints. */
export function handleApi(req: ParsedReq): Result | null {
  const scenario = resolveScenario(req);
  const authed = isAuthed(req.cookies, req.csrfHeader);

  // ---- App config -------------------------------------------------------
  if (req.pathname === "/api/v1/app") {
    if (req.query.get("preLogin") === "true") {
      // First call of the bootstrap — pin the scenario in a cookie so the param-less
      // endpoints (challenge, principal) can resolve it too.
      return { ...json(200, preLogin(scenario)), setScenario: scenario };
    }
    return { ...json(200, app(scenario)), setScenario: scenario };
  }

  // ---- Challenge (CSRF token / logout) ----------------------------------
  if (req.pathname === "/api/v1/challenge") {
    const action = req.query.get("action");

    if (action === "getCsrfToken") {
      // `sso` (and `impersonation`, which signs in as an admin first) simulate proxy/browser SSO:
      // a token is always available, no prior login.
      if (scenario === "sso" || scenario === "impersonation") {
        const s = issueSession();
        return { status: 200, json: { csrfToken: s.token }, setSession: s.id, refreshToken: s.token };
      }
      // Authenticated (e.g. returning from the OAuth/SAML IdP, or after the OIDC probe):
      // hand back the live token.
      if (authed) {
        const token = tokenFor(req.cookies, req.csrfHeader)!;
        return { status: 200, json: { csrfToken: token }, refreshToken: token };
      }
      // suppressErrors=true semantics: 200 with no token when unauthenticated.
      return json(200, {});
    }

    if (action === "deleteWebTokenCookie") {
      dropSession(req.cookies);
      // Realistic: only provider modes (oauth/saml) return an end-session URL — Sinequa hands back
      // the IdP logout endpoint so the consumer terminates the IdP session. Ambient modes (sso/oidc)
      // and credentials/bearer return NO logoutUrl (the consumer handles the post-logout UX itself).
      const provider = scenario === "oauth" || scenario === "saml" || scenario === "oauth-loop";
      const logoutUrl = provider ? "/__mock/idp-logout?return=/" : "";
      return { status: 200, json: { methodresult: "ok", logoutUrl }, clearSession: true };
    }

    return json(400, { errorMessage: `Unknown challenge action: ${action}` });
  }

  // ---- Principal --------------------------------------------------------
  if (req.pathname === "/api/v1/principal") {
    // Header-driven impersonation: when the admin sends sinequa-override-user, the server answers
    // as the impersonated user.
    const override = req.overrideUser
      ? { user: req.overrideUser, domain: req.overrideDomain ?? "" }
      : undefined;
    if (authed) {
      const token = tokenFor(req.cookies, req.csrfHeader)!;
      return { status: 200, json: principal(override), refreshToken: token };
    }
    const noAutoAuth = req.query.get("noAutoAuthentication") === "true";
    // The auto-auth probe (tryAutoAuthentication) omits noAutoAuthentication → the server may
    // auto-authenticate. We only do so for the `oidc` scenario (valid IdP session).
    if (!noAutoAuth && scenario === "oidc") {
      const s = issueSession();
      return { status: 200, json: principal(), setSession: s.id, refreshToken: s.token };
    }
    // fetchPrincipal (noAutoAuthentication=true) without a session, or any non-OIDC probe.
    // In credentials/bearer mode, advertise the Bearer challenge the client expects.
    return { ...json(401, { errorMessage: "Not authenticated" }), wwwAuthenticate: bearerChallengeFor(scenario) };
  }

  // ---- Credentials / bearer web token -----------------------------------
  if (req.pathname === "/api/v1/security.webtoken") {
    const bearer = req.authHeader?.toLowerCase().startsWith("bearer ");
    const user = typeof req.body.user === "string" ? (req.body.user as string) : "";
    const password = typeof req.body.password === "string" ? (req.body.password as string) : "";
    if (bearer || (user && password)) {
      const s = issueSession();
      return {
        status: 200,
        json: { methodResult: "ok", csrfToken: s.token },
        setSession: s.id,
        refreshToken: s.token,
        setScenario: scenario,
      };
    }
    return { ...json(401, { errorMessage: "Invalid credentials" }), wwwAuthenticate: BEARER_CHALLENGE };
  }

  // ---- Web token (action=get) -------------------------------------------
  // Alternate credentials endpoint: POST api/v1/webToken { action:"get", user, password,
  // tokenInCookie } → { csrfToken }. The client maps the response to `value.csrfToken`.
  if (req.pathname === "/api/v1/webToken") {
    const action = typeof req.body.action === "string" ? (req.body.action as string) : "";
    const user = typeof req.body.user === "string" ? (req.body.user as string) : "";
    const password = typeof req.body.password === "string" ? (req.body.password as string) : "";
    const bearer = req.authHeader?.toLowerCase().startsWith("bearer ");
    if (action === "get" && (bearer || (user && password))) {
      const s = issueSession();
      // tokenInCookie:true → also drop the session cookie (handled via setSession below).
      return {
        status: 200,
        json: { csrfToken: s.token },
        setSession: s.id,
        refreshToken: s.token,
        setScenario: scenario,
      };
    }
    return { ...json(401, { errorMessage: "Invalid credentials" }), wwwAuthenticate: BEARER_CHALLENGE };
  }

  // ---- OAuth / SAML redirect --------------------------------------------
  if (req.pathname === "/api/v1/security.oauth" || req.pathname === "/api/v1/security.saml") {
    const originalUrl =
      typeof req.body.originalUrl === "string" ? (req.body.originalUrl as string) : "/";
    // `oauth-loop` points at an IdP that never sets a session, to exercise the redirect loop guard.
    const noauth = scenario === "oauth-loop" ? "&noauth=1" : "";
    const redirectUrl = `/__mock/idp?return=${encodeURIComponent(originalUrl)}&app=${scenario}${noauth}`;
    return { ...json(200, { redirectUrl }), setScenario: scenario };
  }

  // ---- User settings (app init) -----------------------------------------
  if (req.pathname === "/api/v1/usersettings") {
    return json(200, userSettings());
  }

  return null;
}

/** Handle the `/__mock/*` control endpoints. Returns null if not a control route. */
export function handleControl(req: ParsedReq): Result | null {
  // Fake IdP authorize endpoint.
  if (req.pathname === "/__mock/idp") {
    const ret = req.query.get("return") || "/";
    const appName = req.query.get("app") || "creds";
    const noauth = req.query.get("noauth") === "1";
    const idpLogin = req.query.get("idp_login") === "1";

    if (noauth) {
      // Provider "authenticated" without establishing a session → triggers the app loop guard.
      return { status: 302, redirectTo: ret, setScenario: appName };
    }

    // Silent SSO when an IdP session already exists; an explicit IdP sign-in establishes one.
    if (idpLogin || hasIdpSession(req.cookies)) {
      const s = issueSession();
      return {
        status: 302,
        redirectTo: ret,
        setSession: s.id,
        refreshToken: s.token,
        setScenario: appName,
        setIdp: idpLogin ? issueIdpSession() : undefined,
      };
    }

    // No IdP session (e.g. right after a provider logout) → present the IdP login page.
    return { status: 200, html: idpLoginPage(ret, appName), setScenario: appName };
  }

  // Fake IdP end-session endpoint: clears BOTH the IdP session and the app session, then returns.
  if (req.pathname === "/__mock/idp-logout") {
    const ret = req.query.get("return") || "/";
    dropIdpSession(req.cookies);
    dropSession(req.cookies);
    return { status: 302, redirectTo: ret, clearIdp: true, clearSession: true };
  }

  if (req.pathname === "/__mock/expire") {
    const n = expireAll();
    return json(200, { expired: n });
  }

  if (req.pathname === "/__mock/state") {
    return json(200, debugState());
  }

  return null;
}

/** Minimal "identity provider" sign-in page shown when there is no IdP session. */
function idpLoginPage(ret: string, app: string): string {
  const href = `/__mock/idp?return=${encodeURIComponent(ret)}&app=${encodeURIComponent(app)}&idp_login=1`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Mock Identity Provider</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    font-family: system-ui, sans-serif; background:#0f1117; color:#e6e9ee; }
  .card { background:#171a21; border:1px solid #2a2f3a; border-radius:14px; padding:32px;
    width:340px; box-shadow:0 10px 40px rgba(0,0,0,.4); text-align:center; }
  .badge { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:#818cf8; font-weight:700; }
  h1 { font-size:18px; margin:8px 0 4px; }
  p { color:#9aa3b2; font-size:13px; margin:0 0 24px; }
  a.btn { display:block; text-decoration:none; background:#4f46e5; color:#fff; font-weight:600;
    padding:11px; border-radius:9px; }
  a.btn:hover { filter:brightness(1.08); }
  .app { margin-top:16px; font-size:11px; color:#6b7280; font-family:ui-monospace,monospace; }
</style></head>
<body>
  <div class="card">
    <div class="badge">🔐 Mock Identity Provider</div>
    <h1>Sign in to continue</h1>
    <p>No IdP session — authenticate to return to the application.</p>
    <a class="btn" href="${href}">Sign in as demo</a>
    <div class="app">app: ${app}</div>
  </div>
</body></html>`;
}
