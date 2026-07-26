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

      // Routing from an output the source node does not declare is the most
      // common authoring mistake — but this is only ever a HINT, never a block.
      // `routeOutputKeys` is a default declaration, not an exhaustive list:
      // ParallelStart derives its real outputs from config.branches[].key, so a
      // four-branch fan-out routes on b1..b4 and is perfectly valid. An earlier
      // version of this check refused exactly that. The server is the authority.
      const outputWarnings = await checkOutputKeys(catalog, document);

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
        ...(outputWarnings.length ? { clientWarnings: outputWarnings } : {}),
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
 * Advisory check on route output keys.
 *
 * Returns warnings, never blocks. `routeOutputKeys` in the catalog is a DEFAULT
 * declaration, not a closed set — some node types derive their real outputs from
 * their own config. ParallelStart is the clear case: it declares
 * ["branch_a","branch_b"] but a flow configuring four branches routes on those
 * four branch keys and validates fine. Treating the declaration as exhaustive
 * meant refusing valid flows, which is worse than letting the server decide.
 */
async function checkOutputKeys(
  catalog: ToolContext["catalog"],
  document: {
    nodes: Array<{ key: string; type: string; config: Record<string, unknown> }>;
    routes: Array<{ sourceNodeKey: string; sourceOutputKey: string; targetNodeKey: string }>;
  },
): Promise<string[]> {
  const live = await catalog.get();

  const declaredForType = new Map<string, string[]>();
  for (const descriptor of live.nodeTypes) {
    const outputs = (descriptor as { routeOutputKeys?: unknown }).routeOutputKeys;
    if (!Array.isArray(outputs)) continue;
    const list = outputs.filter((o): o is string => typeof o === "string");
    declaredForType.set(descriptor.nodeType.toLowerCase(), list);
    declaredForType.set(descriptor.key.toLowerCase(), list);
  }

  const nodesByKey = new Map(document.nodes.map((n) => [n.key, n]));
  const warnings: string[] = [];

  for (const [index, route] of document.routes.entries()) {
    const source = nodesByKey.get(route.sourceNodeKey);
    if (!source) continue; // checkStructure already reported this

    const declared = declaredForType.get(source.type.toLowerCase());
    if (!declared) continue;

    // Union the declared outputs with any the node's own config defines.
    const effective = new Set(declared);
    for (const configured of configuredOutputKeys(source.config)) effective.add(configured);

    if (effective.size === 0 || effective.has(route.sourceOutputKey)) continue;

    warnings.push(
      `routes[${index}]: "${route.sourceOutputKey}" is not among the known outputs of ` +
        `"${route.sourceNodeKey}" (${source.type}) — expected one of ${[...effective].join(", ")}. ` +
        `Submitted anyway; the server will reject it if genuinely wrong.`,
    );
  }

  return warnings;
}

/**
 * Output keys a node's own config contributes. Currently that means
 * ParallelStart's `branches[].key`; the shape check is deliberately loose so
 * other config-driven node types are picked up without a code change here.
 */
function configuredOutputKeys(config: Record<string, unknown>): string[] {
  const branches = config["branches"];
  if (!Array.isArray(branches)) return [];
  return branches
    .map((b) => (b && typeof b === "object" ? (b as Record<string, unknown>)["key"] : undefined))
    .filter((k): k is string => typeof k === "string" && k.length > 0);
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
