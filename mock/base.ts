// Base path under which the mock backend is served.
//
// - In `npm run dev` (Vite middleware, see mock-plugin.ts) the app is served at the domain root,
//   so the base stays "" and every URL the handlers emit is root-absolute (`/api/...`, `/__mock/...`).
// - In the production GitHub Pages build the app lives under a sub-path (e.g.
//   `/sinequa-auth-playground/`). The Service Worker (mock/sw.ts) calls `setMockBase()` with its
//   registration scope so the handlers prefix every URL they hand back to the client — otherwise the
//   browser would resolve a root-absolute `/__mock/idp` against the origin and escape the SW scope.
//
// The handlers route on the *base-stripped* pathname (the SW removes the prefix before calling them),
// but they GENERATE URLs through `withBase()` so redirects land back inside the scope.

let mockBase = "";

/** Set the base path (trailing slash tolerated). Called once by the SW; never by the dev plugin. */
export function setMockBase(base: string): void {
  mockBase = base.replace(/\/$/, "");
}

export function getMockBase(): string {
  return mockBase;
}

/**
 * Prefix a root-absolute path (`/...`) with the mock base. Full URLs (http/https) and paths that are
 * already prefixed are returned untouched, so it is safe to apply more than once. No-op when the base
 * is "" (dev), keeping the emitted URLs byte-for-byte identical to today.
 */
export function withBase(path: string): string {
  if (!mockBase || !path.startsWith("/")) return path;
  if (path === mockBase || path.startsWith(mockBase + "/")) return path;
  return mockBase + path;
}
