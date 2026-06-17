// Minimal Sinequa response fixtures. Shapes follow @sinequa/atomic types:
// CCAppPreLogin (src/types/config/CCAppPreLogin.ts), Principal (src/types/principal/Principal.ts).
// Only the fields the auth/bootstrap flow reads are populated.

export type Scenario =
  | "creds"
  | "creds-legacy"
  | "sso"
  | "oauth"
  | "saml"
  | "bearer"
  | "spfx"
  | "oidc"
  | "oidc-expired"
  | "oauth-loop"
  | "impersonation";

export const SCENARIOS: Scenario[] = [
  "creds",
  "creds-legacy",
  "sso",
  "oauth",
  "saml",
  "bearer",
  "spfx",
  "oidc",
  "oidc-expired",
  "oauth-loop",
  "impersonation",
];

export function isScenario(value: string): value is Scenario {
  return (SCENARIOS as string[]).includes(value);
}

/** Pre-login config. Only `oauth*`/`saml` advertise a provider; everything else resolves to unknown. */
export function preLogin(scenario: Scenario) {
  const base = {
    apiPath: "/api/v1",
    applicationPath: "/app",
    auditEnabled: false,
    authenticationStorage: null,
    autoOAuthProvider: "",
    autoSAMLProvider: "",
    mode: "Debug",
    version: "11.14.0",
    versionDate: "2026-01-01",
    providers: {},
  };
  if (scenario === "oauth" || scenario === "oauth-loop") {
    return { ...base, autoOAuthProvider: "oauth-mock" };
  }
  if (scenario === "saml") {
    return { ...base, autoSAMLProvider: "saml-mock" };
  }
  return base;
}

/**
 * Current authenticated user. When an impersonation override is supplied (the request carried
 * `sinequa-override-user`/`-domain`), the server answers as the impersonated user instead of the
 * admin — exactly how Sinequa's header-driven user override behaves.
 */
export function principal(override?: { user: string; domain: string }) {
  if (override) {
    return {
      id: `${override.domain || "user"}|${override.user}`,
      name: override.user,
      fullName: `${override.user} (impersonated)`,
      longName: `${override.user} (impersonated)`,
      email: `${override.user}@example.com`,
      description: "Impersonated principal",
      userId: override.user,
      isAdministrator: false,
      isDelegatedAdmin: false,
      editablePartition: false,
      passwordExpirationDate: null,
    };
  }
  return {
    id: "user|demo",
    name: "demo",
    fullName: "Demo Admin",
    longName: "Demo Admin",
    email: "demo@example.com",
    description: "Mock admin principal",
    userId: "demo",
    isAdministrator: true,
    isDelegatedAdmin: false,
    editablePartition: false,
    passwordExpirationDate: null,
  };
}

/** Minimal full app config — not exercised by the harness, kept valid for completeness. */
export function app(scenario: Scenario) {
  return {
    name: scenario,
    versionId: "mock",
    apiVersion: "11.14.0",
    queries: {},
    rfms: {},
    indexes: { _: {} },
    lists: {},
    webServices: {},
    data: {},
    customJSONs: [],
    workspaceApp: "",
    defaultQueryName: "",
  };
}

export function userSettings() {
  return {};
}
