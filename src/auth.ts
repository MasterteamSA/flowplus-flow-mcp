/**
 * FlowPlus uses a two-step token exchange, and getting this wrong is the most
 * common way to see a confusing 403:
 *
 *   1. POST /api/auth/login                  -> a *session* token
 *   2. GET  /api/applications/{code}/launch  -> an *application* token
 *
 * Control-panel endpoints reject the session token from step 1 with
 * AUTH_002 "Application APIs require an application access token". Only the
 * step-2 token works. Tokens are short-lived (10 minutes by default), so we
 * cache with a safety margin and re-run the whole exchange on expiry or 401.
 */

import type { Config } from "./config.js";

/** Refresh this long before actual expiry to avoid racing the clock. */
const EXPIRY_MARGIN_MS = 60_000;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export class TokenProvider {
  private cached?: CachedToken;
  /** De-dupes concurrent refreshes; several tools may start at once. */
  private inFlight?: Promise<string>;

  constructor(private readonly config: Config) {}

  /** Returns a valid application token, refreshing if needed. */
  async getToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAtMs - EXPIRY_MARGIN_MS) {
      return this.cached.token;
    }
    this.inFlight ??= this.exchange().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /** Drops the cache so the next getToken() re-authenticates. Called on 401. */
  invalidate(): void {
    this.cached = undefined;
  }

  private async exchange(): Promise<string> {
    const sessionToken = await this.login();
    const { token, expiresAtMs } = await this.launch(sessionToken);
    this.cached = { token, expiresAtMs };
    return token;
  }

  private async login(): Promise<string> {
    const body = await this.postJson("/api/auth/login", {
      username: this.config.username,
      password: this.config.password,
    });
    const token = body?.data?.tokens?.accessToken;
    if (typeof token !== "string" || !token) {
      throw new AuthError(
        `Login succeeded but no access token was returned. Response: ${JSON.stringify(body).slice(0, 300)}`,
      );
    }
    return token;
  }

  private async launch(sessionToken: string): Promise<{ token: string; expiresAtMs: number }> {
    const url = new URL(
      `/api/applications/${encodeURIComponent(this.config.appCode)}/launch`,
      this.config.baseUrl,
    );
    url.searchParams.set("returnUrl", this.config.studioUrl);
    url.searchParams.set("deviceToken", "flowplus-flow-mcp");

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${sessionToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    const body = (await response.json().catch(() => null)) as any;

    if (!response.ok) {
      throw new AuthError(
        `Application launch failed for app code "${this.config.appCode}" (HTTP ${response.status}). ` +
          `Check FLOWPLUS_APP_CODE. ${body?.errors?.message ?? ""}`.trim(),
        response.status,
      );
    }

    const token = body?.data?.tokens?.accessToken;
    if (typeof token !== "string" || !token) {
      throw new AuthError("Application launch returned no access token.");
    }

    // actualValue is ISO-8601 UTC; fall back to a conservative 10 minutes.
    const rawExpiry = body?.data?.tokens?.accessTokenExpiresAt?.actualValue;
    const parsed = rawExpiry ? Date.parse(rawExpiry) : NaN;
    const expiresAtMs = Number.isFinite(parsed) ? parsed : Date.now() + 10 * 60_000;

    return { token, expiresAtMs };
  }

  private async postJson(path: string, payload: unknown): Promise<any> {
    const response = await fetch(new URL(path, this.config.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    const body = (await response.json().catch(() => null)) as any;
    if (!response.ok) {
      throw new AuthError(
        `Login failed (HTTP ${response.status}) at ${path}. ${body?.errors?.message ?? ""}`.trim(),
        response.status,
      );
    }
    return body;
  }
}
