import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { guard, ok, type ToolContext } from "./common.js";

const DESIGN = "/api/control-panel/automation-engine";

/**
 * Validation issues are returned verbatim rather than summarised into prose.
 * Each one carries targetKey, fieldPath, configPath and suggestedFix — that
 * detail is exactly what lets a model repair the right field, and paraphrasing
 * it away is how a repair loop turns into guesswork.
 */
function shapeValidation(report: any) {
  if (!report) return null;
  return {
    isValid: report.isValid,
    canPublish: report.canPublish,
    errorCount: (report.errors ?? []).length,
    warningCount: (report.warnings ?? []).length,
    errors: report.errors ?? [],
    warnings: report.warnings ?? [],
    publishBlockers: report.publishBlockers ?? [],
  };
}

export { shapeValidation };

export function registerInspectTools(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "flow_list",
    {
      title: "List automations",
      description:
        "Lists automations on this server with their id, name and status. Use it to find an " +
        "existing flow before modifying one, or to check what was just created.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(25).describe("How many to return."),
        search: z.string().optional().describe("Filter by name."),
      },
    },
    guard(async ({ limit, search }: { limit: number; search?: string }) =>
      ok(await client.request(`${DESIGN}/automations`, { query: { limit, search } })),
    ),
  );

  server.registerTool(
    "flow_get",
    {
      title: "Get one automation's summary",
      description:
        "Returns status, owner, revisions and timestamps for a single automation. For the full " +
        "graph use flow_export instead.",
      inputSchema: { automationId: z.number().int().describe("The automation id.") },
    },
    guard(async ({ automationId }: { automationId: number }) =>
      ok(await client.request(`${DESIGN}/automations/${automationId}`)),
    ),
  );

  server.registerTool(
    "flow_export",
    {
      title: "Export an automation as a definition document",
      description:
        "Returns the complete automation as the same JSON document shape that flow_create_draft " +
        "accepts. Two uses: inspecting an existing flow before changing it, and — more valuable — " +
        "reading a working flow as a concrete example of the document format before you author one.",
      inputSchema: { automationId: z.number().int().describe("The automation id.") },
    },
    guard(async ({ automationId }: { automationId: number }) =>
      ok(await client.request(`${DESIGN}/automations/${automationId}/export`)),
    ),
  );

  server.registerTool(
    "flow_validate",
    {
      title: "Validate an automation",
      description:
        "Runs server-side validation and returns structured issues. Each issue names the offending " +
        "node (targetKey), the field (fieldPath / configPath) and a suggestedFix. Use these to " +
        "repair the definition and re-submit with flow_update_draft. If issues persist after about " +
        "three attempts, stop and report them rather than continuing to guess.",
      inputSchema: { automationId: z.number().int().describe("The automation id.") },
    },
    guard(async ({ automationId }: { automationId: number }) => {
      const report = await client.request<any>(`${DESIGN}/automations/${automationId}/validate`, {
        method: "POST",
        body: {},
      });
      return ok({
        automationId,
        ...shapeValidation(report),
        reviewUrl: client.automationLink(automationId),
      });
    }),
  );
}
