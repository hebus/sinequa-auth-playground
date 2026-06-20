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
import { initSpfxAadHttpClient, resetSpfxAadHttpClient } from "./spfx-aad";
import { SCENARIOS, type ScenarioDef } from "./scenarios";

// Injected by Vite `define` (see vite.config.ts): true when `@sinequa/atomic` is aliased to sources.
declare const __ATOMIC_SRC__: boolean;

// Loop guard key used internally by tryOAuthAuthentication/trySAMLAuthentication (not exported).
const AUTH_REDIRECT_ATTEMPT_KEY = "sinequa-auth-redirect-attempt";
const RESUME_KEY = "playground.resume";

const $ = (id: string) => document.getElementById(id)!;

// Constellation accent per scenario group.
const GROUP_COLORS: Record<string, string> = {
  "Session": "#818cf8",
  "Provider redirect": "#fbbf24",
  "OIDC": "#22d3ee",
  "Edge cases": "#fb7185",
};
const groupColor = (group: string) => GROUP_COLORS[group] ?? "#818cf8";

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
  $("s-expected").textContent = def ? def.expectedMode : "—";
  const authed = isAuthenticated();
  const pill = $("s-auth");
  pill.textContent = authed ? "true" : "false";
  pill.className = `pill ${authed ? "ok" : "no"}`;
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
  // Drop any AadHttpClient injected by a previous SPFx run; only the spfx scenario re-injects it
  // (no-op until an SPFx run has loaded the subpath).
  resetSpfxAadHttpClient();
}

let activeDef: ScenarioDef | null = null;

/** Fresh manual start: drop any existing session, then bootstrap + login. */
async function startScenario(def: ScenarioDef) {
  activeDef = def;
  focusScenario(def);
  showCreds(false);
  clearLog();
  log(`▶ ${def.label}  (app="${def.app}", expected ${def.expectedMode})`, "section");

  // Clean slate.
  try { await logout(); } catch { /* no session */ }
  clearSessionTokens();
  sessionStorage.removeItem(AUTH_REDIRECT_ATTEMPT_KEY);
  sessionStorage.removeItem(RESUME_KEY);
  // spfx tracks its OAuth/SAML redirect loop guard in localStorage instead.
  localStorage.removeItem("oauthRedirectUrl");
  localStorage.removeItem("samlRedirectUrl");

  configureFor(def);
  await bootstrap(def);

  if (def.iisSso) await reportIisSsoSignals();
  if (def.impersonate && isAuthenticated()) {
    await runImpersonationDemo(def);
  }
}

/**
 * Real IIS Integrated Windows Authentication (per the captured HAR) is fully transparent: the
 * Negotiate/Kerberos handshake is done by the browser + IIS *below* this layer (its only on-the-wire
 * trace is `Persistent-Auth: true` on every response), the server issues **no** web-token cookie and
 * **no** CSRF token. @sinequa/atomic therefore authenticates via the `principal` auto-auth probe
 * (`tryAutoAuthentication` → `sso`), but stores no token. Surface the three signals so the token-less
 * nature is explicit: `isAuthenticated()` is `!!getToken()`, so it stays `false` on stock atomic —
 * it flips to `true` only with the proposed fix (persisted auth state). See README "IIS + Windows SSO".
 */
