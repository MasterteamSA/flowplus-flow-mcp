#!/usr/bin/env node
/**
 * flowplus-flow-mcp — build FlowPlus automation flows from natural language.
 *
 * A stdio MCP server that projects the FlowPlus automation-engine design API as
 * typed tools. It holds no flow logic of its own: the server owns the vocabulary
 * (via builder/catalog) and the validation rules, and this process just makes
 * them reachable from an AI client without flooding its context.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { FlowPlusClient } from "./client.js";
import { CatalogService } from "./catalog.js";
import type { ToolContext } from "./tools/common.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerInspectTools } from "./tools/inspect.js";
import { registerGroundingTools } from "./tools/grounding.js";
import { registerWriteTools } from "./tools/write.js";
import { registerInlineFormTools } from "./tools/inlineForms.js";

const BUILD_GUIDANCE = `You are building a FlowPlus automation flow. Work in this order.

1. UNDERSTAND. Restate the flow as a trigger plus an ordered set of steps. If the
   trigger is ambiguous (manual, webhook, form submission, schedule?) ask before building.

2. GROUND FIRST, before choosing any node types. Anything the flow references must
   be real: flow_modules and flow_module_schema for data modules, flow_forms and
   flow_form_schema for forms, flow_assignees for anyone a human step routes to,
   flow_connectors for external services. Never invent a module key, field name or
   assignee — a flow that references something fictional is worse than no flow,
   because it looks correct.

3. CHOOSE BLOCKS. flow_catalog for the shortlist, then flow_node_schema for only
   the handful you picked. Do not request every node type; you will exhaust your
   context before writing anything.

4. COMPOSE the definition document:
   - Each node's \`type\` is the PascalCase \`nodeType\` from the catalog, not the key.
   - Every node needs a unique \`key\`; routes reference nodes by that key.
   - A route's \`sourceOutputKey\` must be an output the source node actually has.
     Most have success/failure; \`if\` has true/false; approvals have
     Approved/Rejected/Returned/Cancelled/Delegated/TimedOut. "default" is only
     valid on \`switch\`.
   - ParallelStart is special: it DECLARES branch_a/branch_b but its real outputs
     are whatever you put in \`config.branches[].key\`. Configure four branches and
     route on those four keys. You are not limited to two.
   - Give the trigger a \`startNodeKey\` pointing at the first node.
   - Set \`position\` per node so the graph is readable in Studio: roughly x 320,
     y increasing by ~160 per step.
   - If unsure of the shape, flow_export an existing automation and copy its structure.

5. REWORK LOOPS — the graph may not contain cycles. A process chart that loops
   ("rejected goes back to recalculation") cannot be built as a back-edge; the
   engine refuses it. Unroll it forward instead, using the approval's \`Returned\`
   output, which exists precisely for send-back:

     calc -> approve1 --Approved--> commit
                       --Returned--> fix -> approve2 --Approved--> commit
                       --Rejected--> stop

   Forward edges may converge on a shared node; they just may not loop back.
   Rework depth is therefore fixed when you design it: two passes means two
   approval nodes. If the process needs unbounded rework, end the run on
   \`Returned\` and let a corrected re-run start a fresh execution — and tell the
   user that is what you did, since it changes the audit shape.

   Do NOT reach for LoopOverItems here. It snapshots a collection once and runs
   its body once per item, and its body must return to the loop node itself. It
   iterates known collections; it cannot express conditional retry.

6. HUMAN STEPS that collect data need a form. \`config.formSource\` takes:
     ReuseTriggerForm   - the flow is form-triggered and you want the same fields
     InlineDraft        - build one with flow_create_inline_form (create the
                          automation first, then attach the form to the node,
                          then set the ids in config and resubmit)
     ExistingPublished  - bind a published form from flow_forms
   A HumanTask with none of these will not validate. Do not silently downgrade a
   data-collecting step to a decide-only HumanApproval — that quietly drops a
   requirement.

7. CREATE with flow_create_draft, then read the validation report. Each issue names
   the node (targetKey), the field (fieldPath/configPath) and a suggestedFix. Repair
   precisely. After about three attempts, stop and report what remains rather than
   guessing.

8. REPORT. Give the user the reviewUrl and state plainly that the flow is a DRAFT
   and is not running. This server cannot publish or activate — that is deliberate,
   and a human does it in Studio. Never imply the flow is live.`;

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new FlowPlusClient(config);
  const context: ToolContext = { client, catalog: new CatalogService(client) };

  const server = new McpServer(
    { name: "flowplus-flow-mcp", version: "0.1.0" },
    {
      instructions:
        "Tools for designing FlowPlus automation flows from a natural-language description. " +
        "Ground every reference against the server before composing a flow, and remember that " +
        "created flows are drafts that a human must publish. " +
        (config.writeEnabled
          ? "Draft creation is ENABLED."
          : "Draft creation is DISABLED (read-only); set FLOWPLUS_WRITE_ENABLED=true to allow it."),
    },
  );

  registerCatalogTools(server, context);
  registerInspectTools(server, context);
  registerGroundingTools(server, context);
  registerWriteTools(server, context);
  registerInlineFormTools(server, context);

  // Clients that do not read skill files still get the build loop through this.
  server.registerPrompt(
    "build_a_flow",
    {
      title: "Build a FlowPlus flow from a description",
      description: "The end-to-end procedure for turning a description into a validated draft flow.",
    },
    () => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: BUILD_GUIDANCE } }],
    }),
  );

  await server.connect(new StdioServerTransport());
  // stdout is the transport; anything human-readable has to go to stderr.
  console.error(
    `flowplus-flow-mcp ready against ${config.baseUrl} ` +
      `(app=${config.appCode}, writes=${config.writeEnabled ? "enabled" : "disabled"})`,
  );
}

main().catch((error: unknown) => {
  console.error(`flowplus-flow-mcp failed to start: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
