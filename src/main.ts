import {
  AuthMode,
  clearSessionTokens,
  fetchPrincipal,
  globalConfig,
  initializeAppConfig,
  isAuthenticated,
  login,
  logout,
  setGlobalConfig,
} from "@sinequa/atomic";
import { SCENARIOS, type ScenarioDef } from "./scenarios";

// Loop guard key used internally by tryOAuthAuthentication/trySAMLAuthentication (not exported).
const AUTH_REDIRECT_ATTEMPT_KEY = "sinequa-auth-redirect-attempt";
const RESUME_KEY = "playground.resume";

const $ = (id: string) => document.getElementById(id)!;

type LogKind = "info" | "section" | "net" | "ok" | "err" | "muted";
function log(msg: string, kind: LogKind = "info") {
  const el = $("log");
  const line = document.createElement("div");
  line.className = `line ${kind}`;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
const clearLog = () => { $("log").textContent = ""; };

// Mirror every network call into the activity log, colour-coded by outcome.
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const raw = typeof input === "string" ? input : (input as Request).url;
  const url = raw.replace(location.origin, "");
  const method = init?.method || (typeof input !== "string" ? (input as Request).method : "GET") || "GET";
  try {
    const res = await realFetch(input as RequestInfo, init);
    log(`→ ${method} ${url} · ${res.status}`, res.status >= 400 ? "err" : "net");
    return res;
  } catch (e) {
    log(`→ ${method} ${url} · network error`, "err");
    throw e;
  }
};

// ---- Status panel ----------------------------------------------------------
function renderStatus(def: ScenarioDef | null, loginResult: string) {
  $("s-scenario").textContent = def ? `${def.label} · app="${def.app}"` : "—";
  $("s-mode").textContent = globalConfig.authMode ? JSON.stringify(globalConfig.authMode) : "undefined";
  $("s-login").textContent = loginResult;
  const authed = isAuthenticated();
  const pill = $("s-auth");
  pill.textContent = authed ? "true" : "false";
  pill.className = `pill ${authed ? "ok" : "no"}`;
}

function setActiveCard(def: ScenarioDef) {
  for (const el of document.querySelectorAll(".scenario")) el.classList.remove("active");
  cards.get(def.app)?.classList.add("active");
}

function showCreds(show: boolean) {
  $("creds-card").classList.toggle("hidden", !show);
}

// ---- Auth flow (logic unchanged) -------------------------------------------
function configureFor(def: ScenarioDef) {
  setGlobalConfig({
    backendUrl: "",
    app: def.app,
    // Reset everything detection-related so a previous scenario never leaks in.
    // NOTE: must be a DEFINED value — setGlobalConfig ignores `authMode: undefined`, and
    // initializeAppConfig() short-circuits when authMode.kind === "credentials" (skipping
    // re-detection). Resetting to unknown() forces a fresh detect on every run.
    authMode: AuthMode.unknown(),
    autoOAuthProvider: undefined,
    autoSAMLProvider: undefined,
    bearerToken: def.bearer ? "demo-bearer-token" : undefined,
    userOverride: undefined,
    userOverrideActive: false,
  });
}

let activeDef: ScenarioDef | null = null;

/** Fresh manual start: drop any existing session, then bootstrap + login. */
async function startScenario(def: ScenarioDef) {
  activeDef = def;
  setActiveCard(def);
  showCreds(false);
  clearLog();
  log(`▶ ${def.label}  (app="${def.app}", expected ${def.expectedMode})`, "section");

  // Clean slate.
  try { await logout(); } catch { /* no session */ }
  clearSessionTokens();
  sessionStorage.removeItem(AUTH_REDIRECT_ATTEMPT_KEY);
  sessionStorage.removeItem(RESUME_KEY);

  configureFor(def);
  await bootstrap(def);

  if (def.impersonate && isAuthenticated()) {
    await runImpersonationDemo(def);
  }
}

/**
 * Demonstrates Sinequa's header-driven user override (impersonation). The user is already
 * authenticated as an admin; activating the override makes every subsequent request carry
 * `sinequa-override-user`/`-domain` (added by createHeaders) — no re-login — so the server answers
 * as the impersonated user.
 */
