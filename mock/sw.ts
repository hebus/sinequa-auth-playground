/// <reference lib="webworker" />
//
// Browser-side mock Sinequa backend — the production (GitHub Pages) counterpart of the Vite dev
// middleware in mock-plugin.ts. GitHub Pages serves only static files, so the Node middleware is
// gone; this Service Worker reuses the SAME pure handlers (handlers.ts / sessions.ts / fixtures.ts)
// to answer `/api/*` and `/__mock/*` entirely in the browser — fetches AND top-level navigations
// (the OAuth/SAML flows redirect the whole page to the fake IdP, which only a SW can intercept).
//
// It is registered ONLY in the production build (see src/main.ts); `npm run dev` keeps using the Vite
// middleware, so local development is unchanged.

import { handleApi, handleControl, type ParsedReq, type Result } from "./handlers";
import { SESSION_COOKIE, SCENARIO_COOKIE, IDP_COOKIE } from "./sessions";
import { setMockBase, getMockBase } from "./base";

// Cast the worker global once (the project's tsconfig uses the DOM lib; the `webworker` reference above
// brings in the SW types). Avoids redeclaring `self` and the resulting lib conflict.
const worker = self as unknown as ServiceWorkerGlobalScope;

// The mock is served under the registration scope (e.g. `/sinequa-auth-playground/`). Handlers route
// on the base-stripped pathname but emit URLs through withBase(), so redirects stay inside the scope.
const BASE = new URL(worker.registration.scope).pathname.replace(/\/$/, "");
setMockBase(BASE);

// Virtual cookie store. In a Service Worker, synthetic `Set-Cookie` headers are NOT applied to the
// browser cookie jar and the request `Cookie` header is not readable — but since EVERY mock request
// flows through this one worker, it just holds the cookies itself and feeds them to the handlers.
// (The `Sinequa-csrf-token` request header is still readable, so the csrf path of isAuthed/tokenFor
// works natively for authenticated calls.)
const cookies: Record<string, string> = {};

function header(req: Request, name: string): string | null {
  return req.headers.get(name);
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.clone().text();
    if (!text) return {};
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Mirror applyResult() from mock-plugin.ts onto the virtual cookie store. */
function applyCookies(result: Result): void {
  if (result.setSession) cookies[SESSION_COOKIE] = result.setSession;
  if (result.clearSession) delete cookies[SESSION_COOKIE];
  if (result.setScenario) cookies[SCENARIO_COOKIE] = result.setScenario;
  if (result.setIdp) cookies[IDP_COOKIE] = result.setIdp;
  if (result.clearIdp) delete cookies[IDP_COOKIE];
}

function toResponse(result: Result): Response {
  const headers = new Headers();
  if (result.refreshToken) headers.set("sinequa-jwt-refresh", result.refreshToken);
  if (result.wwwAuthenticate) headers.set("WWW-Authenticate", result.wwwAuthenticate);

  if (result.redirectTo) {
    // redirectTo is already base-prefixed by the handlers (withBase); make it absolute for the SW.
    const location = new URL(result.redirectTo, worker.location.origin).href;
    return new Response(null, { status: result.status || 302, headers: { Location: location } });
  }

  if (result.html !== undefined) {
    headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(result.html, { status: result.status, headers });
  }

  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(result.json ?? null), { status: result.status, headers });
}

async function handle(request: Request, pathname: string, query: URLSearchParams): Promise<Response> {
  const parsed: ParsedReq = {
    method: request.method || "GET",
    pathname,
    query,
    cookies: { ...cookies },
    csrfHeader: header(request, "sinequa-csrf-token"),
    authHeader: header(request, "authorization"),
    overrideUser: header(request, "sinequa-override-user"),
    overrideDomain: header(request, "sinequa-override-domain"),
    body: request.method === "POST" ? await readBody(request) : {},
  };

  // IIS + Windows SSO signs every response with `Persistent-Auth: true` (RFC 4559) — mirror it for the
  // iis-sso scenario, as the dev middleware does.
  const persistentAuth =
    (query.get("app") || parsed.cookies[SCENARIO_COOKIE]) === "iis-sso";

  const result = pathname.startsWith("/__mock/") ? handleControl(parsed) : handleApi(parsed);

  if (!result) {
    return new Response(JSON.stringify({ errorMessage: `No mock for ${pathname}` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  applyCookies(result);
  const response = toResponse(result);
  if (persistentAuth) response.headers.set("Persistent-Auth", "true");
  return response;
}

worker.addEventListener("install", () => worker.skipWaiting());
worker.addEventListener("activate", (event) => event.waitUntil(worker.clients.claim()));

worker.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== worker.location.origin) return;

  // Strip the base prefix so handlers see root-absolute `/api/...` / `/__mock/...` paths.
  const base = getMockBase();
  let pathname = url.pathname;
  if (base && (pathname === base || pathname.startsWith(base + "/"))) {
    pathname = pathname.slice(base.length) || "/";
  }
  if (!pathname.startsWith("/api/") && !pathname.startsWith("/__mock/")) return;

  event.respondWith(handle(event.request, pathname, url.searchParams));
});
