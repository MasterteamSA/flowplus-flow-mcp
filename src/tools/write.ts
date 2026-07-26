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
      // The local checks run BEFORE the write gate on purpose. A read-only
      // session is still designing a definition, and telling it "writes are
      // off" while silently sitting on the knowledge that its AI inputs are
      // malformed wastes the whole session. Refuse to create, but always say
      // what is wrong with what you were handed.
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
      const outputWarnings = [
        ...(await checkOutputKeys(catalog, document)),
        ...checkConfigShapes(document),
        ...checkDuplicateRoutes(document),
        ...checkExpressionNamespaces(document),
        ...(await checkNodeAvailability(catalog, document)),
      ];

      if (!client.writeEnabled) {
        return fail(
          "Draft creation is disabled. flowplus-flow-mcp starts read-only; set " +
            "FLOWPLUS_WRITE_ENABLED=true in the server's environment to allow it. " +
            "You can still design the definition and show it to the user.\n\n" +
            (outputWarnings.length
              ? "The definition passed the structural checks, but these would need attention " +
                "before it validates:\n" +
                outputWarnings.map((w) => `  - ${w}`).join("\n")
              : "The definition passed every local check, so it is ready to submit once writes " +
                "are enabled."),
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

    // Config can widen the outputs (ParallelStart's branches) or narrow them
    // (an approval's allowedDecisions). Narrowing is checked first because the
    // declared list is then actively misleading: HumanApproval declares six
    // decisions, but a node allowing only Approved/Rejected has exactly two
    // plus TimedOut, and routing from Cancelled fails with no explanation.
    const narrowed = narrowedOutputKeys(source.config);
    const effective = new Set(narrowed ?? declared);
    if (!narrowed) {
      for (const configured of configuredOutputKeys(source.config)) effective.add(configured);
    }

    if (effective.size === 0 || effective.has(route.sourceOutputKey)) continue;

    warnings.push(
      `routes[${index}]: "${route.sourceOutputKey}" is not among the known outputs of ` +
        `"${route.sourceNodeKey}" (${source.type}) — expected one of ${[...effective].join(", ")}` +
        (narrowed ? ` (narrowed by this node's allowedDecisions)` : "") +
        `. Submitted anyway; the server will reject it if genuinely wrong.`,
    );
  }

  return warnings;
}

/**
 * Output keys a node's own config *restricts* it to. `allowedDecisions` on the
 * human nodes is the case: listing three decisions means the other three
 * outputs do not exist on that node, whatever the catalog declares. TimedOut is
 * always present because a timeout is not a decision anyone makes.
 *
 * Returns undefined when the config imposes no restriction.
 */
function narrowedOutputKeys(config: Record<string, unknown>): string[] | undefined {
  const allowed = config["allowedDecisions"];
  if (!Array.isArray(allowed) || allowed.length === 0) return undefined;
  const decisions = allowed.filter((d): d is string => typeof d === "string");
  if (!decisions.length) return undefined;
  return [...new Set([...decisions, "TimedOut"])];
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

/**
 * Config shapes the server rejects with a message that does not say what the
 * right shape is. Each of these cost a full round trip and a dead draft to
 * discover, so they are worth catching here.
 */
function checkConfigShapes(document: {
  nodes: Array<{ key: string; type: string; config: Record<string, unknown> }>;
}): string[] {
  const warnings: string[] = [];

  for (const node of document.nodes) {
    // AI node `inputs` are typed declarations, not bare expressions. Writing
    // { customer: "={{ ... }}" } yields "input 'customer' must be a JSON object"
    // with no hint that the value should be { type, source }.
    if (node.type.startsWith("Ai") || node.type === "SpecializedAi") {
      const inputs = node.config["inputs"];
      if (inputs && typeof inputs === "object" && !Array.isArray(inputs)) {
        for (const [name, value] of Object.entries(inputs as Record<string, unknown>)) {
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            warnings.push(
              `nodes["${node.key}"].config.inputs.${name} is a ${typeof value}, but AI inputs are ` +
                `typed declarations. Use { "type": "object", "source": "={{ ... }}" } — ` +
                `type is one of string, number, boolean, date, object, array, enum, file.`,
            );
          } else if (!("type" in (value as Record<string, unknown>))) {
            warnings.push(
              `nodes["${node.key}"].config.inputs.${name} is missing the required "type" field ` +
                `(string, number, boolean, date, object, array, enum, file).`,
            );
          }
        }
      }
    }

    // ConvertToFile's actionKey is the bare format, not the catalog key. The
    // catalog lists 'convert-to-file-xlsx' as the key you look up, but the
    // config wants 'xlsx' — an easy and silent-looking mismatch.
    if (node.type === "ConvertToFile") {
      const actionKey = node.config["actionKey"];
      if (typeof actionKey === "string" && actionKey.startsWith("convert-to-file-")) {
        warnings.push(
          `nodes["${node.key}"].config.actionKey is "${actionKey}", but ConvertToFile wants the ` +
            `bare format: "${actionKey.replace("convert-to-file-", "")}". The catalog key and the ` +
            `actionKey value are different strings.`,
        );
      }
    }
  }

  return warnings;
}

