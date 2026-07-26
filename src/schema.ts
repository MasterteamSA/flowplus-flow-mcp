/**
 * Zod mirror of AutomationExportDefinition (the whole-graph import document).
 *
 * Two jobs:
 *
 *  1. Fill in every JsonElement-backed field with {} when the model omits it.
 *     This is not cosmetic. On the server these land on non-nullable
 *     System.Text.Json JsonElement properties; an omitted field deserialises to
 *     ValueKind.Undefined, and the input sanitizer calls GetRawText() on it,
 *     which throws. The request dies as an unhandled HTTP 500 with no
 *     indication of which field was missing. Defaulting here turns a baffling
 *     500 into a request that simply works.
 *
 *  2. Catch structural mistakes locally — routes pointing at nodes that do not
 *     exist, duplicate keys, unreachable nodes — so the model gets a precise
 *     message instantly instead of a round trip.
 *
 * Deliberately NOT enforced here: per-node config shape. Each node type carries
 * its own configSchema from the live catalog, and the server owns that
 * validation. Duplicating it would guarantee drift.
 */

import { z } from "zod";

/** Any JSON object. Defaults to {} — see note 1 above. */
const jsonObject = z.record(z.string(), z.unknown());
const jsonObjectDefaulted = jsonObject.default({});

/** Node/trigger keys are referenced by routes, so keep them boring and stable. */
const entityKey = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9_-]+$/,
    "keys may only contain letters, numbers, underscore and hyphen (they are referenced by routes)",
  );

export const triggerSchema = z.object({
  key: entityKey,
  /** PascalCase triggerType from the catalog, e.g. ManualTrigger, ScheduleTrigger. */
  type: z.string().min(1),
  name: z.string().min(1),
  isEnabled: z.boolean().default(true),
  config: jsonObjectDefaulted,
  schema: jsonObjectDefaulted,
  authenticationPolicy: jsonObjectDefaulted,
});

export const nodeSchema = z.object({
  key: entityKey,
  /** PascalCase nodeType from the catalog, e.g. SetFields, If, HumanApproval. */
  type: z.string().min(1),
  name: z.string().min(1),
  config: jsonObjectDefaulted,
  position: z
    .object({ x: z.number(), y: z.number() })
    .default({ x: 0, y: 0 }),
  credentialRefs: jsonObjectDefaulted,
  timeoutPolicy: jsonObjectDefaulted,
  retryPolicy: jsonObjectDefaulted,
  errorPolicy: jsonObjectDefaulted,
  sideEffectPolicy: z
    .enum(["Pure", "ReadExternal", "WriteExternal", "HumanVisible", "FinancialOrDestructive"])
    .default("Pure"),
});

export const routeSchema = z.object({
  sourceNodeKey: z.string().min(1),
  /**
   * Which output of the source node this route leaves from. Must be one of the
   * source node type's `routeOutputKeys` — check flow_node_schema.
   *
   * "success" is the default because it is correct for the majority of node
   * types (24 of them), but plenty differ: `if` has true/false, `switch` has
   * case_primary/default, `human-approval` has Approved/Rejected/Returned/
   * Cancelled/Delegated/TimedOut, `loop-over-items` has loop/done/failure.
   * Note "default" is NOT a general-purpose value; only `switch` declares it.
   */
  sourceOutputKey: z.string().default("success"),
  targetNodeKey: z.string().min(1),
  condition: jsonObject.nullish(),
  routeType: z
    .enum([
      "Default",
      "Condition",
      "Error",
      "Success",
      "Failure",
      "Timeout",
      "ApprovalApproved",
      "ApprovalRejected",
      "ApprovalReturned",
      "ApprovalCancelled",
    ])
    .default("Default"),
  priority: z.number().int().default(0),
});

export const formBindingSchema = z.object({
  bindingTargetType: z.string().min(1),
  bindingTargetKey: z.string().min(1),
  formId: z.string().default(""),
  formVersionId: z.string().default(""),
  formDefinitionId: z.number().int().nullish(),
  formRevisionId: z.number().int().nullish(),
  mode: z.string().default(""),
  inputMapping: jsonObjectDefaulted,
  outputMapping: jsonObjectDefaulted,
  writesToContext: z.boolean().default(false),
  writesToItems: z.boolean().default(false),
  canSaveDraft: z.boolean().default(false),
  requiresAuthentication: z.boolean().default(true),
});

export const automationDefinitionSchema = z.object({
  automationDefinitionFormat: z.string().default("AutomationEngine"),
  schemaVersion: z.string().default("2026-05"),
  name: z.string().min(1, "the automation needs a name"),
  description: z.string().nullish(),
  projectId: z.string().nullish(),
  triggers: z.array(triggerSchema).default([]),
  nodes: z.array(nodeSchema).default([]),
  routes: z.array(routeSchema).default([]),
  formBindings: z.array(formBindingSchema).default([]),
  layout: jsonObjectDefaulted,
});

export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;

/**
 * Structural checks the server would only report after a round trip — or, in the
 * case of dangling route targets, might report far less legibly.
 * Returns human-readable problems; empty array means structurally sound.
 */
export function checkStructure(definition: AutomationDefinition): string[] {
  const problems: string[] = [];

  const nodeKeys = new Set<string>();
  for (const node of definition.nodes) {
    if (nodeKeys.has(node.key)) problems.push(`duplicate node key "${node.key}"`);
    nodeKeys.add(node.key);
  }

  const triggerKeys = new Set<string>();
  for (const trigger of definition.triggers) {
    if (triggerKeys.has(trigger.key)) problems.push(`duplicate trigger key "${trigger.key}"`);
    triggerKeys.add(trigger.key);
  }

  if (definition.nodes.length === 0) {
    problems.push("the automation has no nodes; the server requires at least one");
  }
  if (definition.triggers.length === 0) {
    problems.push("the automation has no triggers; it could never start");
  }

  for (const [index, route] of definition.routes.entries()) {
    if (!nodeKeys.has(route.sourceNodeKey)) {
      problems.push(
        `routes[${index}] leaves from "${route.sourceNodeKey}", which is not a node in this definition`,
      );
    }
    if (!nodeKeys.has(route.targetNodeKey)) {
      problems.push(
        `routes[${index}] targets "${route.targetNodeKey}", which is not a node in this definition`,
      );
    }
    if (route.sourceNodeKey === route.targetNodeKey) {
      problems.push(`routes[${index}] is a self-loop on "${route.sourceNodeKey}"`);
    }
  }

  // A trigger's startNodeKey, when given, has to resolve.
  for (const trigger of definition.triggers) {
    const start = trigger.config?.["startNodeKey"];
    if (typeof start === "string" && start && !nodeKeys.has(start)) {
      problems.push(
        `trigger "${trigger.key}" starts at "${start}", which is not a node in this definition`,
      );
    }
  }

  // Nodes nothing routes to and no trigger starts at are dead weight; warn only
  // when there is more than one node, since a single-node flow is legitimate.
  if (definition.nodes.length > 1) {
    const reachable = new Set<string>();
    for (const trigger of definition.triggers) {
      const start = trigger.config?.["startNodeKey"];
      if (typeof start === "string" && start) reachable.add(start);
    }
    for (const route of definition.routes) reachable.add(route.targetNodeKey);
    for (const node of definition.nodes) {
      if (!reachable.has(node.key)) {
        problems.push(
          `node "${node.key}" is unreachable: no route targets it and no trigger starts at it`,
        );
      }
    }
  }

  return problems;
}
