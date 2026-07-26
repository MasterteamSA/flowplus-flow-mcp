import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { guard, ok, fail, type ToolContext } from "./common.js";

export function registerCatalogTools(server: McpServer, { catalog }: ToolContext): void {
  server.registerTool(
    "flow_catalog",
    {
      title: "List available flow building blocks",
      description:
        "Start here. Returns every trigger type and node type available on this FlowPlus server, " +
        "one line each, grouped by category, plus the valid route types. Config schemas are " +
        "deliberately excluded to keep this small — once you know which blocks you need, call " +
        "flow_node_schema for just those. Optionally filter to a single category (logic, human, " +
        "AI, dataTransform, external, flowplus, timing, parallel, webhook, convertToFile, humanReview).",
      inputSchema: {
        category: z
          .string()
          .optional()
          .describe("Restrict to one category. Omit to see everything."),
      },
    },
    guard(async ({ category }: { category?: string }) => ok(await catalog.summarise(category))),
  );

  server.registerTool(
    "flow_node_schema",
    {
      title: "Get the config schema for specific node types",
      description:
        "Returns the full configSchema (JSON Schema), description and output keys for the named " +
        "node types. Call this for only the handful of node types you actually intend to use — " +
        "requesting all of them will flood your context. Accepts either the catalog `key` " +
        "(e.g. 'set-fields') or the `nodeType` (e.g. 'SetFields'). Use the outputs listed here to " +
        "pick each route's sourceOutputKey.",
      inputSchema: {
        keys: z
          .array(z.string())
          .min(1)
          .max(12)
          .describe("Node type keys or nodeTypes, e.g. ['if', 'human-approval', 'flowplus-commit']"),
      },
    },
    guard(async ({ keys }: { keys: string[] }) => {
      const { found, notFound, suggestions } = await catalog.detail(keys);
      if (!found.length) {
        return fail(
          `None of those node types exist: ${notFound.join(", ")}. ` +
            (Object.keys(suggestions).length
              ? `Did you mean: ${JSON.stringify(suggestions)}? `
              : "") +
            "Call flow_catalog to see what is available.",
        );
      }
      // Pulled out of the descriptors because this is the field authors get
      // wrong most often, and it is easy to miss inside a large payload.
      const outputs: Record<string, unknown> = {};
      for (const node of found) outputs[node.nodeType] = node["routeOutputKeys"] ?? [];

      return ok({
        nodeTypes: found,
        ...(notFound.length ? { notFound, suggestions } : {}),
        routeOutputKeys: outputs,
        reminder:
          "Use the PascalCase `nodeType` value as the node's `type`. A route's `sourceOutputKey` " +
          "must be one of the source node's routeOutputKeys shown above — most nodes use " +
          "'success'/'failure', but `if` uses true/false and approvals use Approved/Rejected/etc. " +
          "'default' is only valid on `switch`.",
      });
    }),
  );

  server.registerTool(
    "flow_trigger_schema",
    {
      title: "Get the config schema for trigger types",
      description:
        "Returns the configSchema and payloadSchema for triggers. Omit `key` for all four " +
        "(manual, webhook, form-submit, schedule). Every automation needs at least one trigger.",
      inputSchema: {
        key: z
          .string()
          .optional()
          .describe("A trigger key such as 'schedule-trigger', or omit for all."),
      },
    },
    guard(async ({ key }: { key?: string }) => {
      const triggers = await catalog.triggerDetail(key);
      if (!triggers.length) {
        return fail(`No trigger type matches "${key}". Call flow_catalog to see the four available.`);
      }
      return ok({ triggerTypes: triggers });
    }),
  );
}
