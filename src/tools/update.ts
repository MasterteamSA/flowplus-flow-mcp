/**
 * flow_update_draft — revise an existing draft in place.
 *
 * The import endpoint only creates, but the design API is fully key-addressed
 * underneath: PUT nodes/{key} and triggers/{key} upsert, routes are updated or
 * deleted by routeId, and validate runs against the same automation. So a
 * whole-document update is a diff-and-apply: fetch the current export, compare
 * against the new definition, and issue only the calls that change something.
 *
 * Ordering matters and is fixed:
 *   metadata → node upserts → trigger upserts → route deletes → route updates
 *   → route creates → node deletes → trigger deletes
 * Nodes go in before the routes that reference them; routes touching a removed
 * node are (by the structural check) always in the delete set, so they are gone
 * before the node is. On a mid-sequence failure the draft is left partially
 * updated — the result says exactly which calls were applied and which were
 * not, and the closing validate reflects the draft's real state either way.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { guard, ok, fail, type ToolContext } from "./common.js";
import type { AutomationDefinition } from "../schema.js";
import { shapeValidation } from "./inspect.js";
import { preflightDefinition } from "./write.js";

const DESIGN = "/api/control-panel/automation-engine";

type Definition = AutomationDefinition;
type DefTrigger = Definition["triggers"][number];
type DefNode = Definition["nodes"][number];
type DefRoute = Definition["routes"][number];

interface ExistingRoute {
  routeId: number;
  sourceNodeKey: string;
  sourceOutputKey: string;
  targetNodeKey: string;
  condition?: unknown;
  routeType?: string;
  priority?: number;
}

interface PlannedCall {
  label: string;
  run: () => Promise<unknown>;
}

export function registerUpdateTools(server: McpServer, { client, catalog }: ToolContext): void {
  server.registerTool(
    "flow_update_draft",
    {
      title: "Update an existing draft automation in place",
      description:
        "Applies a complete definition document to an EXISTING automation, keeping its id. " +
        "Use this for the repair loop: flow_create_draft once, then fix validation issues " +
        "here instead of minting a new draft per attempt.\n\n" +
        "The definition is authoritative for the whole graph: nodes, triggers and routes " +
        "not present in it are DELETED from the draft. Start from flow_export of the same " +
        "automation if you only mean to change part of it.\n\n" +
        "Returns the fresh validation report and the Studio review link. Never publishes.",
      inputSchema: {
        automationId: z
          .number()
          .int()
          .positive()
          .describe("The automation to update — the id flow_create_draft or flow_list returned."),
        definition: z
          .unknown()
          .describe(
            "The complete definition document (same shape as flow_create_draft / flow_export). " +
              "It replaces the automation's whole graph.",
          ),
      },
    },
    guard(async ({ automationId, definition }: { automationId: number; definition: unknown }) => {
      const flight = await preflightDefinition(catalog, definition);
      if (flight.error) return flight.error;
      const document = flight.document;

      if (!client.writeEnabled) {
        return fail(
          "Draft updates are disabled. flowplus-flow-mcp starts read-only; set " +
            "FLOWPLUS_WRITE_ENABLED=true in the server's environment to allow it.",
        );
      }

      // Current state: the export is the canonical diff base (same shapes as
      // the definition — round-tripping is lossless), the detail supplies the
      // route ids that deletes and updates need.
      const current = await client.request<any>(
        `${DESIGN}/automations/${automationId}/export`,
        { method: "GET" },
      );
      const detail = await client.request<any>(`${DESIGN}/automations/${automationId}`, {
        method: "GET",
      });

      const currentDef = (current?.definition ?? current) as Record<string, any>;
      const existingRoutes: ExistingRoute[] = (detail?.routes ?? [])
        .filter((r: any) => r && typeof r.routeId === "number")
        .map((r: any) => ({
          routeId: r.routeId,
          sourceNodeKey: String(r.sourceNodeKey ?? ""),
          sourceOutputKey: String(r.sourceOutputKey ?? ""),
          targetNodeKey: String(r.targetNodeKey ?? ""),
          condition: r.condition ?? null,
          routeType: r.routeType != null ? String(r.routeType) : undefined,
          priority: typeof r.priority === "number" ? r.priority : undefined,
        }));

      const plan = buildPlan(client, automationId, document, currentDef, existingRoutes);

      if (plan.length === 0) {
        const validation = shapeValidation(
          await client.request<any>(`${DESIGN}/automations/${automationId}/validate`, {
            method: "POST",
            body: {},
          }),
        );
        return ok({
          updated: false,
          automationId,
          note: "The definition matches the draft's current state — nothing to apply.",
          validation,
          reviewUrl: client.automationLink(automationId),
        });
      }

      const applied: string[] = [];
      for (const call of plan) {
        try {
          await call.run();
          applied.push(call.label);
        } catch (error) {
          const remaining = plan.slice(applied.length + 1).map((c) => c.label);
          return fail(
            `Update stopped at "${call.label}": ${error instanceof Error ? error.message : error}\n\n` +
              `Applied before the failure (the draft now contains these changes):\n` +
              (applied.length ? applied.map((a) => `  - ${a}`).join("\n") : "  (none)") +
              (remaining.length
                ? `\n\nNot applied:\n` + remaining.map((r) => `  - ${r}`).join("\n")
                : "") +
              `\n\nRun flow_export(${automationId}) to see the draft's actual state before retrying.`,
          );
        }
      }

      const validation = shapeValidation(
        await client.request<any>(`${DESIGN}/automations/${automationId}/validate`, {
          method: "POST",
          body: {},
        }),
      );

      return ok({
        updated: true,
        automationId,
        appliedChanges: applied,
        ...(flight.warnings.length ? { clientWarnings: flight.warnings } : {}),
        validation,
        reviewUrl: client.automationLink(automationId),
        nextStep: validation?.isValid
          ? "The draft is valid. Give the user the reviewUrl so they can inspect and publish it. It is NOT running yet."
          : "The draft still has validation errors. Correct the definition and call flow_update_draft again with the same automationId.",
      });
    }),
  );
}

/** Stable stringify (sorted keys) so semantically-equal JSON compares equal. */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function buildPlan(
  client: ToolContext["client"],
  automationId: number,
  next: Definition,
  currentDef: Record<string, any>,
  existingRoutes: ExistingRoute[],
): PlannedCall[] {
  const base = `${DESIGN}/automations/${automationId}`;
  const plan: PlannedCall[] = [];

  // -- metadata -------------------------------------------------------------
  const currentName = String(currentDef?.name ?? "");
  const currentDescription = currentDef?.description ?? null;
  const currentProjectId = currentDef?.projectId ?? null;
  // The definition is authoritative for name and description (import behaves
  // the same way); projectId is preserved unless the definition sets one,
  // because clearing a project assignment is a Studio decision, not a repair.
  const nextProjectId = next.projectId ?? currentProjectId;
  if (
    next.name !== currentName ||
    (next.description ?? null) !== currentDescription ||
    nextProjectId !== currentProjectId
  ) {
    plan.push({
      label: `update metadata (name/description)`,
      run: () =>
        client.request(base, {
          method: "PUT",
          body: {
            name: next.name,
            description: next.description ?? null,
            projectId: nextProjectId,
          },
        }),
    });
  }

  // -- nodes: upsert new + changed ------------------------------------------
  const currentNodes = new Map<string, Record<string, unknown>>(
    ((currentDef?.nodes ?? []) as Array<Record<string, unknown>>).map((n) => [String(n.key), n]),
  );
  for (const node of next.nodes) {
    const existing = currentNodes.get(node.key);
    if (
      existing &&
      canonical(nodeProjection(existing)) === canonical(nodeProjection(node, existing))
    ) {
      continue;
    }
    plan.push({
      label: `${existing ? "update" : "add"} node "${node.key}"`,
      run: () =>
        client.request(`${base}/nodes/${encodeURIComponent(node.key)}`, {
          method: "PUT",
          body: nodeRequestBody(node, existing),
        }),
    });
  }

  // -- triggers: upsert new + changed (after nodes — startNodeKey may point
  //    at a node this same update introduces) ------------------------------
  const currentTriggers = new Map<string, Record<string, unknown>>(
    ((currentDef?.triggers ?? []) as Array<Record<string, unknown>>).map((t) => [
      String(t.key),
      t,
    ]),
  );
  for (const trigger of next.triggers) {
    const existing = currentTriggers.get(trigger.key);
    if (
      existing &&
      canonical(triggerProjection(existing)) === canonical(triggerProjection(trigger))
    ) {
      continue;
    }
    plan.push({
      label: `${existing ? "update" : "add"} trigger "${trigger.key}"`,
      run: () =>
        client.request(`${base}/triggers/${encodeURIComponent(trigger.key)}`, {
          method: "PUT",
          body: {
            key: trigger.key,
            type: trigger.type,
            name: trigger.name,
            isEnabled: trigger.isEnabled,
            configJson: JSON.stringify(trigger.config ?? {}),
            schemaJson: JSON.stringify(trigger.schema ?? {}),
            authenticationPolicyJson: JSON.stringify(trigger.authenticationPolicy ?? {}),
          },
        }),
    });
  }

  // -- routes ---------------------------------------------------------------
  // Routes have no natural key, so they match on the (source, output, target)
  // tuple. Array-walk rather than Map: two routes CAN share a tuple only in
  // invalid documents, and first-unmatched keeps the diff deterministic then.
  const unmatched = [...existingRoutes];
  const routeCreates: DefRoute[] = [];
  const routeUpdates: Array<{ route: DefRoute; routeId: number }> = [];

  for (const route of next.routes) {
    const index = unmatched.findIndex(
      (r) =>
        r.sourceNodeKey === route.sourceNodeKey &&
        r.sourceOutputKey === route.sourceOutputKey &&
        r.targetNodeKey === route.targetNodeKey,
    );
    if (index === -1) {
      routeCreates.push(route);
      continue;
    }
    const existing = unmatched.splice(index, 1)[0]!;
    const changed =
      canonical(existing.condition ?? null) !== canonical(route.condition ?? null) ||
      (existing.routeType ?? "Default") !== route.routeType ||
      (existing.priority ?? 0) !== route.priority;
    if (changed) routeUpdates.push({ route, routeId: existing.routeId });
  }

  for (const gone of unmatched) {
    plan.push({
      label: `delete route ${gone.sourceNodeKey} --${gone.sourceOutputKey}--> ${gone.targetNodeKey}`,
      run: () => client.request(`${base}/routes/${gone.routeId}`, { method: "DELETE" }),
    });
  }
  for (const { route, routeId } of routeUpdates) {
    plan.push({
      label: `update route ${route.sourceNodeKey} --${route.sourceOutputKey}--> ${route.targetNodeKey}`,
      run: () =>
        client.request(`${base}/routes/${routeId}`, {
          method: "PUT",
          body: routeRequestBody(route),
        }),
    });
  }
  for (const route of routeCreates) {
    plan.push({
      label: `add route ${route.sourceNodeKey} --${route.sourceOutputKey}--> ${route.targetNodeKey}`,
      run: () =>
        client.request(`${base}/routes`, { method: "POST", body: routeRequestBody(route) }),
    });
  }

  // -- deletes last: routes referencing a removed node are all in the route
  //    delete set above (the structural check forbids the new document from
  //    referencing a node it does not define) ------------------------------
  const nextNodeKeys = new Set(next.nodes.map((n) => n.key));
  for (const key of currentNodes.keys()) {
    if (nextNodeKeys.has(key)) continue;
    plan.push({
      label: `delete node "${key}"`,
      run: () =>
        client.request(`${base}/nodes/${encodeURIComponent(key)}`, { method: "DELETE" }),
    });
  }
  const nextTriggerKeys = new Set(next.triggers.map((t) => t.key));
  for (const key of currentTriggers.keys()) {
    if (nextTriggerKeys.has(key)) continue;
    plan.push({
      label: `delete trigger "${key}"`,
      run: () =>
        client.request(`${base}/triggers/${encodeURIComponent(key)}`, { method: "DELETE" }),
    });
  }

  return plan;
}