async function reportIisSsoSignals() {
  const authed = isAuthenticated();
  log(`signals → authMode=${JSON.stringify(globalConfig.authMode)} · isAuthenticated()=${authed}`, authed ? "ok" : "muted");
  if (!authed) {
    log("token-less ambient SSO: login()=true & authMode=sso, but isAuthenticated()=!!getToken() → false on stock atomic (fixed by persisted auth state)", "muted");
  }
  // Prove a real data call works. fetchPrincipal sends noAutoAuthentication; under transport SSO the
  // server only honours the Windows identity when it isn't suppressed. The fix sends `false` in sso
  // mode → 200; stock atomic sends `true` → the server answers anonymously → 401.
  try {
    const p = (await fetchPrincipal()) as { name: string };
    log(`fetchPrincipal → 200 (name=${p.name}) — data requests authenticate under transport SSO`, "ok");
  } catch (e) {
    log(`fetchPrincipal → ${(e as Error).message} — stock atomic sends noAutoAuthentication=true → 401 (needs the transport-SSO fix)`, "err");
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
  focusScenario(def);
  log(`↩ resuming ${def.label} after IdP redirect`, "section");
  configureFor(def);
  await bootstrap(def);
}

/**
 * Models a Sinequa UI hosted as a SharePoint Framework (SPFx) web part: inside SharePoint the web part
 * never sees a password — it acquires an Azure AD access token (via `AadTokenProvider`/`AadHttpClient`)
 * scoped to the Sinequa-registered AAD application. We inject a mock `AadHttpClient` through
 * `@sinequa/atomic/spfx` (`initializeAadHttpClient`); the library's HTTP helpers then route every
 * request through it with `Authorization: Bearer`. The Bearer rides along on `getCsrfToken`, which mints
 * the web-token session — the real SharePoint integration path.
 */
async function prepareSpfx(def: ScenarioDef): Promise<boolean> {
  log("SPFx host: SharePoint web part acquires an Azure AD token for Sinequa", "section");
  try {
    await initSpfxAadHttpClient((m) => log(m, "ok"));
    log("SPFx: initializeAadHttpClient(client) — requests now route through AadHttpClient (Bearer)", "ok");
    return true;
  } catch (e) {
    log(`SPFx token acquisition failed: ${(e as Error).message}`, "err");
    renderStatus(def, "AAD token error");
    return false;
  }
}

async function bootstrap(def: ScenarioDef) {
  if (def.spfx && !(await prepareSpfx(def))) return;

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
    if (activeDef.iisSso) await reportIisSsoSignals();
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

// ============================================================================
//  Constellation — presentation layer over the (unchanged) auth flow above.
// ============================================================================
const SVGNS = "http://www.w3.org/2000/svg";
const stage = $("stage");
const linksSvg = $("links") as unknown as SVGSVGElement;
const centerEl = $("center");
const packetsEl = $("packets");

type Viz = {
  def: ScenarioDef;
  el: HTMLButtonElement;
  link: SVGLineElement;
  label: SVGTextElement;
  color: string;
};
const viz: Viz[] = [];
const home = new Map<string, { x: number; y: number }>();
let activeLink: SVGLineElement;
let activeLabel: SVGTextElement;
let W = 0, H = 0, cx = 0, cy = 0;

// ---- Group filter (legend pills) -------------------------------------------
const activeGroups = new Set<string>();
const isVisible = (def: ScenarioDef) => activeGroups.size === 0 || activeGroups.has(def.group);
const filtering = () => activeGroups.size > 0;

/** Reflect the current filter on every node: hide non-matching, light up matching ones. */
function applyFilterState() {
  const on = filtering();
  for (const v of viz) {
    const vis = isVisible(v.def);
    const lit = vis && on;
    v.el.classList.toggle("filtered-out", !vis);
    v.el.classList.toggle("filter-on", lit);
    v.link.classList.toggle("lit", lit);
    v.link.setAttribute("stroke-opacity", !vis ? "0" : lit ? "0.5" : "0.18");
    v.label.style.opacity = !vis ? "0" : lit ? "0.85" : "0.34";
  }
}

function toggleGroup(group: string, item: HTMLElement) {
  if (activeGroups.has(group)) activeGroups.delete(group);
  else activeGroups.add(group);
  const active = activeGroups.has(group);
  item.classList.toggle("active", active);
  item.setAttribute("aria-pressed", active ? "true" : "false");
  $("legend").classList.toggle("filtering", filtering());
  // stagger the pulse across the visible nodes so it ripples rather than blinks in unison
  let i = 0;
  for (const v of viz) if (isVisible(v.def)) v.el.style.setProperty("--d", (i++ * 0.12).toFixed(2) + "s");
  layout(); // redistribute the remaining nodes around the backend (animated via left/top easing)
}

// ---- Build the legend, nodes, links and the active-link overlay ------------
function renderScenarios() {
  const legend = $("legend");
  for (const group of Object.keys(GROUP_COLORS)) {
    const hex = GROUP_COLORS[group];
    const item = document.createElement("button");
    item.type = "button";
    item.className = "item";
    item.style.setProperty("--c", hex);
    item.setAttribute("aria-pressed", "false");
    item.title = `Show only ${group} scenarios`;
    item.innerHTML = `<span class="swatch" style="background:${hex};color:${hex}"></span>${group}`;
    item.addEventListener("click", () => toggleGroup(group, item));
    legend.appendChild(item);
  }

  for (const def of SCENARIOS) {
    const color = groupColor(def.group);

    const link = document.createElementNS(SVGNS, "line") as SVGLineElement;
    link.setAttribute("class", "idle-link");
    link.setAttribute("stroke", color);
    link.setAttribute("stroke-width", "1.4");
    link.setAttribute("stroke-opacity", "0.18");
    link.setAttribute("stroke-dasharray", "3 7");
    linksSvg.appendChild(link);

    // auth mode riding on the link toward the centre
    const label = document.createElementNS(SVGNS, "text") as SVGTextElement;
    label.setAttribute("class", "link-label");
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("dy", "-3");
    label.style.fill = color;
    label.style.opacity = "0.34";
    label.textContent = def.expectedMode;
    linksSvg.appendChild(label);

    const el = document.createElement("button");
    el.className = "node";
    el.style.setProperty("--clr", color);
    el.innerHTML = `<span class="ico">${def.icon}</span><span class="meta"><span class="nm">${def.label}</span></span>`;
    el.addEventListener("click", () => startScenario(def));
    const hot = (on: boolean) => {
      if (document.body.classList.contains("focused")) return;
      link.setAttribute("stroke-opacity", on ? "0.6" : "0.18");
      label.style.opacity = on ? "0.95" : "0.34";
    };
    el.addEventListener("mouseenter", () => hot(true));
    el.addEventListener("mouseleave", () => hot(false));
    stage.appendChild(el);

    viz.push({ def, el, link, label, color });
  }

  activeLink = document.createElementNS(SVGNS, "line") as SVGLineElement;
  activeLink.setAttribute("class", "active-link");
  activeLink.setAttribute("stroke-width", "2.5");
  activeLink.setAttribute("stroke-linecap", "round");
  activeLink.setAttribute("stroke-dasharray", "2 9");
  activeLink.setAttribute("stroke-opacity", "0");
  linksSvg.appendChild(activeLink);

  activeLabel = document.createElementNS(SVGNS, "text") as SVGTextElement;
  activeLabel.setAttribute("class", "active-label");
  activeLabel.setAttribute("text-anchor", "middle");
  linksSvg.appendChild(activeLabel);
}

// ---- Hub layout: 12 nodes on an adaptive ellipse around the backend --------
function layout() {
  const r = stage.getBoundingClientRect();
  W = r.width; H = r.height;
  cx = W / 2; cy = H / 2;
  // Landscape stages spread wider than tall; on narrow screens shrink the horizontal padding.
  const pad = W < 640 ? 52 : 110;
  const rx = Math.max(120, Math.min(W / 2 - pad, 620));
  const ry = Math.max(150, Math.min(H / 2 - 76, 340));
  linksSvg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  centerEl.style.left = cx + "px";
  centerEl.style.top = cy + "px";

  // Only the nodes matching the active filter take a slot on the ring; the rest fade out (see
  // applyFilterState), so the visible ones spread evenly instead of leaving gaps.
  const visible = viz.filter((v) => isVisible(v.def));
  const n = visible.length || 1;
  visible.forEach((v, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const x = cx + rx * Math.cos(a);
    const y = cy + ry * Math.sin(a);
    home.set(v.def.app, { x, y });
    v.el.style.left = x + "px";
    v.el.style.top = y + "px";
    v.link.setAttribute("x1", String(cx)); v.link.setAttribute("y1", String(cy));
    v.link.setAttribute("x2", String(x));  v.link.setAttribute("y2", String(y));

    // place + orient the mode label along the link (kept upright on the left half)
    const t = 0.58;
    const lx = cx + (x - cx) * t;
    const ly = cy + (y - cy) * t;
    let deg = Math.atan2(y - cy, x - cx) * 180 / Math.PI;
    if (deg > 90 || deg < -90) deg += 180;
    v.label.setAttribute("x", String(lx));
    v.label.setAttribute("y", String(ly));
    v.label.setAttribute("transform", `rotate(${deg} ${lx} ${ly})`);
  });

  applyFilterState();
}

// ---- Focus: slide the picked scenario + backend together, animate the link -
function focusScenario(def: ScenarioDef) {
  const me = viz.find((v) => v.def.app === def.app);
  if (!me) return;
  document.body.classList.add("focused");
  document.documentElement.style.setProperty("--clr", me.color);
  $("p-desc").textContent = def.description;

  // Node targets, by width: wide = horizontal (panel right 50%); medium = vertical strip
  // (panel right 60%); narrow = vertical at top (panel = bottom sheet). Vertical saves width.
  let scnT: { x: number; y: number }, srvT: { x: number; y: number };
  if (W > 1000) {
    const leftW = W * 0.46;
    scnT = { x: leftW * 0.26, y: H * 0.46 };
    srvT = { x: leftW * 0.74, y: H * 0.46 };
  } else if (W > 780) {
    const stripX = W * 0.20; // centre of the left 40% strip
    scnT = { x: stripX, y: H * 0.30 };
    srvT = { x: stripX, y: H * 0.70 };
  } else {
    scnT = { x: W * 0.5, y: H * 0.11 };
    srvT = { x: W * 0.5, y: H * 0.27 };
  }

  for (const v of viz) {
    v.label.style.opacity = "0"; // hub labels off in focus
    v.el.classList.remove("filter-on"); // pause the hub filter pulse while focused
    v.link.classList.remove("lit");
    if (v.def.app === def.app) {
      v.el.classList.add("selected"); v.el.classList.remove("dim");
      const h = home.get(v.def.app)!;
      v.el.style.transform = `translate(-50%,-50%) translate(${scnT.x - h.x}px, ${scnT.y - h.y}px)`;
      v.link.setAttribute("stroke-opacity", "0");
    } else {
      v.el.classList.add("dim"); v.el.classList.remove("selected");
      v.link.setAttribute("stroke-opacity", "0");
    }
  }
  centerEl.style.transform = `translate(-50%,-50%) translate(${srvT.x - cx}px, ${srvT.y - cy}px)`;

  // active link between the two targets
  activeLink.setAttribute("x1", String(scnT.x)); activeLink.setAttribute("y1", String(scnT.y));
  activeLink.setAttribute("x2", String(srvT.x)); activeLink.setAttribute("y2", String(srvT.y));
  activeLink.setAttribute("stroke", me.color);
  activeLink.setAttribute("stroke-opacity", "0.85");
  activeLink.classList.add("flowing");

  // mode label on the active link — above it when horizontal, beside it when vertical
  const mx = (scnT.x + srvT.x) / 2, my = (scnT.y + srvT.y) / 2;
  const vertical = Math.abs(srvT.y - scnT.y) > Math.abs(srvT.x - scnT.x);
  if (vertical) {
    activeLabel.setAttribute("x", String(mx + 20)); activeLabel.setAttribute("y", String(my + 4));
    activeLabel.setAttribute("text-anchor", "start");
  } else {
    activeLabel.setAttribute("x", String(mx)); activeLabel.setAttribute("y", String(my - 16));
    activeLabel.setAttribute("text-anchor", "middle");
  }
  activeLabel.style.fill = me.color;
  activeLabel.textContent = def.expectedMode;

  spawnPackets(scnT, srvT);
}

function back() {
  document.body.classList.remove("focused");
  activeLink.setAttribute("stroke-opacity", "0");
  activeLink.classList.remove("flowing");
  packetsEl.innerHTML = "";
  for (const v of viz) {
    v.el.classList.remove("dim", "selected");
    v.el.style.transform = "translate(-50%,-50%)";
  }
  centerEl.style.transform = "translate(-50%,-50%)";
  applyFilterState(); // restore the hub filter highlight / hidden state
  activeDef = null;
}

// ---- Packets travelling along the active link (request out, response back) -
function spawnPackets(a: { x: number; y: number }, b: { x: number; y: number }) {
  packetsEl.innerHTML = "";
  const make = (kind: "req" | "res", delay: number) => {
    const p = document.createElement("div");
    p.className = "packet " + kind;
    packetsEl.appendChild(p);
    const from = kind === "req" ? a : b;
    const to = kind === "req" ? b : a;
    p.animate(
      [
        { transform: `translate(${from.x}px, ${from.y}px) translate(-50%,-50%) scale(0.4)`, opacity: 0 },
        { opacity: 1, offset: 0.12 },
        { opacity: 1, offset: 0.88 },
        { transform: `translate(${to.x}px, ${to.y}px) translate(-50%,-50%) scale(0.9)`, opacity: 0 },
      ],
      { duration: 1500, delay, iterations: Infinity, easing: "linear" },
    );
  };
  make("req", 0);
  make("req", 500);
  make("req", 1000);
  make("res", 750);
}

// ---- Ambient background: drifting signal dust ------------------------------
const bg = $("bg") as HTMLCanvasElement;
const ctx = bg.getContext("2d")!;
const dpr = Math.min(window.devicePixelRatio || 1, 2);
let dots: { x: number; y: number; vx: number; vy: number; r: number; a: number }[] = [];
function sizeBg() {
  const r = stage.getBoundingClientRect();
  bg.width = r.width * dpr; bg.height = r.height * dpr;
  bg.style.width = r.width + "px"; bg.style.height = r.height + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  dots = Array.from({ length: 46 }, () => ({
    x: Math.random() * r.width, y: Math.random() * r.height,
    vx: (Math.random() - 0.5) * 0.12, vy: (Math.random() - 0.5) * 0.12,
    r: Math.random() * 1.4 + 0.4, a: Math.random() * 0.4 + 0.1,
  }));
}
function tick() {
  const r = stage.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  for (const d of dots) {
    d.x += d.vx; d.y += d.vy;
    if (d.x < 0) d.x = r.width; if (d.x > r.width) d.x = 0;
    if (d.y < 0) d.y = r.height; if (d.y > r.height) d.y = 0;
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(130,150,200,${d.a})`;
    ctx.fill();
  }
  requestAnimationFrame(tick);
}

// ---- Boot ------------------------------------------------------------------
renderScenarios();
layout();
sizeBg();
// enable left/top easing only after the initial positions are set (avoids a corner slide-in)
requestAnimationFrame(() => document.body.classList.add("ready"));
if (!matchMedia("(prefers-reduced-motion: reduce)").matches) tick();

const libSource = __ATOMIC_SRC__ ? "../atomic/src (sources)" : "npm package";
$("s-lib").textContent = "@sinequa/atomic";
$("lib-badge").title = libSource;

$("creds-form").addEventListener("submit", submitCredentials);
$("expire").addEventListener("click", expireToken);
$("logout").addEventListener("click", doLogout);
$("clear").addEventListener("click", clearLog);
$("back").addEventListener("click", back);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && activeDef) back(); });

const statusCard = $("status-card");
const statusToggle = $("status-toggle");
statusToggle.addEventListener("click", () => {
  const open = statusCard.classList.toggle("open");
  statusToggle.setAttribute("aria-expanded", open ? "true" : "false");
});

window.addEventListener("resize", () => {
  sizeBg();
  layout();
  if (activeDef) focusScenario(activeDef);
});

const resume = sessionStorage.getItem(RESUME_KEY);
if (resume) {
  const def = SCENARIOS.find((s) => s.app === resume);
  sessionStorage.removeItem(RESUME_KEY);
  if (def) resumeScenario(def);
} else {
  log(`Library: @sinequa/atomic  ·  ${libSource}`, "muted");
  log("Pick a login scenario in the constellation. Each runs against the in-process mock Sinequa backend.", "muted");
}
