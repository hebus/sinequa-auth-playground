// Harness scenario catalogue. The `app` name selects the server-side behaviour (see mock/fixtures.ts).

export type ScenarioDef = {
  app: string;
  label: string;
  description: string;
  icon: string;
  group: string;
  /** Show a username/password form and call login({username,password}). */
  credentials?: boolean;
  /**
   * Legacy credentials path: instead of atomic's `login()` (→ `security.webtoken`), submit the form
   * straight to the old `api/v1/webToken` endpoint (`{ action:"get", user, password }` → `{ csrfToken }`).
   */
  legacyCredentials?: boolean;
  /** Set globalConfig.bearerToken before bootstrapping. */
  bearer?: boolean;
  /** After authenticating, run the header-driven user-override (impersonation) demo. */
  impersonate?: boolean;
  expectedMode: string;
};

export const SCENARIOS: ScenarioDef[] = [
  {
    app: "creds",
    label: "Credentials",
    icon: "🔑",
    group: "Session",
    description: "No provider, no session → login form. Submit user/password → security.webtoken.",
    credentials: true,
    expectedMode: "credentials",
  },
  {
    app: "creds-legacy",
    label: "Credentials (legacy webToken)",
    icon: "🗝️",
    group: "Session",
    description:
      "Legacy path: POST api/v1/webToken { action:'get', user, password, tokenInCookie } → { csrfToken }.",
    credentials: true,
    legacyCredentials: true,
    expectedMode: "credentials",
  },
  {
    app: "sso",
    label: "SSO (proxy / browser)",
    icon: "🪟",
    group: "Session",
    description: "getCsrfToken returns a token immediately → authenticated as sso.",
    expectedMode: "sso",
  },
  {
    app: "bearer",
    label: "Bearer token",
    icon: "🎟️",
    group: "Session",
    description: "globalConfig.bearerToken set → security.webtoken with Authorization: Bearer.",
    bearer: true,
    expectedMode: "bearer",
  },
  {
    app: "oauth",
    label: "OAuth redirect",
    icon: "🔁",
    group: "Provider redirect",
    description: "Pre-login advertises an OAuth provider → fake IdP → back → authenticated.",
    expectedMode: "oauth",
  },
  {
    app: "saml",
    label: "SAML redirect",
    icon: "🔁",
    group: "Provider redirect",
    description: "Pre-login advertises a SAML provider → fake IdP → back → authenticated.",
    expectedMode: "saml",
  },
  {
    app: "oidc",
    label: "OIDC auto-auth",
    icon: "✨",
    group: "OIDC",
    description:
      "No provider; getCsrfToken empty; the principal probe (no noAutoAuthentication) returns 200 → tryAutoAuthentication → sso. Validates the new code.",
    expectedMode: "sso",
  },
  {
    app: "oidc-expired",
    label: "OIDC, no IdP session",
    icon: "🚫",
    group: "OIDC",
    description: "No provider; probe returns 401 → deterministic fallback to the credentials form.",
    credentials: true,
    expectedMode: "credentials",
  },
  {
    app: "oauth-loop",
    label: "OAuth loop guard",
    icon: "♾️",
    group: "Edge cases",
    description: "Fake IdP returns WITHOUT a session → the one-shot redirect loop guard throws.",
    expectedMode: "oauth",
  },
  {
    app: "impersonation",
    label: "Impersonation",
    icon: "🎭",
    group: "Edge cases",
    description:
      "Sign in as admin, then toggle userOverride: fetchPrincipal carries sinequa-override-* headers → impersonated user. Header-driven, no re-auth.",
    impersonate: true,
    expectedMode: "sso",
  },
];
