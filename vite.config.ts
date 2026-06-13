import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { sinequaMock } from "./mock/mock-plugin";

// By default `@sinequa/atomic` resolves to the published npm package (see package.json).
// Set ATOMIC=src to instead alias to the LIVE TypeScript sources of the sibling repo
// (`../atomic/src/index.ts`) so the harness exercises the current, unbuilt code
// (incl. tryAutoAuthentication) with no build step. Adjust the path if your atomic
// checkout lives elsewhere.
const useSource = process.env.ATOMIC === "src";
const atomicSrc = fileURLToPath(new URL("../atomic/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: useSource ? { "@sinequa/atomic": atomicSrc } : {},
  },
  plugins: [sinequaMock()],
});
