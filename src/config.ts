/**
 * Environment-driven configuration.
 *
 * Nothing here is read at import time beyond process.env so the module stays
 * trivially testable; callers get a frozen snapshot from loadConfig().
 */

export interface Config {
  /** Root of the FlowPlus API, e.g. http://localhost:5012 */
  baseUrl: string;
  username: string;
  password: string;
  /** Application code used for the launch-token exchange. */
  appCode: string;
  /** Optional tenant, sent as X-Tenant-Id when present. */
  tenantId?: string;
  /** Base URL of Workflow Studio, used to build human review links. */
  studioUrl: string;
  /** Draft writes are refused unless this is explicitly enabled. */
  writeEnabled: boolean;
  requestTimeoutMs: number;
}

function required(name: string, value: string | undefined): string {
  if (!value || !value.trim()) {
    throw new Error(
      `${name} is not set. flowplus-flow-mcp needs FLOWPLUS_BASE_URL, FLOWPLUS_USERNAME and FLOWPLUS_PASSWORD.`,
    );
  }
  return value.trim();
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Object.freeze({
    baseUrl: stripTrailingSlash(required("FLOWPLUS_BASE_URL", env.FLOWPLUS_BASE_URL)),
    username: required("FLOWPLUS_USERNAME", env.FLOWPLUS_USERNAME),
    password: required("FLOWPLUS_PASSWORD", env.FLOWPLUS_PASSWORD),
    appCode: (env.FLOWPLUS_APP_CODE || "flowplus2").trim(),
    tenantId: env.FLOWPLUS_TENANT_ID?.trim() || undefined,
    studioUrl: stripTrailingSlash(env.FLOWPLUS_STUDIO_URL || "http://localhost:4400"),
    // Opt-in, and only the exact string "true" counts.
    writeEnabled: (env.FLOWPLUS_WRITE_ENABLED || "").trim().toLowerCase() === "true",
    requestTimeoutMs: Number(env.FLOWPLUS_TIMEOUT_MS || 60_000),
  });
}
