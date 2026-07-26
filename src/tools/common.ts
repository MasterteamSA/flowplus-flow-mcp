import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FlowPlusClient } from "../client.js";
import type { CatalogService } from "../catalog.js";
import { ApiError } from "../client.js";
import { AuthError } from "../auth.js";

export interface ToolContext {
  client: FlowPlusClient;
  catalog: CatalogService;
}

export type ToolRegistrar = (server: McpServer, context: ToolContext) => void;

/** Index signature is required by the SDK's CallToolResult shape. */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function ok(payload: unknown): ToolResult {
  return {
    content: [
      { type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) },
    ],
  };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Wraps a handler so transport-level failures come back as readable tool errors
 * rather than crashing the server. ApiError already carries a shaped message and
 * the correlationId needed to find the entry in the server log.
 */
export function guard<A>(handler: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof ApiError || error instanceof AuthError) {
        return fail(error.message);
      }
      if (error instanceof Error && error.name === "TimeoutError") {
        return fail("The FlowPlus API did not respond in time. Is the backend running?");
      }
      return fail(`Unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
