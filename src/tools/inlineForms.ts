/**
 * Inline forms.
 *
 * A HumanTask needs a form to collect data, and the engine offers three ways to
 * supply one via `config.formSource`:
 *
 *   ExistingPublished  bind a form already published in the tenant
 *   ReuseTriggerForm   reuse the form that started the run (form-triggered flows)
 *   InlineDraft        build a form inside the node itself  <- these tools
 *
 * The first version of this server exposed none of this, so a model with no
 * published forms in the tenant had no way to build a data-collecting step and
 * silently downgraded every human step to a decide-only HumanApproval. That
 * looked like an engine limitation and was not one.
 *
 * Inline forms attach to an automation that already exists, so the order is:
 * create the draft first, then add the form to the named node, then point that
 * node's config at the returned ids.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { guard, ok, fail, type ToolContext } from "./common.js";

const DESIGN = "/api/control-panel/automation-engine";

/** Server takes these snapshots as JSON *strings*, not objects. */
const fieldsSchema = z
  .array(
    z.object({
      key: z.string().min(1).describe("Field key, referenced by mappings."),
      label: z.string().min(1),
      type: z
        .string()
        .default("text")
        .describe("Field type, e.g. text, number, date, select, checkbox, textarea."),
      required: z.boolean().default(false),
      options: z.array(z.string()).optional().describe("For select-style fields."),
      defaultValue: z.string().optional().describe("May be an expression referencing earlier steps."),
    }),
  )
  .min(1);

export function registerInlineFormTools(server: McpServer, { client }: ToolContext): void {
  server.registerTool(
    "flow_create_inline_form",
    {
      title: "Build a form inside a human step",
      description:
        "Creates an inline form draft attached to a node of an existing automation — the way to " +
        "make a HumanTask collect data when the tenant has no published forms.\n\n" +
        "Order matters: create the automation with flow_create_draft first, then call this with " +
        "its automationId and the node's key. Field defaultValue may reference earlier steps, so " +
        "a correction form can be pre-filled with the values under dispute.\n\n" +
        "Afterwards set the node's config to formSource='InlineDraft' with the returned " +
        "formDefinitionId and inlineDraftRevisionId, and resubmit the definition.\n\n" +
        "If the flow is started by a form submission and the human step needs the same fields, " +
        "prefer formSource='ReuseTriggerForm' — no inline form needed.",
      inputSchema: {
        automationId: z.number().int().describe("Automation the node belongs to."),
        nodeKey: z.string().min(1).describe("Key of the HumanTask node this form is for."),
        key: z.string().min(1).describe("Stable identifier for the form, e.g. 'exception_notes'."),
        displayName: z.string().min(1).describe("Shown to the person completing it."),
        description: z.string().optional(),
        fields: fieldsSchema.describe("The fields to collect."),
      },
    },
    guard(
      async (args: {
        automationId: number;
        nodeKey: string;
        key: string;
        displayName: string;
        description?: string;
        fields: Array<z.infer<typeof fieldsSchema>[number]>;
      }) => {
        if (!client.writeEnabled) {
          return fail(
            "Inline form creation is disabled. Set FLOWPLUS_WRITE_ENABLED=true to allow it.",
          );
        }

        const result = await client.request<any>(
          `${DESIGN}/automations/${args.automationId}/inline-forms`,
          {
            method: "POST",
            body: {
              nodeKey: args.nodeKey,
              key: args.key,
              displayName: args.displayName,
              description: args.description ?? null,
              purpose: "Custom",
              // These are strings on the wire, not nested objects.
              schemaSnapshotJson: JSON.stringify({ fields: args.fields }),
              layoutSnapshotJson: JSON.stringify({
                sections: [{ key: "main", title: args.displayName, fields: args.fields.map((f) => f.key) }],
              }),
              fieldBindingSnapshotJson: JSON.stringify({ bindings: [] }),
              validationRulesSnapshotJson: "[]",
              visibilityRulesSnapshotJson: "[]",
            },
          },
        );

        return ok({
          created: true,
          ...result,
          nextStep:
            "Set the node's config to formSource='InlineDraft' with the formDefinitionId and " +
            "inlineDraftRevisionId above, then resubmit the definition with flow_create_draft.",
        });
      },
    ),
  );

  server.registerTool(
    "flow_validate_inline_form",
    {
      title: "Validate an inline form draft",
      description:
        "Checks an inline form draft before wiring it into a node, so a malformed form surfaces " +
        "as a form error rather than an opaque node validation failure.",
      inputSchema: {
        automationId: z.number().int(),
        formDefinitionId: z.number().int(),
        revisionId: z.number().int(),
      },
    },
    guard(async (a: { automationId: number; formDefinitionId: number; revisionId: number }) =>
      ok(
        await client.request(
          `${DESIGN}/automations/${a.automationId}/inline-forms/${a.formDefinitionId}/drafts/${a.revisionId}/validate`,
          { method: "POST", body: {} },
        ),
      ),
    ),
  );
}
