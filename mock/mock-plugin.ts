import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { handleApi, handleControl, type ParsedReq, type Result } from "./handlers";
import { SESSION_COOKIE, SCENARIO_COOKIE, IDP_COOKIE } from "./sessions";

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function applyResult(res: ServerResponse, result: Result): void {
  const cookies: string[] = [];
  if (result.setSession) {
    cookies.push(`${SESSION_COOKIE}=${result.setSession}; Path=/; SameSite=Lax`);
  }
  if (result.clearSession) {
    cookies.push(`${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`);
  }
  if (result.setScenario) {
    cookies.push(`${SCENARIO_COOKIE}=${result.setScenario}; Path=/; SameSite=Lax`);
  }
  if (result.setIdp) {
    cookies.push(`${IDP_COOKIE}=${result.setIdp}; Path=/; SameSite=Lax`);
  }
  if (result.clearIdp) {
    cookies.push(`${IDP_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`);
  }
  if (cookies.length) res.setHeader("Set-Cookie", cookies);
  if (result.refreshToken) res.setHeader("sinequa-jwt-refresh", result.refreshToken);

  if (result.redirectTo) {
    res.statusCode = result.status || 302;
    res.setHeader("Location", result.redirectTo);
    res.end();
    return;
  }

  if (result.html !== undefined) {
    res.statusCode = result.status;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(result.html);
    return;
  }

  res.statusCode = result.status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(result.json ?? null));
}

export function sinequaMock(): Plugin {
  return {
    name: "sinequa-mock-backend",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url || "/";
        if (!rawUrl.startsWith("/api/") && !rawUrl.startsWith("/__mock/")) {
          return next();
        }

        const url = new URL(rawUrl, "http://localhost");
        const origin = header(req, "origin");

        // Permissive CORS so the mock is also usable cross-origin (the harness is same-origin).
        if (origin) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Access-Control-Allow-Credentials", "true");
        }
        if (req.method === "OPTIONS") {
          res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
          res.setHeader(
            "Access-Control-Allow-Headers",
            "Content-Type, Sinequa-csrf-token, Sinequa-Force-Camel-Case, Authorization, accept, sinequa-override-user, sinequa-override-domain",
          );
          res.statusCode = 204;
          res.end();
          return;
        }

        const parsed: ParsedReq = {
          method: req.method || "GET",
          pathname: url.pathname,
          query: url.searchParams,
          cookies: parseCookies(req.headers.cookie),
          csrfHeader: header(req, "sinequa-csrf-token"),
          authHeader: header(req, "authorization"),
          overrideUser: header(req, "sinequa-override-user"),
          overrideDomain: header(req, "sinequa-override-domain"),
          body: req.method === "POST" ? await readBody(req) : {},
        };

        const result =
          (url.pathname.startsWith("/__mock/") ? handleControl(parsed) : handleApi(parsed)) ?? null;

        if (!result) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ errorMessage: `No mock for ${url.pathname}` }));
          return;
        }

        // eslint-disable-next-line no-console
        console.log(`[mock] ${parsed.method} ${url.pathname}${url.search} → ${result.status}`);
        applyResult(res, result);
      });
    },
  };
}
