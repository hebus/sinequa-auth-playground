import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { sinequaMock } from "./mock/mock-plugin";

// App code always imports `@sinequa/atomic` (and, for the SPFx scenario, its `@sinequa/atomic/spfx`
// subpath). By default both resolve to the published npm package (see package.json). Set ATOMIC=src
// to alias them to the LIVE TypeScript sources of the sibling repo (`../atomic/src`) so the harness
// exercises the current, unbuilt code (incl. tryAutoAuthentication and the SPFx AadHttpClient manager)
// with no build step. Adjust the paths if your atomic checkout lives elsewhere.
//
// The SPFx scenario injects a mock AadHttpClient via `@sinequa/atomic/spfx` (initializeAadHttpClient).
// Its routing only takes effect when the subpath and the main entry share ONE module graph — i.e. the
// same `aadHttpClientManager` singleton — which holds under ATOMIC=src (single source tree). On Windows
// PowerShell, set the env var inline: `$env:ATOMIC='src'; npm run dev`.
const useSource = process.env.ATOMIC === "src";
const src = (p: string) => fileURLToPath(new URL(`../atomic/src/${p}`, import.meta.url));

// Order matters: the more specific `/spfx` key must precede `@sinequa/atomic` so the subpath import
// isn't swallowed by the base alias.
const alias: Record<string, string> = useSource
  ? {
      "@sinequa/atomic/spfx": src("spfx/index.ts"),
      "@sinequa/atomic": src("index.ts"),
    }
  : {};

export default defineConfig({
  resolve: { alias },
  define: {
    __ATOMIC_SRC__: JSON.stringify(useSource),
  },
  plugins: [sinequaMock()],
});
