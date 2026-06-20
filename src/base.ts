// Base path the app is served from, derived from Vite's `import.meta.env.BASE_URL`:
//   - dev / preview at root → "/"  → BASE = ""    (URLs stay root-absolute, unchanged from before)
//   - production GitHub Pages build → "/sinequa-auth-playground/" → BASE = "/sinequa-auth-playground"
//
// Every hard-coded `/api/...` / `/__mock/...` fetch in the client must go through `apiUrl()` so the
// request lands inside the Service Worker scope on Pages. In dev the prefix is "" → no change.
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export const apiUrl = (path: string): string => BASE + path;