async function runImpersonationDemo(def: ScenarioDef) {
  const show = async (label: string) => {
    const p = (await fetchPrincipal()) as { name: string; id: string; isAdministrator: boolean };
    log(`   ${label}: name=${p.name}  id=${p.id}  isAdministrator=${p.isAdministrator}`, "ok");
    return p;
  };

  log("authenticated as admin — fetching principal", "section");
  await show("admin");

  log('activating override → "alice@demo" (note the sinequa-override-* headers)', "section");
  setGlobalConfig({ userOverrideActive: true, userOverride: { username: "alice", domain: "demo" } });
  await show("impersonated");

  log("clearing override", "section");
  setGlobalConfig({ userOverrideActive: false, userOverride: undefined });
  await show("admin again");

  renderStatus(def, "impersonation demo done");
}

/** Resume after returning from the fake IdP redirect — do NOT reset the freshly-set session. */
async function resumeScenario(def: ScenarioDef) {
  activeDef = def;
  setActiveCard(def);
  log(`↩ resuming ${def.label} after IdP redirect`, "section");
  configureFor(def);
  await bootstrap(def);
}

async function bootstrap(def: ScenarioDef) {
  try {
    await initializeAppConfig();
    log(`initializeAppConfig → authMode = ${JSON.stringify(globalConfig.authMode)}`);
  } catch (e) {
    log(`initializeAppConfig threw: ${(e as Error).message}`, "err");
    renderStatus(def, "init error");
    return;
  }

  // Navigating scenarios redirect the whole page; remember to resume on the way back.
  const willNavigate = def.app === "oauth" || def.app === "saml" || def.app === "oauth-loop";
  if (willNavigate) sessionStorage.setItem(RESUME_KEY, def.app);

  try {
    const result = await login();
    log(`login() → ${result}`, result ? "ok" : "muted");
    renderStatus(def, String(result));

    if (result) {
      sessionStorage.removeItem(RESUME_KEY); // authenticated — no resume needed
    } else if (willNavigate) {
      // oauth/saml: login() fired window.location.href and returned false because the page is
      // redirecting to the IdP. Keep RESUME_KEY so we finish the flow on the way back.
      log("→ redirecting to the IdP… (login() returns false until we come back)", "muted");
    } else {
      sessionStorage.removeItem(RESUME_KEY);
      if (globalConfig.authMode?.kind === "credentials") {
        log("→ credentials mode: submit the form to authenticate.", "muted");
        showCreds(true);
      }
    }
  } catch (e) {
    sessionStorage.removeItem(RESUME_KEY);
    log(`login() threw: ${(e as Error).message}`, "err");
    renderStatus(def, "threw (see log)");
  }
}

async function submitCredentials(ev: Event) {
  ev.preventDefault();
  const username = ($("username") as HTMLInputElement).value;
  const password = ($("password") as HTMLInputElement).value;
  if (activeDef?.legacyCredentials) {
    await submitLegacyCredentials(username, password);
    return;
  }
  log(`login({ username: "${username}", password: "***" })`, "section");
  try {
    const result = await login({ username, password });
    log(`login(credentials) → ${result}`, result ? "ok" : "err");
    renderStatus(activeDef, String(result));
    if (result) showCreds(false);
  } catch (e) {
    log(`login(credentials) threw: ${(e as Error).message}`, "err");
  }
}

/**
 * Legacy credentials flow: atomic's `login()` only knows `security.webtoken`, so for `creds-legacy`
 * we POST straight to the old `api/v1/webToken` endpoint — mirroring the external client that still
 * uses it ({ action:"get", user, password, tokenInCookie:true } → { csrfToken }). The server sets the
 * `sinequa-web-token` cookie, so we then prove the session works via `fetchPrincipal()`.
 */
