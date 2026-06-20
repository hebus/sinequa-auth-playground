// A mock SPFx `AadHttpClient`, faithful enough for `@sinequa/atomic` to route through.
//
// In a real SharePoint Framework web part, `context.aadHttpClientFactory.getClient(resource)` returns
// an `AadHttpClient` whose `.get()/.post()` transparently attach an Azure AD access token (scoped to
// the Sinequa-registered AAD app) to every call. The library's HTTP helpers, once handed such a client
// via `initializeAadHttpClient(client)` (from `@sinequa/atomic/spfx`), route ALL requests through it.
//
// Here the token comes from the mock Azure AD token endpoint (`/__mock/aad-token`, standing in for
// login.microsoftonline.com). We fetch it once, cache it, and attach it as `Authorization: Bearer` on
// each request — exactly what the framework does under the hood. `handleResponse` accepts any
// `Response`-like object, so we just return the real `fetch` Response.

// `@sinequa/atomic/spfx` is a subpath of the SAME library that re-exports the AadHttpClient manager
// (`initializeAadHttpClient`, `aadHttpClientManager`). Loaded lazily so non-SPFx runs never touch it.
// Both the npm build and the sources re-export the manager from one shared chunk, so its singleton is
// the very instance the shared HTTP helpers consult — the injected client really does route every call.
import { apiUrl } from "./base";

type SpfxApi = typeof import("@sinequa/atomic/spfx");

let spfx: SpfxApi | null = null;
async function loadSpfx(): Promise<SpfxApi> {
  if (!spfx) spfx = await import("@sinequa/atomic/spfx");
  return spfx;
}

/** The Sinequa AAD application the web part is granted permission to call. */
export const SPFX_RESOURCE = "api://sinequa-search/.default";

type SendOptions = { method?: string; headers?: Headers; body?: BodyInit | null; signal?: AbortSignal | null };
type AadTokenResponse = { access_token: string; expires_in: number };

/** Mints (and caches) an Azure AD access token via the mock token endpoint. */
export function makeAadTokenProvider(log?: (msg: string) => void) {
  let cached: string | null = null;
  return async function getToken(): Promise<string> {
    if (cached) return cached;
    const res = await fetch(apiUrl(`/__mock/aad-token?resource=${encodeURIComponent(SPFX_RESOURCE)}`));
    const { access_token, expires_in } = (await res.json()) as AadTokenResponse;
    cached = access_token;
    log?.(`SPFx: Azure AD token acquired (expires_in=${expires_in}s)`);
    return access_token;
  };
}

/**
 * Builds a duck-typed `AadHttpClient`. The library calls `client.get/post(url, configurations.v1, …)`
 * (and `client.fetch(...)` for PUT/PATCH/DELETE) and reads `client.constructor.configurations.v1`, so
 * `configurations` must be a static on the class.
 */
export function makeMockAadHttpClient(getToken: () => Promise<string>) {
  class MockAadHttpClient {
    // Read by the library as `(client.constructor as any).configurations.v1`.
    static readonly configurations = { v1: { __mock: "v1" } };

    get(url: string, _config: unknown, options?: SendOptions): Promise<Response> {
      return this.send("GET", url, options);
    }
    post(url: string, _config: unknown, options?: SendOptions): Promise<Response> {
      return this.send("POST", url, options);
    }
    fetch(url: string, _config: unknown, options?: SendOptions): Promise<Response> {
      return this.send(options?.method ?? "GET", url, options);
    }

    private async send(method: string, url: string, options?: SendOptions): Promise<Response> {
      const token = await getToken();
      const headers = new Headers(options?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      // Goes through the harness-wrapped window.fetch, so the call shows up in the activity log.
      // `credentials: "include"` keeps the web-token session cookie the server issues.
      return fetch(url, {
        method,
        headers,
        body: options?.body ?? undefined,
        credentials: "include",
        signal: options?.signal ?? undefined,
      });
    }
  }
  return new MockAadHttpClient();
}

/**
 * Acquire an Azure AD token and inject a mock `AadHttpClient` via `@sinequa/atomic/spfx`. The library's
 * HTTP helpers then route every request through it, attaching `Authorization: Bearer`.
 */
export async function initSpfxAadHttpClient(log: (msg: string) => void): Promise<void> {
  const { initializeAadHttpClient } = await loadSpfx();
  const getToken = makeAadTokenProvider(log);
  await getToken(); // acquire up-front so the log reads in order
  initializeAadHttpClient(makeMockAadHttpClient(getToken));
}

/** Detach any injected AadHttpClient so a previous SPFx run never leaks into the next scenario. */
export function resetSpfxAadHttpClient(): void {
  // No-op until the spfx subpath has been loaded (i.e. before any SPFx run).
  spfx?.aadHttpClientManager.initialize(null);
}