/**
 * The compared/serialized projection of a node. Export emits the same field
 * names the definition uses, so one projection serves both sides of the diff.
 * `base` is the node's current export, used to resolve credentialRefs: that
 * field is server-managed (import stamps {"resolved": false}, Studio stores
 * real refs), so an empty value in the incoming definition means "keep what is
 * there", never "clear it".
 */
function nodeProjection(
  node: Record<string, unknown> | DefNode,
  base?: Record<string, unknown>,
): Record<string, unknown> {
  const n = node as Record<string, unknown>;
  return {
    type: n.type,
    name: n.name,
    config: asObject(n.config),
    position: asObject(n.position),
    credentialRefs: effectiveCredentialRefs(n.credentialRefs, base?.credentialRefs),
    timeoutPolicy: asObject(n.timeoutPolicy),
    retryPolicy: asObject(n.retryPolicy),
    errorPolicy: asObject(n.errorPolicy),
    sideEffectPolicy: n.sideEffectPolicy ?? "Pure",
  };
}

function isEmptyJson(value: unknown): boolean {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

/** Definition value when explicitly set; otherwise the existing one; else []. */
function effectiveCredentialRefs(defValue: unknown, existingValue: unknown): unknown {
  if (!isEmptyJson(defValue)) return defValue;
  if (!isEmptyJson(existingValue)) return existingValue;
  return [];
}

function triggerProjection(trigger: Record<string, unknown> | DefTrigger): Record<string, unknown> {
  const t = trigger as Record<string, unknown>;
  return {
    type: t.type,
    name: t.name,
    isEnabled: t.isEnabled ?? true,
    config: asObject(t.config),
    schema: asObject(t.schema),
    authenticationPolicy: asObject(t.authenticationPolicy),
  };
}

function nodeRequestBody(node: DefNode, existing?: Record<string, unknown>): Record<string, unknown> {
  // The granular endpoints take stringified JSON fields (ConfigJson etc.),
  // unlike import which takes objects. CredentialRefs is server-managed when
  // the definition leaves it empty — echo the existing value back rather than
  // wiping it (and default to an ARRAY, "[]", not "{}").
  const credentialRefsJson = JSON.stringify(
    effectiveCredentialRefs(node.credentialRefs, existing?.credentialRefs),
  );
  return {
    key: node.key,
    nodeKey: node.key,
    type: node.type,
    name: node.name,
    configJson: JSON.stringify(node.config ?? {}),
    positionJson: JSON.stringify(node.position ?? { x: 0, y: 0 }),
    credentialRefsJson,
    timeoutPolicyJson: JSON.stringify(node.timeoutPolicy ?? {}),
    retryPolicyJson: JSON.stringify(node.retryPolicy ?? {}),
    errorPolicyJson: JSON.stringify(node.errorPolicy ?? {}),
    sideEffectPolicy: node.sideEffectPolicy ?? "Pure",
  };
}

function routeRequestBody(route: DefRoute): Record<string, unknown> {
  return {
    sourceNodeKey: route.sourceNodeKey,
    sourceOutputKey: route.sourceOutputKey,
    targetNodeKey: route.targetNodeKey,
    conditionJson: route.condition == null ? null : JSON.stringify(route.condition),
    routeType: route.routeType,
    priority: route.priority,
  };
}
