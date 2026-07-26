/**
 * Thin HTTP client over the FlowPlus automation-engine design API.
 *
 * Every FlowPlus response is an AppResponseViewModel envelope:
 *   { endpoint, status, code, message, errors, data, correlationId }
 * The payload we actually want is always `data`, so unwrap it once here rather
 * than in every tool. Errors are normalised into ApiError carrying the
 * correlationId, which is what you grep the server log for.
 */

import type { Config } from "./config.js";
import { TokenProvider } from "./auth.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export class FlowPlusClient {
  private readonly tokens: TokenProvider;

  constructor(private readonly config: Config) {
    this.tokens = new TokenProvider(config);
  }

  get studioUrl(): string {
    return this.config.studioUrl;
  }

  get writeEnabled(): boolean {
    return this.config.writeEnabled;
  }

  /**
   * Deep link a human can open to review what the model built. The /builder
   * suffix matters — without it Studio bounces back to the automation list.
   */
  automationLink(automationId: number | string): string {
    return `${this.config.studioUrl}/control-panel/workflow/${automationId}/builder`;
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    // One retry, and only for 401: the token may simply have aged out.
    try {
      return await this.send<T>(path, options);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.tokens.invalidate();
        return this.send<T>(path, options);
      }
      throw error;
    }
  }

  private async send<T>(path: string, options: RequestOptions): Promise<T> {
    const url = new URL(path, this.config.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.tokens.getToken()}`,
      Accept: "application/json",
    };
    if (this.config.tenantId) headers["X-Tenant-Id"] = this.config.tenantId;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });

    const envelope = (await response.json().catch(() => null)) as any;

    if (!response.ok) {
      throw new ApiError(
        this.describeFailure(response.status, path, envelope),
        response.status,
        envelope?.errors?.code,
        envelope?.correlationId,
      );
    }

    return (envelope?.data ?? null) as T;
  }

  private describeFailure(status: number, path: string, envelope: any): string {
    const detail = envelope?.errors?.message ?? envelope?.message ?? "no detail";
    const correlation = envelope?.correlationId ? ` correlationId=${envelope.correlationId}` : "";

    if (status === 403 && envelope?.errors?.code === "AUTH_002") {
      return `${path}: the API rejected the token as a session token. This is an internal bug in flowplus-flow-mcp's token exchange, not a credentials problem.`;
    }
    if (status === 503) {
      return `${path}: the Automation Engine is disabled by configuration on this server (HTTP 503). Enable it before building flows.`;
    }
    if (status === 500) {
      return (
        `${path}: the server returned HTTP 500 (${detail}).${correlation} ` +
        `A common cause when importing is an omitted JSON field on a trigger or node — ` +
        `the server's input sanitizer throws on absent JsonElement properties rather than reporting a validation error. ` +
        `Ensure schema, authenticationPolicy, config, position, credentialRefs, timeoutPolicy, retryPolicy and errorPolicy are all present (use {} for empty).`
      );
    }
    return `${path}: HTTP ${status} (${detail}).${correlation}`;
  }
}
