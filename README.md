# Sinequa Auth Playground

A standalone **Vite** project that exercises every `@sinequa/atomic` login mode against an
**in-process mock Sinequa backend** — no real server, no CORS, no cookies headache.

- The harness page (`src/main.ts`) resolves `@sinequa/atomic` from the **published npm package** by
  default. Set `ATOMIC=src` to instead alias it to the **live `@sinequa/atomic` sources** from the
  sibling `../atomic` checkout (Vite alias → `../atomic/src/index.ts`); editing the auth code there is
  then reflected on reload — so this doubles as a living test bench for `login()` /
  `tryAutoAuthentication()`. See [Choosing the atomic source](#choosing-the-atomic-source).
- The mock backend (`mock/`) runs as a **Vite dev-server middleware**, so everything is served from
  one origin (`http://localhost:5173`). `credentials: "include"`, `Set-Cookie`, and redirects all
  work without CORS.

## Run

```bash
npm install
npm run dev
# open http://localhost:5173
```

### Choosing the atomic source

| Mode | How | Resolves `@sinequa/atomic` to |
|---|---|---|
| **npm package** (default) | `npm run dev` | the published `@sinequa/atomic` in `node_modules` (see `package.json`) |
| **Live sources** | `ATOMIC=src npm run dev` | `../atomic/src/index.ts` (no build step; edits reflected on reload) |

On Windows PowerShell, set the env var inline: `$env:ATOMIC='src'; npm run dev`.

> Live-sources mode requires the `@sinequa/atomic` repo checked out at `../atomic` (i.e.
> `c:\dev\atomic`). If it lives elsewhere, edit the path in `vite.config.ts`. The TypeScript
> type-checker always uses the installed npm package's types (compatible with the sources).

Click a scenario on the left; the status panel shows the resolved `authMode`, the `login()` result and
`isAuthenticated()`, and the log mirrors every network call.

## Scenarios

The scenario is chosen by the **`app` name** (sent on every request), so there is no shared mutable
state. Pre-login pins it in a `mock-scenario` cookie for the param-less endpoints.

| Scenario | What it proves |
|---|---|
| **Credentials** | No provider, probe 401 → credentials form → `security.webtoken` authenticates. |
| **Credentials (legacy webToken)** | Same UX, but the form posts to the **legacy** `api/v1/webToken` (`{ action:"get", user, password, tokenInCookie:true }` → `{ csrfToken }`) instead of `security.webtoken`. |
| **SSO** | `getCsrfToken` returns a token immediately (proxy/browser SSO) → `sso`. |
| **OAuth redirect** | Provider advertised → `security.oauth` → fake IdP sets a session → back → authenticated. |
| **SAML redirect** | Same via `security.saml`. |
| **Bearer token** | `bearerToken` set → `security.webtoken` with `Authorization: Bearer` → authenticated. |
| **OIDC auto-auth ✨** | No provider; `getCsrfToken` empty; the principal probe (no `noAutoAuthentication`) returns **200** → `tryAutoAuthentication` → `sso`. **Validates the new code.** |
| **OIDC, no IdP session** | Probe returns **401** → deterministic fallback to the credentials form (no false positive). |
| **OAuth loop guard** | Fake IdP returns **without** a session → the one-shot redirect loop guard throws instead of looping forever. |
| **Impersonation (user override)** | Sign in as admin, then toggle `userOverride`: `fetchPrincipal` carries `sinequa-override-user`/`-domain` headers and the server answers as the impersonated user. Header-driven — **no re-login**. |

### Legacy `webToken` (credentials)

`api/v1/webToken` is the **old** credentials endpoint, kept for clients that predate
`security.webtoken`. The call shape is:

```http
POST api/v1/webToken?noUserOverride=true&noAutoAuthentication=true
{ "action": "get", "user": "...", "password": "...", "tokenInCookie": true }
→ 200 { "csrfToken": "..." }   + Set-Cookie: sinequa-web-token=…
```

`@sinequa/atomic`'s `login()` does **not** use this path (it always posts to `security.webtoken`), so
the **Credentials (legacy webToken)** scenario submits the form to `webToken` directly, then calls
`fetchPrincipal()` to prove the resulting cookie session authenticates. Because the flow is
out-of-band from atomic's token store, the **isAuthenticated** pill stays `false` — success is shown
by the returned `csrfToken` and the `200` from `fetchPrincipal()` in the log. Bad/missing credentials
return `401` with the same `WWW-Authenticate: Bearer realm="sinequa"` challenge as the other
credential modes.

### Provider logout & the fake IdP (OAuth / SAML)

The fake IdP models a real OAuth/OIDC provider, including its **own session**:

- The `oauth`/`saml` handshake redirects to `/__mock/idp`, which shows a small **IdP sign-in page**
  when there is no IdP session (click "Sign in as demo" → it grants the session and returns). If an
  IdP session already exists, the redirect is silent (SSO).
- On logout, `deleteWebTokenCookie` returns a `logoutUrl` (`/__mock/idp-logout`); following it
  **terminates the IdP session**. The next handshake therefore lands back on the IdP sign-in page —
  i.e. logout *sticks*, instead of the provider silently re-authenticating you. This mirrors a real
  Sinequa OAuth/SAML logout (which redirects to the IdP end-session endpoint).

### Session controls
- **⏱️ Expire token** — invalidates the app session, then calls `fetchPrincipal()` to show the
  resulting `401` (in a real app the error interceptor would re-run `signIn()`).
- **🚪 Logout** — `deleteWebTokenCookie` + clears local tokens; for provider modes it also follows the
  `logoutUrl` to end the IdP session.

## How it maps to the real contract

The mock implements only what the auth/bootstrap flow touches:

| Method | Endpoint | Role |
|---|---|---|
| GET | `api/v1/app?preLogin=true` | `fetchAppPreLogin` (advertises providers per scenario) |
| GET | `api/v1/app` | `fetchApp` (minimal `CCApp`) |
| GET | `api/v1/challenge?action=getCsrfToken` | `getCsrfToken` (token if session/SSO, else `{}`) |
| GET | `api/v1/challenge?action=deleteWebTokenCookie` | `logout` |
| POST | `api/v1/security.webtoken` | credentials / bearer login |
| POST | `api/v1/webToken` | **legacy** credentials login (`action=get` → `{ csrfToken }`) |
| POST | `api/v1/security.oauth` / `.saml` | returns `redirectUrl` to the fake IdP |
| GET | `api/v1/principal?action=get` | **probe** (auto-auth allowed) vs `fetchPrincipal` (`noAutoAuthentication=true`) |
| GET | `api/v1/usersettings` | app init (stub) |

Response token plumbing matches atomic: success sets the `sinequa-web-token` cookie and returns the
`sinequa-jwt-refresh` header (consumed by `handleResponse` → `setToken`).

Control endpoints: `GET /__mock/idp` (fake IdP), `POST /__mock/expire`, `GET /__mock/state`.

## Auth-mode detection: config/probe vs `WWW-Authenticate`

There are two ways a client can discover *how* to authenticate. They are **complementary, not
interchangeable** — they solve different problems.

- **A — config/probe (what `@sinequa/atomic` does today).** The client *deduces* the mode from
  `app?preLogin` (providers advertised), `challenge?action=getCsrfToken` (token present?), and the
  `principal` probe (`200` vs `401`).
- **B — HTTP `WWW-Authenticate` challenge (RFC 7235).** The client hits a protected resource, the
  server answers `401` + `WWW-Authenticate: <scheme> …`, and the client *reacts* to the advertised
  scheme. This is what the **legacy** client in this playground expects (`/^Bearer ?/`), and why the
  mock emits `WWW-Authenticate: Bearer realm="sinequa"` on credential/bearer `401`s.

| Criterion | A — config/probe (atomic) | B — `WWW-Authenticate` |
|---|---|---|
| HTTP conformance | Sinequa-proprietary | Standard RFC 7235; interops with generic clients/proxies |
| Bootstrap round-trips | 2–3 calls | 1 (a `401` on any protected resource) |
| Mid-session expiry | Handled separately (401 interceptor → re-`signIn()`) | Natural: any `401` re-advertises the scheme |
| Provider metadata | Rich: *which* OAuth/SAML provider, auto vs manual, redirect URL | Poor: `Bearer realm=…` can't say "redirect to this IdP" |
| Non-Bearer modes (OAuth/SAML) | Modelled cleanly (provider redirect) | Badly expressed — a header can't model a browser redirect to an IdP |
| Browser pitfall | None | ⚠️ `Basic`/`Negotiate` triggers the browser's **native** auth dialog (bad for an SPA); `Bearer` is safe |
| Cross-origin (CORS) | n/a | Custom header needs `Access-Control-Expose-Headers` to be readable from JS |
| Determinism / testability | High (explicit signals) | Depends on the server emitting the right header on the right endpoint |
| Config ↔ server drift | Possible (local config vs server reality) | Server is the source of truth at request time |

**Why atomic uses A.** Sinequa's modes don't reduce to standard HTTP schemes: OAuth/SAML need a
*redirect to an IdP* with parameters (which provider, return URL) that `preLogin` carries natively but
a `WWW-Authenticate` challenge cannot. And `Basic`/`Negotiate` challenges would pop the browser's
native login dialog — unacceptable in a SPA. So **A is the right choice for initial multi-mode
detection.**

**Where B still wins.** Legacy/generic interop (this playground's legacy client *requires* the header)
and a more standard "`401` → re-auth" path on token expiry.

**Recommendation.** Don't replace A with B. Keep **A** for start-up mode detection (it carries the
provider metadata B can't express) and treat **B** as a complementary signal for legacy interop and
the expiry/re-auth path. Atomic needs no change today; if one day you want a more standard re-auth on
expiry, `handle-response.ts` (which already reads `sinequa-jwt-refresh`) could also read
`WWW-Authenticate` — an optional enhancement, not a redesign of detection.

### Is `WWW-Authenticate` useful per mode?

The header only earns its keep where **the client holds a token it can refresh itself**. Where auth is
*ambient* (proxy SSO) or via *IdP redirect* (OAuth/SAML/OIDC), the header's "go get a Bearer token"
semantics don't match the actual remediation, so its only residual value is as an expiry flag.

| Mode | Worth reading it? | Why |
|---|---|---|
| **bearer** (server-to-server) | ✅ **Most useful** | Canonical RFC 6750 use. The client owns the token; on expiry, `WWW-Authenticate: Bearer error="invalid_token"` is the standard "your token is stale, fetch a new one" signal. |
| **credentials** | ✅ Useful | Legacy interop **plus** telling expiry (`error="invalid_token"`) apart from "never authenticated" → silent re-auth vs re-showing the form. |
| **oauth / saml** | 🟡 Marginal | It can *signal* expiry, but the fix is a **redirect to the IdP**, whose metadata comes from `preLogin`/`security.oauth`, not the header — and a plain `401` already triggers re-`signIn()`. |
| **oidc auto-auth** | 🟡 Marginal | Ambient IdP session; `401` → re-probe. The header only adds the expiry flag; the action stays config/probe. |
| **sso** (proxy / browser) | ❌ Not useful / below the layer | `Negotiate`/`NTLM` challenges are consumed by the **browser/OS natively**, beneath atomic. The JS layer can't usefully act; re-negotiation is transparent. |

**Bottom line.** If atomic ever reads `WWW-Authenticate`, the mode that truly justifies it is
**`bearer`** (then `credentials`). For OAuth/SAML/SSO the effort doesn't pay off: config/probe
detection plus the existing `401 → signIn()` already cover the need, and the header can't express the
right remediation (proxy re-negotiation or IdP redirect).

## Files

```
vite.config.ts        # atomic resolution (npm default, ATOMIC=src for sources) + mock plugin
index.html, src/      # the playground page + scenario logic
mock/                 # mock-plugin (middleware), handlers, sessions, fixtures
```
