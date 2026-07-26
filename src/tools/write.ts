/**
 * The write path — deliberately narrow.
 *
 * One tool, gated behind FLOWPLUS_WRITE_ENABLED, that creates a *draft*
 * automation. There is no publish, no activate and no delete: an AI-authored
 * graph should not be able to reach production without a human looking at it,
 * and the engine classes some node types FinancialOrDestructive.
 *
 * Note on iteration: the server's import endpoint only ever creates. It has no
 * update-by-document counterpart, and the per-node endpoints delete one key at a
 * time, so a whole-graph replace would be a fragile N-call dance. Instead we
 * catch structural mistakes locally before spending a call, and each genuine
 * repair attempt produces a new draft. Superseded drafts are deleted by a human
 * in Studio.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { guard, ok, fail, type ToolContext } from "./common.js";
import { automationDefinitionSchema, checkStructure } from "../schema.js";
import { shapeValidation } from "./inspect.js";

const DESIGN = "/api/control-panel/automation-engine";

export function registerWriteTools(server: McpServer, { client, catalog }: ToolContext): void {
  server.registerTool(
    "flow_create_draft",
    {
      title: "Create a draft automation from a definition document",
      description:
        "Creates a new DRAFT automation from a complete definition document and returns the " +
        "server's validation report plus a link for a human to review it in Workflow Studio.\n\n" +
        "Before calling: ground your references with flow_modules / flow_forms / flow_assignees, " +
        "and fetch configSchema for each node type with flow_node_schema. Use the PascalCase " +
        "`nodeType` as each node's `type`.\n\n" +
        "This never publishes or activates anything. The flow will not run until a person " +
        "publishes it. Say so when you report back — do not claim the flow is live.\n\n" +
        "Each call creates a separate draft, so fix problems before re-submitting rather than " +
        "iterating blindly.",
      inputSchema: {
        definition: automationDefinitionSchema.describe(
          "The automation: name, triggers[], nodes[], routes[]. Matches flow_export's output shape.",
        ),
      },
    },
    guard(async ({ definition }: { definition: unknown }) => {
      if (!client.writeEnabled) {
        return fail(
          "Draft creation is disabled. flowplus-flow-mcp starts read-only; set " +
            "FLOWPLUS_WRITE_ENABLED=true in the server's environment to allow it. " +
            "You can still design the definition and show it to the user.",
        );
      }

      const parsed = automationDefinitionSchema.safeParse(definition);
      if (!parsed.success) {
        return fail(
          "The definition does not match the expected shape:\n" +
            parsed.error.issues
              .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
              .join("\n"),
        );
      }
      const document = parsed.data;

      // Structural problems are cheap to find here and expensive to debug from a
      // server error, so refuse before spending the call.
      const structural = checkStructure(document);
      if (structural.length) {
        return fail(
          "The definition is structurally inconsistent, so it was not submitted:\n" +
            structural.map((p) => `  - ${p}`).join("\n"),
        );
      }

      // Catch invented node/trigger types against the live catalog. The server
      // would reject these too, but with a far less actionable message.
      const unknown = await findUnknownTypes(catalog, document);
      if (unknown.length) {
        return fail(
          "These types do not exist on this server:\n" +
            unknown.map((u) => `  - ${u}`).join("\n") +
            "\nCall flow_catalog for the real list, and remember to use the PascalCase `nodeType`.",
        );
      }

      // The single most common authoring mistake: routing from an output the
      // source node does not declare. The server catches it, but only after a
      // round trip and without telling you what the valid options were.
      const badOutputs = await findInvalidOutputKeys(catalog, document);
      if (badOutputs.length) {
        return fail(
          "These routes leave from an output their source node does not have:\n" +
            badOutputs.map((b) => `  - ${b}`).join("\n"),
        );
      }

      const result = await client.request<any>(`${DESIGN}/automations/import`, {
        method: "POST",
        body: { definition: document },
      });

      const automationId = result?.automation?.automationId;
      const validation = shapeValidation(result?.validation);

      return ok({
        created: true,
        automationId,
        name: result?.automation?.name,
        status: result?.automation?.status,
        validation,
        unresolvedCredentialRefs: result?.unresolvedCredentialRefs ?? [],
        reviewUrl: automationId ? client.automationLink(automationId) : undefined,
        nextStep: validation?.isValid
          ? "The draft is valid. Give the user the reviewUrl so they can inspect and publish it. It is NOT running yet."
          : "The draft has validation errors. Read each issue's targetKey/fieldPath/suggestedFix, correct the definition, and submit a corrected version.",
      });
    }),
  );
}

/**
 * Cross-checks every route's sourceOutputKey against the source node type's
 * declared routeOutputKeys, and reports the valid alternatives inline so the
 * model can fix it in one step instead of guessing.
 */
async function findInvalidOutputKeys(
  catalog: ToolContext["catalog"],
  document: {
    nodes: Array<{ key: string; type: string }>;
    routes: Array<{ sourceNodeKey: string; sourceOutputKey: string; targetNodeKey: string }>;
  },
): Promise<string[]> {
  const live = await catalog.get();

  const outputsForType = new Map<string, string[]>();
  for (const descriptor of live.nodeTypes) {
    const outputs = (descriptor as { routeOutputKeys?: unknown }).routeOutputKeys;
    if (!Array.isArray(outputs)) continue;
    const list = outputs.filter((o): o is string => typeof o === "string");
    outputsForType.set(descriptor.nodeType.toLowerCase(), list);
    outputsForType.set(descriptor.key.toLowerCase(), list);
  }

  const typeOfNode = new Map(document.nodes.map((n) => [n.key, n.type]));
  const problems: string[] = [];

  for (const [index, route] of document.routes.entries()) {
    const sourceType = typeOfNode.get(route.sourceNodeKey);
    if (!sourceType) continue; // already reported by checkStructure
    const valid = outputsForType.get(sourceType.toLowerCase());
    if (!valid) continue; // catalog did not declare any; let the server decide

    if (valid.length === 0) {
      problems.push(
        `routes[${index}]: node "${route.sourceNodeKey}" (${sourceType}) is terminal and has no outputs, so nothing can route out of it`,
      );
      continue;
    }
    if (!valid.includes(route.sourceOutputKey)) {
      problems.push(
        `routes[${index}]: "${route.sourceOutputKey}" is not an output of "${route.sourceNodeKey}" (${sourceType}). Valid outputs: ${valid.join(", ")}`,
      );
    }
  }

  return problems;
}

/** Cross-checks node and trigger `type` values against the live catalog. */
async function findUnknownTypes(
  catalog: ToolContext["catalog"],
  document: { nodes: Array<{ key: string; type: string }>; triggers: Array<{ key: string; type: string }> },
): Promise<string[]> {
  const live = await catalog.get();
  const nodeTypes = new Set<string>();
  for (const n of live.nodeTypes) {
    nodeTypes.add(n.nodeType.toLowerCase());
    nodeTypes.add(n.key.toLowerCase());
  }
  const triggerTypes = new Set<string>();
  for (const t of live.triggerTypes) {
    triggerTypes.add(t.triggerType.toLowerCase());
    triggerTypes.add(t.key.toLowerCase());
  }

  const unknown: string[] = [];
  for (const node of document.nodes) {
    if (!nodeTypes.has(node.type.toLowerCase())) {
      unknown.push(`node "${node.key}" has unknown type "${node.type}"`);
    }
  }
  for (const trigger of document.triggers) {
    if (!triggerTypes.has(trigger.type.toLowerCase())) {
      unknown.push(`trigger "${trigger.key}" has unknown type "${trigger.type}"`);
    }
  }
  return unknown;
}
