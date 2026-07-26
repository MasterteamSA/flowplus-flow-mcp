/**
 * Grounding tools.
 *
 * These matter as much as the write path. Without them a model will happily
 * invent a module named "Expenses", assign a task to "the finance manager", and
 * produce a flow that is syntactically perfect and completely fictional. These
 * endpoints return what actually exists on this server, so the generated flow
 * references real modules, real forms and real people.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { guard, ok, type ToolContext } from "./common.js";

const DESIGN = "/api/control-panel/automation-engine";

export function registerGroundingTools(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "flow_modules",
    {
      title: "List FlowPlus data modules",
      description:
        "Lists the data modules a flow can read from or write to with a flowplus-commit node. " +
        "Call this before referencing any module — never guess a module key.",
      inputSchema: {},
    },
    guard(async () => ok(await client.request(`${DESIGN}/builder/flowplus/modules`))),
  );

  server.registerTool(
    "flow_module_schema",
    {
      title: "Get a module's field schema",
      description:
        "Returns the fields of one data module, so a flowplus-commit node writes real field names " +
        "with the right types.",
      inputSchema: { moduleKey: z.string().describe("Module key from flow_modules.") },
    },
    guard(async ({ moduleKey }: { moduleKey: string }) =>
      ok(
        await client.request(
          `${DESIGN}/builder/flowplus/modules/${encodeURIComponent(moduleKey)}/schema`,
        ),
      ),
    ),
  );

  server.registerTool(
    "flow_forms",
    {
      title: "List forms",
      description:
        "Lists forms available for form-submit triggers and form bindings on human steps.",
      inputSchema: {},
    },
    guard(async () => ok(await client.request(`${DESIGN}/builder/forms`))),
  );

  server.registerTool(
    "flow_form_schema",
    {
      title: "Get a form's field schema",
      description:
        "Returns the fields of a form version, so input and output mappings reference real fields. " +
        "Omit formVersionId for the latest version.",
      inputSchema: {
        formId: z.string().describe("Form id from flow_forms."),
        formVersionId: z.string().optional().describe("Specific version, or omit for latest."),
      },
    },
    guard(async ({ formId, formVersionId }: { formId: string; formVersionId?: string }) => {
      const id = encodeURIComponent(formId);
      const path = formVersionId
        ? `${DESIGN}/builder/forms/${id}/versions/${encodeURIComponent(formVersionId)}/schema`
        : `${DESIGN}/builder/forms/${id}/versions/latest`;
      return ok(await client.request(path));
    }),
  );

  server.registerTool(
    "flow_assignees",
    {
      title: "List assignment options for human steps",
      description:
        "Lists the users, groups and roles a human-approval, human-task or human-interaction node " +
        "can be assigned to. Always call this before configuring a human step — an invented " +
        "assignee fails validation at best and silently misroutes work at worst.",
      inputSchema: {
        search: z.string().optional().describe("Filter by name."),
      },
    },
    guard(async ({ search }: { search?: string }) =>
      ok(await client.request(`${DESIGN}/builder/assignments/options`, { query: { search } })),
    ),
  );

  server.registerTool(
    "flow_schedule_preview",
    {
      title: "Validate a schedule and preview its next runs",
      description:
        "Checks a schedule-trigger configuration and returns the next fire time. Use it to confirm " +
        "'every Monday at 9am' became the cron you intended before committing it to a flow — the " +
        "response includes nextFireAtUtc, which is the cheapest way to catch an off-by-one-day cron.",
      inputSchema: {
        config: z
          .record(z.string(), z.unknown())
          .describe(
            "Schedule config matching the schedule-trigger configSchema, " +
              'e.g. { "scheduleType": "Cron", "cron": "0 9 * * 1", "timeZone": "UTC" }',
          ),
      },
    },
    // The server expects the config NESTED under a `config` property
    // (SchedulePreviewRequest.Config). Posting the config at the top level makes
    // Config deserialise to an Undefined JsonElement and the request dies as an
    // unhandled 500 — which reads convincingly like a broken endpoint. It is not.
    guard(async ({ config }: { config: Record<string, unknown> }) =>
      ok(
        await client.request(`${DESIGN}/builder/schedules/next-fire-preview`, {
          method: "POST",
          body: { config },
        }),
      ),
    ),
  );

  server.registerTool(
    "flow_connectors",
    {
      title: "List available connectors",
      description:
        "Lists external connectors (Slack, Gmail, Teams and so on) and whether credentials are " +
        "configured. A connector node without a working credential will not validate.",
      inputSchema: {
        includeUnavailable: z
          .boolean()
          .default(false)
          .describe("Include connectors with no credentials configured."),
      },
    },
    guard(async ({ includeUnavailable }: { includeUnavailable: boolean }) =>
      ok(await client.request(`${DESIGN}/builder/connectors`, { query: { includeUnavailable } })),
    ),
  );
}