/**
 * Two routes may not leave the same output of the same node — the server
 * reports it as "duplicate Success priority 0", which does not obviously mean
 * "you forked where you should have sequenced".
 */
function checkDuplicateRoutes(document: {
  routes: Array<{ sourceNodeKey: string; sourceOutputKey: string; targetNodeKey: string }>;
}): string[] {
  const seen = new Map<string, string>();
  const warnings: string[] = [];

  for (const route of document.routes) {
    const signature = `${route.sourceNodeKey}::${route.sourceOutputKey}`;
    const existing = seen.get(signature);
    if (existing) {
      warnings.push(
        `Two routes leave "${route.sourceNodeKey}" output "${route.sourceOutputKey}" ` +
          `(to "${existing}" and "${route.targetNodeKey}"). The engine rejects this as a duplicate ` +
          `priority. Sequence the steps, or fan out with ParallelStart.`,
      );
    } else {
      seen.set(signature, route.targetNodeKey);
    }
  }

  return warnings;
}

/**
 * Expression roots the revision snapshot refuses. Deliberately a deny-list of
 * roots confirmed to fail rather than an allow-list: the full accepted set is
 * not published anywhere, and a wrong allow-list would flag valid expressions.
 * `$now` and `$trigger` both read as obvious and are both refused, with an
 * error that names the expression but not the reason.
 */
const REFUSED_ROOTS: Array<{ token: string; instead: string }> = [
  { token: "$now", instead: "let the node stamp its own timestamp, or pass one in from the trigger payload" },
  { token: "$trigger", instead: "read trigger values through the first node that consumes them" },
];

function checkExpressionNamespaces(document: Record<string, unknown>): string[] {
  const expressions = JSON.stringify(document).match(/=\{\{[^}]*\}\}/g) ?? [];
  const flagged = new Map<string, string>();

  for (const expression of expressions) {
    for (const { token, instead } of REFUSED_ROOTS) {
      if (expression.includes(token)) flagged.set(expression, instead);
    }
  }

  return [...flagged].map(
    ([expression, instead]) =>
      `Expression ${expression} uses a root the revision snapshot refuses ` +
      `("unsupported expression namespace"). Instead: ${instead}. Confirmed-good root: $nodes.<key>.output.`,
  );
}

/**
 * A node type the tenant has switched off validates as a CONFIGURATION_ERROR at
 * import time, after the whole graph has been authored around it. The catalog
 * carries isAvailable/unavailableReason, so say it up front.
 */
async function checkNodeAvailability(
  catalog: ToolContext["catalog"],
  document: { nodes: Array<{ key: string; type: string }> },
): Promise<string[]> {
  const live = await catalog.get();
  const byType = new Map<string, NodeAvailability>();

  for (const descriptor of live.nodeTypes) {
    const entry: NodeAvailability = {
      isAvailable: descriptor["isAvailable"] as boolean | undefined,
      reason: descriptor["unavailableReason"] as string | undefined,
    };
    byType.set(descriptor.nodeType.toLowerCase(), entry);
    byType.set(descriptor.key.toLowerCase(), entry);
  }

  const reported = new Set<string>();
  const warnings: string[] = [];

  for (const node of document.nodes) {
    const availability = byType.get(node.type.toLowerCase());
    if (!availability || availability.isAvailable !== false) continue;
    if (reported.has(node.type)) continue;
    reported.add(node.type);
    warnings.push(
      `Node type "${node.type}" is not available on this server` +
        (availability.reason ? `: ${availability.reason}` : "") +
        `. Nodes of this type will fail validation until it is enabled.`,
    );
  }

  return warnings;
}

interface NodeAvailability {
  isAvailable?: boolean;
  reason?: string;
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