async function submitLegacyCredentials(username: string, password: string) {
  log(`legacy webToken POST { action:"get", user:"${username}", password:"***", tokenInCookie:true }`, "section");
  const params = new URLSearchParams({
    app: activeDef?.app ?? "creds-legacy",
    noUserOverride: "true",
    noAutoAuthentication: "true",
  });
  try {
    const res = await realFetch(`/api/v1/webToken?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ action: "get", user: username, password, tokenInCookie: true }),
    });
    log(`→ POST /api/v1/webToken · ${res.status}`, res.status >= 400 ? "err" : "net");
    if (!res.ok) {
      renderStatus(activeDef, `webToken → ${res.status}`);
      return;
    }
    const { csrfToken } = (await res.json()) as { csrfToken: string };
    log(`webToken → csrfToken=${csrfToken}`, "ok");
    // Cookie session is now set — fetchPrincipal (noAutoAuthentication) should return 200.
    const p = (await fetchPrincipal()) as { name: string };
    log(`fetchPrincipal → 200 (name=${p.name}) — legacy cookie session works`, "ok");
    showCreds(false);
    renderStatus(activeDef, `csrfToken=${csrfToken}`);
  } catch (e) {
    log(`legacy webToken threw: ${(e as Error).message}`, "err");
    renderStatus(activeDef, "threw (see log)");
  }
}

async function expireToken() {
  log("⏱️ expiring session", "section");
  await realFetch("/__mock/expire", { method: "POST" });
  log("session expired server-side; calling fetchPrincipal()…");
  try {
    await fetchPrincipal();
    log("fetchPrincipal → 200 (unexpected: still authenticated?)", "err");
  } catch (e) {
    log(`fetchPrincipal → rejected: ${(e as Error).message} (expected 401)`, "muted");
  }
  renderStatus(activeDef, "after expiry");

  // Optionally simulate what @sinequa/atomic-angular's errorInterceptorFn does on a 401:
  // call signIn() → re-bootstrap. Here we replay the active scenario's detect+login.
  const reauth = ($("reauth") as HTMLInputElement).checked;
  if (reauth && activeDef) {
    log("🔄 re-auth (simulating errorInterceptor → signIn)", "section");
    clearSessionTokens();
    configureFor(activeDef);
    await bootstrap(activeDef);
    if (activeDef.impersonate && isAuthenticated()) await runImpersonationDemo(activeDef);
  } else if (!reauth) {
    log("→ enable “Re-auth after expiry” to simulate the error-interceptor re-login", "muted");
  }
}

async function doLogout() {
  log("🚪 logout", "section");
  try {
    const url = await logout(); // atomic returns the provider end-session URL when there is one
    if (url) {
      log(`provider logout → ${url}`, "muted");
      await realFetch(url); // terminate the IdP session too (clears mock-idp)
    }
  } catch { /* no session */ }
  clearSessionTokens();
  renderStatus(activeDef, "logged out");
}

// ---- Render the sidebar ----------------------------------------------------
const cards = new Map<string, HTMLElement>();
function renderScenarios() {
  const list = $("scenarios");
  const groups = [...new Set(SCENARIOS.map((s) => s.group))];
  for (const group of groups) {
    const title = document.createElement("p");
    title.className = "group-title";
    title.textContent = group;
    list.appendChild(title);

    for (const def of SCENARIOS.filter((s) => s.group === group)) {
      const btn = document.createElement("button");
      btn.className = "scenario";
      btn.innerHTML = `
        <span class="ico">${def.icon}</span>
        <span class="body">
          <span class="name">${def.label}<span class="chip">${def.expectedMode}</span></span>
          <span class="desc">${def.description}</span>
        </span>`;
      btn.onclick = () => startScenario(def);
      cards.set(def.app, btn);
      list.appendChild(btn);
    }
  }
}

// ---- Theme toggle ----------------------------------------------------------
const THEME_KEY = "playground.theme";
function effectiveTheme(): "light" | "dark" {
  const forced = document.documentElement.getAttribute("data-theme");
  if (forced === "light" || forced === "dark") return forced;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function refreshThemeIcon() {
  // Show the current theme; clicking switches to the other.
  $("theme").textContent = effectiveTheme() === "dark" ? "🌙" : "☀️";
}
function toggleTheme() {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  document.documentElement.setAttribute("data-theme", next);
  refreshThemeIcon();
}

// ---- Boot ------------------------------------------------------------------
renderScenarios();
refreshThemeIcon();
$("theme").addEventListener("click", toggleTheme);
$("creds-form").addEventListener("submit", submitCredentials);
$("expire").addEventListener("click", expireToken);
$("logout").addEventListener("click", doLogout);
$("clear").addEventListener("click", clearLog);

const resume = sessionStorage.getItem(RESUME_KEY);
if (resume) {
  const def = SCENARIOS.find((s) => s.app === resume);
  sessionStorage.removeItem(RESUME_KEY);
  if (def) resumeScenario(def);
} else {
  log("Pick a login scenario on the left. Each runs against the in-process mock Sinequa backend.", "muted");
}
